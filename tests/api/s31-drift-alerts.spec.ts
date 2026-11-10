import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { actors } from '../helpers/actors.js';
import { expectApiError, startApiFixture } from '../helpers/application.js';
import { activeCustomer, CUSTOMER, fund, nextKey, runMaturity } from '../helpers/cash.js';
import type { Api } from '../helpers/cash.js';
import { confirmRisk } from '../helpers/flows.js';
import { alerts, BACK_OFFICE, createAsset, holdDeposit, holdUnits, RM, runSnapshot, snapshots, staffTokens, submitPrice } from '../helpers/portfolio.js';

describe('S31 UC-12 drift scan', () => {
  let api: Api;
  let backOffice: string;
  let customerId: string;
  beforeEach(async () => {
    api = await startApiFixture();
    customerId = (await activeCustomer(api)).customerId;
    ({ backOffice } = await staffTokens(api));
  }, 120_000);
  afterEach(async () => { await api?.stop(); });

  /** AUM 100,000,000 against the BALANCED target 5/30/30/35: cash deviates exactly 5.00, bond 4.99, deposit 0, fund 0.01. */
  async function boundaryPortfolio() {
    await fund(api, '10000000');
    const deposit = await createAsset(api, backOffice, 'TERM_DEPOSIT');
    const bond = await createAsset(api, backOffice, 'BOND', { initialPrice: '100' });
    const unit = await createAsset(api, backOffice, 'MUTUAL_FUND', { initialPrice: '100' });
    await holdDeposit(api, deposit.assetId, { principal: '30000000', rate: '6', start: '2026-01-15', maturity: '2026-07-15' });
    await holdUnits(api, bond.assetId, '250100', '100');
    await holdUnits(api, unit.assetId, '349900', '100');
    return { unit, bond };
  }

  test('a deviation of exactly 5 alerts, 4.99 does not; the suggestion brings the class back to target', async () => {
    await boundaryPortfolio();
    const run = await runSnapshot(api, backOffice);
    expect(run.status).toBe(200);
    expect(run.body).toEqual(expect.objectContaining({ asOf: '2026-01-15', snapshots: 1, skipped: 0, failed: 0 }));
    expect(await snapshots(api)).toEqual([{ snapshot_kind: 'DAILY', date: '2026-01-15', aum: '100000000.00' }]);
    expect(await alerts(api)).toEqual([{ class: 'CASH', status: 'NEW', actual: '10.00', target: '5.00', direction: 'DECREASE', amount: '5000000.00' }]);
  });

  test('a second run the same day adds nothing', async () => {
    await boundaryPortfolio();
    await runSnapshot(api, backOffice);
    expect((await runSnapshot(api, backOffice)).body.snapshots).toBe(0);
    expect(await snapshots(api)).toHaveLength(1);
    expect(await alerts(api)).toHaveLength(1);
  });

  test('a price change scans holders at once, with an EVENT snapshot, and the 17:00 DAILY can still be written', async () => {
    const { unit } = await boundaryPortfolio();
    const changed = await submitPrice(api, backOffice, unit.assetId, '110');
    expect(changed.body.scan).toEqual(expect.objectContaining({ scanned: 1, failed: 0 }));
    expect((await snapshots(api)).map(row => row.snapshot_kind)).toEqual(['EVENT']);
    expect((await alerts(api)).length).toBeGreaterThan(0);
    await runSnapshot(api, backOffice);
    expect((await snapshots(api)).map(row => row.snapshot_kind).sort()).toEqual(['DAILY', 'EVENT']);
  });

  test('the alert lifecycle: same numbers keep it, new numbers replace it, ACTIONED is left alone', async () => {
    const { unit } = await boundaryPortfolio();
    await runSnapshot(api, backOffice);
    api.tick();
    await submitPrice(api, backOffice, unit.assetId, '100');
    expect(await alerts(api)).toHaveLength(1);
    await fund(api, '10000000');
    api.tick();
    await submitPrice(api, backOffice, unit.assetId, '100');
    const replaced = await alerts(api);
    expect(replaced.filter(row => row.class === 'CASH').map(row => row.status)).toEqual(['RESOLVED', 'NEW']);
    expect(replaced.find(row => row.class === 'CASH' && row.status === 'NEW')!.actual).toBe('18.18');
    await api.dataSource.query("UPDATE wms.drift_alerts SET status='ACTIONED',actioned_at=now() WHERE allocation_class='CASH' AND status='NEW'");
    api.tick();
    await fund(api, '1000000');
    await submitPrice(api, backOffice, unit.assetId, '100');
    expect((await alerts(api)).filter(row => row.class === 'CASH').map(row => row.status)).toEqual(['RESOLVED', 'ACTIONED']);
  });

  test('the same weights on a larger AUM refresh the suggested amount', async () => {
    await fund(api, '10000000');
    await runSnapshot(api, backOffice, '2026-01-14');
    expect((await alerts(api)).find(row => row.class === 'TERM_DEPOSIT')!.amount).toBe('3000000.00');
    await fund(api, '10000000');
    api.tick();
    await runSnapshot(api, backOffice);
    const deposit = (await alerts(api)).filter(row => row.class === 'TERM_DEPOSIT');
    expect(deposit.map(row => [row.status, row.amount])).toEqual([['RESOLVED', '3000000.00'], ['NEW', '6000000.00']]);
  });

  test('back in range resolves the open alert and creates nothing new', async () => {
    const { unit } = await boundaryPortfolio();
    await runSnapshot(api, backOffice);
    // AUM 98,000,000: cash 8.16, deposit 30.61, bond 25.52, fund 35.70: all within 5 points.
    await api.dataSource.query('UPDATE wms.investment_accounts SET balance=8000000 WHERE customer_id=$1', [customerId]);
    api.tick();
    await submitPrice(api, backOffice, unit.assetId, '100');
    expect((await alerts(api)).map(row => [row.class, row.status])).toEqual([['CASH', 'RESOLVED']]);
  });

  test('settling a deposit scans the customer', async () => {
    const deposit = await createAsset(api, backOffice, 'TERM_DEPOSIT');
    await holdDeposit(api, deposit.assetId, { principal: '100000000', rate: '6', start: '2025-01-15', maturity: '2026-01-15' });
    await runMaturity(api, backOffice);
    // The whole AUM became cash: every class deviates.
    expect((await snapshots(api)).map(row => row.snapshot_kind)).toEqual(['EVENT']);
    expect((await alerts(api)).map(row => row.class).sort()).toEqual(['BOND', 'CASH', 'MUTUAL_FUND', 'TERM_DEPOSIT']);
  });

  test('confirming a new risk profile rescans against the new target', async () => {
    await fund(api, '10000000');
    await runSnapshot(api, backOffice);
    expect((await alerts(api)).find(row => row.class === 'CASH')!.target).toBe('5.00');
    api.tick();
    await confirmRisk(api, CUSTOMER, 0, 1, 'rescan');
    const cash = (await alerts(api)).filter(row => row.class === 'CASH');
    expect(cash.map(row => [row.status, row.target])).toEqual([['RESOLVED', '5.00'], ['NEW', '10.00']]);
    expect((await snapshots(api)).map(row => row.snapshot_kind)).toEqual(['DAILY', 'EVENT']);
  });

  test('a risk confirmation with nothing to alert writes no snapshot: AUM stays unavailable for the RM', async () => {
    await confirmRisk(api, CUSTOMER, 0, 1, 'noop');
    expect(await snapshots(api)).toEqual([]);
    const detail = await api.request(`/customers/${customerId}`, { token: await api.tokenFor(RM) });
    expect(detail.body.aum).toMatchObject({ value: null, dataStatus: 'UNAVAILABLE' });
  });

  test('skips: AUM of zero has no alerts, an INCOMPLETE portfolio has no snapshot, an expired profile has a snapshot but no alerts', async () => {
    expect((await runSnapshot(api, backOffice, '2026-01-14')).body).toEqual(expect.objectContaining({ snapshots: 1 }));
    expect(await alerts(api)).toEqual([]);
    const unpriced = await createAsset(api, backOffice, 'MUTUAL_FUND', { initialPrice: undefined });
    await holdUnits(api, unpriced.assetId, '1', '1');
    expect((await runSnapshot(api, backOffice)).body).toEqual(expect.objectContaining({ snapshots: 0, skipped: 1 }));
    await api.dataSource.query('DELETE FROM wms.portfolio_holdings');
    await fund(api, '10000000');
    api.state.now = new Date('2027-02-15T05:00:00.000Z');
    await runSnapshot(api, await api.tokenFor(BACK_OFFICE));
    expect(await alerts(api)).toEqual([]);
    expect((await snapshots(api)).at(-1)).toEqual(expect.objectContaining({ date: '2027-02-15', aum: '10000000.00' }));
  });

  test('a scan that fails does not undo the business operation and is retried by the next run', async () => {
    const { unit } = await boundaryPortfolio();
    await api.dataSource.query(`CREATE FUNCTION wms.test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$;
      CREATE TRIGGER test_fail BEFORE INSERT ON wms.portfolio_snapshots FOR EACH ROW EXECUTE FUNCTION wms.test_fail()`);
    const changed = await submitPrice(api, backOffice, unit.assetId, '101');
    expect(changed.status).toBe(201);
    expect(changed.body.scan).toEqual(expect.objectContaining({ scanned: 1, failed: 1 }));
    expect((await runSnapshot(api, backOffice)).body).toEqual(expect.objectContaining({ snapshots: 0, failed: 1 }));
    await api.dataSource.query('DROP TRIGGER test_fail ON wms.portfolio_snapshots');
    expect((await runSnapshot(api, backOffice)).body).toEqual(expect.objectContaining({ snapshots: 1, failed: 0 }));
  });

  /** D-R10-5: the team DDL has no staff notification table, so "RM nhận thông báo" is an outbox event written with the alert. */
  const created = () => api.dataSource.query("SELECT aggregate_type,aggregate_id::text,payload FROM wms.outbox_events WHERE event_type='DriftAlertCreated' ORDER BY created_at") as Promise<Array<{
    aggregate_type: string; aggregate_id: string; payload: { alertId: string; customerId: string; rmId: string; allocationClass: string; deviation: string } }>>;

  test('a new alert writes DriftAlertCreated for the RM; a refresh with the same numbers writes none; a replaced alert writes one more', async () => {
    const { unit } = await boundaryPortfolio();
    await runSnapshot(api, backOffice);
    const [alert] = await api.dataSource.query("SELECT alert_id FROM wms.drift_alerts WHERE status='NEW'");
    expect(await created()).toEqual([{ aggregate_type: 'DRIFT_ALERT', aggregate_id: alert.alert_id,
      payload: { alertId: alert.alert_id, customerId, rmId: actors.rm.rmId, allocationClass: 'CASH', deviation: '5.00' } }]);
    await runSnapshot(api, backOffice);
    api.tick();
    await submitPrice(api, backOffice, unit.assetId, '100');
    expect(await created()).toHaveLength(1);
    await fund(api, '10000000');
    api.tick();
    await submitPrice(api, backOffice, unit.assetId, '100');
    const cash = (await created()).filter(event => event.payload.allocationClass === 'CASH');
    expect(cash.map(event => event.payload.deviation)).toEqual(['5.00', '13.18']);
    expect(cash[1]!.aggregate_id).not.toBe(alert.alert_id);
  });

  test('the event is written in the alert transaction: when it fails, no alert and no snapshot remain, and the next run catches up', async () => {
    await boundaryPortfolio();
    await api.dataSource.query(`CREATE FUNCTION wms.test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$;
      CREATE TRIGGER test_fail BEFORE INSERT ON wms.outbox_events FOR EACH ROW WHEN (NEW.event_type='DriftAlertCreated') EXECUTE FUNCTION wms.test_fail()`);
    expect((await runSnapshot(api, backOffice)).body).toEqual(expect.objectContaining({ snapshots: 0, failed: 1 }));
    expect(await alerts(api)).toEqual([]);
    expect(await snapshots(api)).toEqual([]);
    await api.dataSource.query('DROP TRIGGER test_fail ON wms.outbox_events');
    expect((await runSnapshot(api, backOffice)).body).toEqual(expect.objectContaining({ snapshots: 1, failed: 0 }));
    expect(await created()).toHaveLength(1);
  });

  test('RM endpoints: open alerts of own customers with the suggestion; read marks READ', async () => {
    await boundaryPortfolio();
    await runSnapshot(api, backOffice);
    const rm = await api.tokenFor(RM);
    const list = await api.request('/rm/drift-alerts', { token: rm });
    expect(list.body.items).toEqual([expect.objectContaining({ customerId, fullName: expect.any(String), allocationClass: 'CASH', actualWeight: '10.00', targetWeight: '5.00', deviation: '5.00',
      status: 'NEW', direction: 'DECREASE', adjustAmount: '5000000.00', snapshotDate: '2026-01-15', aum: '100000000.00' })]);
    const alertId = list.body.items[0].alertId;
    const read = await api.request(`/rm/drift-alerts/${alertId}/read`, { method: 'POST', token: rm, key: nextKey('read') });
    expect(read.status).toBe(200);
    expect(read.body.status).toBe('READ');
    expect((await api.request(`/customers/${customerId}/drift-alerts`, { token: await api.tokenFor(actors.leader.actorId) })).body.items).toHaveLength(1);
    expectApiError(await api.request('/rm/drift-alerts', { token: backOffice }), 403, 'FORBIDDEN');
    expectApiError(await api.request('/rm/drift-alerts/00000000-0000-4000-8000-000000000000/read', { method: 'POST', token: rm, key: nextKey('read') }), 404, 'ALERT_NOT_FOUND');
  });

  test('the schedule catches up after 17:00 Vietnam time only, one DAILY per customer', async () => {
    await fund(api, '10000000');
    const compiled = new URL('../../apps/api/dist/modules/portfolio-valuation/portfolio-jobs.js', import.meta.url).href;
    const jobs = api.app.get((await import(/* @vite-ignore */ compiled)).PortfolioJobs);
    await jobs.tick(); // 12:00 Vietnam
    expect(await snapshots(api)).toEqual([]);
    api.state.now = new Date('2026-01-15T10:30:00.000Z'); // 17:30 Vietnam
    await jobs.tick();
    await jobs.tick();
    expect((await snapshots(api)).map(row => row.snapshot_kind)).toEqual(['DAILY']);
  });

  test('migration 009: daily stays unique per customer; event is not limited; down restores the team unique', async () => {
    const insert = (kind: string) => api.dataSource.query(`INSERT INTO wms.portfolio_snapshots(customer_id,account_id,snapshot_date,cash_balance,aum,snapshot_kind)
      SELECT customer_id,account_id,'2026-01-10',1,1,$2::varchar FROM wms.investment_accounts WHERE customer_id=$1`, [customerId, kind]);
    await insert('DAILY');
    await insert('EVENT');
    await insert('EVENT');
    await expect(insert('DAILY')).rejects.toThrow();
    await expect(insert('OTHER')).rejects.toThrow();
    await api.dataSource.undoLastMigration({ transaction: 'all' });
    expect(await api.dataSource.query("SELECT 1 FROM information_schema.columns WHERE table_schema='wms' AND table_name='portfolio_snapshots' AND column_name='snapshot_kind'")).toEqual([]);
    expect((await api.dataSource.query('SELECT count(*)::int AS n FROM wms.portfolio_snapshots'))[0].n).toBe(1);
    await expect(api.dataSource.query(`INSERT INTO wms.portfolio_snapshots(customer_id,account_id,snapshot_date,cash_balance,aum)
      SELECT customer_id,account_id,'2026-01-10',1,1 FROM wms.investment_accounts WHERE customer_id=$1`, [customerId])).rejects.toThrow();
  });
});

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { expectApiError, startApiFixture } from '../helpers/application.js';
import { account, activeCustomer, audit, CUSTOMER, expectBalanceMatchesLedger, fund, insertBackOffice, ledger, nextKey, runMaturity } from '../helpers/cash.js';
import type { Api } from '../helpers/cash.js';

describe('S26 UC-08 term deposit settlement', () => {
  let api: Api;
  let backOffice: string;
  let serial = 0;
  beforeEach(async () => { api = await startApiFixture(); await activeCustomer(api); backOffice = await insertBackOffice(api); });
  afterEach(async () => { await api?.stop(); });

  async function asset(assetClass: 'TERM_DEPOSIT' | 'BOND') {
    const [row] = await api.dataSource.query(`INSERT INTO wms.assets(asset_code,asset_name,asset_class,risk_level) VALUES($1,'Synthetic',$2,1) RETURNING asset_id`, [`S${++serial}`, assetClass]);
    return row.asset_id as string;
  }

  /** A holding funded outside P2: UC-16 owns opening, so its ledger entries are not part of these tests. */
  async function holding(input: { principal?: string; rate?: string | null; start?: string; maturity?: string; assetClass?: 'TERM_DEPOSIT' | 'BOND'; accountId?: string }) {
    const accountId = input.accountId ?? (await account(api)).account_id;
    const [row] = await api.dataSource.query(`INSERT INTO wms.portfolio_holdings(account_id,asset_id,principal,locked_rate,start_date,maturity_date)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING holding_id`, [accountId, await asset(input.assetClass ?? 'TERM_DEPOSIT'), input.principal ?? '100000000',
      input.rate === undefined ? '5.8' : input.rate, input.start ?? '2025-01-15', input.maturity ?? '2026-01-15']);
    return row.holding_id as string;
  }

  const settlement = async (holdingId: string) => {
    const [row] = await api.dataSource.query(`SELECT m.txn_id,m.principal_amount::text,m.interest_amount::text,m.days_held,m.settlement_key,c.status::text,c.amount::text,c.ref_no
      FROM wms.maturity_settlements m JOIN wms.cash_transactions c USING(txn_id) WHERE m.holding_id=$1`, [holdingId]);
    return row;
  };
  const holdingStatus = async (id: string) => (await api.dataSource.query('SELECT status::text FROM wms.portfolio_holdings WHERE holding_id=$1', [id]))[0].status;

  test('settles principal and floored interest with three balanced entries and closes the holding', async () => {
    // 100,000,000 x 5.8% x 365 / 365 = 5,800,000 exactly.
    const id = await holding({});
    const run = await runMaturity(api, backOffice);
    expect(run.status).toBe(200);
    expect(run.body).toEqual(expect.objectContaining({ asOf: '2026-01-15', settled: 1, skipped: 0, failed: [] }));
    const row = await settlement(id);
    expect(row).toEqual(expect.objectContaining({ principal_amount: '100000000.00', interest_amount: '5800000.00', days_held: 365, status: 'SUCCESS', amount: '105800000.00', settlement_key: `SETTLE-${id}` }));
    expect(row.ref_no).toMatch(/^MAT-20260115-\d{4}$/);
    const entries = await ledger(api, row.txn_id);
    expect(entries.map(entry => [entry.account_type, entry.side, entry.amount])).toEqual(expect.arrayContaining([
      ['TERM_DEPOSIT', 'DEBIT', '100000000.00'], ['INTEREST_PAYABLE', 'DEBIT', '5800000.00'], ['CUSTOMER_INVESTMENT', 'CREDIT', '105800000.00']]));
    expect(entries).toHaveLength(3);
    expect((await account(api)).balance).toBe('105800000.00');
    expect(await holdingStatus(id)).toBe('CLOSED');
    await expectBalanceMatchesLedger(api);
    expect((await audit(api, 'MATURITY_SETTLED')).at(-1)).toEqual(expect.objectContaining({ actor_id: 'maturity-job', actor_role: 'SYSTEM_JOB', reference_id: row.txn_id }));
    expect(await api.dataSource.query("SELECT 1 FROM wms.outbox_events WHERE event_type='MaturitySettled' AND aggregate_id=$1", [row.txn_id])).toHaveLength(1);
  });

  test('interest rounds down to the dong; a late run adds no days', async () => {
    // 150,000,000 x 5.2% x 183 / 365 = 3,910,684.93..., floored to 3,910,684; maturity one week before the run.
    const id = await holding({ principal: '150000000', rate: '5.2', start: '2025-07-06', maturity: '2026-01-05' });
    await runMaturity(api, backOffice);
    expect(await settlement(id)).toEqual(expect.objectContaining({ interest_amount: '3910684.00', days_held: 183 }));
  });

  test('interest that floors to zero writes two entries', async () => {
    const id = await holding({ principal: '1000', rate: '0.01', start: '2026-01-14', maturity: '2026-01-15' });
    await runMaturity(api, backOffice);
    const row = await settlement(id);
    expect(row.interest_amount).toBe('0.00');
    expect((await ledger(api, row.txn_id)).map(entry => entry.account_type).sort()).toEqual(['CUSTOMER_INVESTMENT', 'TERM_DEPOSIT']);
  });

  test('a rerun settles nothing twice; a holding not yet due or a bond is left alone', async () => {
    const due = await holding({});
    const future = await holding({ maturity: '2026-01-16' });
    const bond = await holding({ assetClass: 'BOND' });
    expect((await runMaturity(api, backOffice)).body.settled).toBe(1);
    const balance = (await account(api)).balance;
    expect((await runMaturity(api, backOffice)).body.settled).toBe(0);
    expect((await account(api)).balance).toBe(balance);
    expect(await settlement(due)).toBeDefined();
    expect(await holdingStatus(future)).toBe('OPEN');
    expect(await holdingStatus(bond)).toBe('OPEN');
  });

  test('an open holding that already has a settlement is skipped', async () => {
    const id = await holding({});
    await runMaturity(api, backOffice);
    await api.dataSource.query("UPDATE wms.portfolio_holdings SET status='OPEN' WHERE holding_id=$1", [id]);
    const balance = (await account(api)).balance;
    const run = await runMaturity(api, backOffice);
    expect(run.body).toEqual(expect.objectContaining({ settled: 0, skipped: 1 }));
    expect((await account(api)).balance).toBe(balance);
  });

  test('one failing holding does not stop the run; it is reported and retried by the next run', async () => {
    const broken = await holding({ rate: null });
    const good = await holding({});
    const run = await runMaturity(api, backOffice);
    expect(run.body.settled).toBe(1);
    expect(run.body.failed).toEqual([{ holdingId: broken, code: 'SETTLEMENT_FAILED' }]);
    expect(await settlement(good)).toBeDefined();
    expect(await settlement(broken)).toBeUndefined();
    await api.dataSource.query('UPDATE wms.portfolio_holdings SET locked_rate=5 WHERE holding_id=$1', [broken]);
    expect((await runMaturity(api, backOffice)).body).toEqual(expect.objectContaining({ settled: 1, failed: [] }));
  });

  test('a FROZEN account is still settled', async () => {
    const id = await holding({});
    await api.dataSource.query("UPDATE wms.investment_accounts SET status='FROZEN' WHERE cif_id=$1", [CUSTOMER]);
    await runMaturity(api, backOffice);
    expect((await settlement(id)).status).toBe('SUCCESS');
    expect((await account(api)).balance).toBe('105800000.00');
  });

  test('asOf lets the demo run a future date; bad dates are refused', async () => {
    const id = await holding({ maturity: '2026-02-01' });
    expect((await runMaturity(api, backOffice)).body.settled).toBe(0);
    expect((await runMaturity(api, backOffice, '2026-02-01')).body).toEqual(expect.objectContaining({ asOf: '2026-02-01', settled: 1 }));
    expect(await settlement(id)).toBeDefined();
    expectApiError(await runMaturity(api, backOffice, '2026-13-40'), 400, 'VALIDATION_ERROR');
  });

  test('the run report is stored and readable by back-office only', async () => {
    const broken = await holding({ rate: null });
    await holding({});
    await runMaturity(api, backOffice);
    const report = await api.request('/back-office/maturity-runs', { token: backOffice });
    expect(report.status).toBe(200);
    expect(report.body.items[0]).toEqual(expect.objectContaining({ asOf: '2026-01-15', settled: 1, skipped: 0, failed: [{ holdingId: broken, code: 'SETTLEMENT_FAILED' }], ranAt: expect.any(String) }));
    expectApiError(await api.request('/back-office/maturity-runs', { token: await api.tokenFor() }), 403, 'FORBIDDEN');
  });

  describe('scheduler', () => {
    const jobs = async () => {
      const compiled = new URL('../../apps/api/dist/modules/accounts-ledger/cash-jobs.js', import.meta.url).href;
      const { CashJobs } = await import(/* @vite-ignore */ compiled);
      return api.app.get(CashJobs, { strict: false });
    };

    test('runs maturity once a Vietnam day, only after 00:30, catching up when started late', async () => {
      const id = await holding({ maturity: '2026-01-16' });
      const scheduler = await jobs();
      // 2026-01-15T17:29Z is 00:29 on the 16th in Vietnam.
      api.state.now = new Date('2026-01-15T17:29:00.000Z');
      await scheduler.tick();
      expect(await settlement(id)).toBeUndefined();
      api.state.now = new Date('2026-01-15T23:00:00.000Z');
      await scheduler.tick();
      expect(await settlement(id)).toBeDefined();
      await scheduler.tick();
      expect((await audit(api, 'MATURITY_RUN_COMPLETED'))).toHaveLength(1);
    });

    test('runs reconciliation every five minutes, leaving just-timed-out orders alone so a slow Core call cannot be failed while still running', async () => {
      await fund(api, '1000000');
      api.state.corePosting = async () => { throw new Error('synthetic'); };
      const created = await api.request('/me/deposits', { method: 'POST', token: await api.tokenFor(CUSTOMER), key: nextKey(), body: { sourceCasaNo: `account-${CUSTOMER}`, amount: '1000000' } });
      const otp = api.deliveries.find(item => item.challengeId === created.body.challengeId)!;
      await api.request(`/me/deposits/${created.body.txnId}/confirm`, { method: 'POST', token: await api.tokenFor(CUSTOMER), key: nextKey(), body: { challengeId: otp.challengeId, code: otp.code } });
      api.state.corePosting = undefined;
      api.state.coreStatus = async () => { throw new Error('synthetic'); };
      const scheduler = await jobs();
      const asked = () => api.state.coreCalls.filter(call => call.kind === 'STATUS').length;
      await scheduler.tick();
      expect(asked()).toBe(0);
      api.tick(5 * 60_000);
      await scheduler.tick();
      expect(asked()).toBe(1);
      api.tick(4 * 60_000);
      await scheduler.tick();
      expect(asked()).toBe(1);
      api.tick(60_000);
      await scheduler.tick();
      expect(asked()).toBe(2);
    });

    test('a second instance holding the job lock makes this tick a no-op; the demo trigger reports 409', async () => {
      const id = await holding({});
      const scheduler = await jobs();
      const other = api.dataSource.createQueryRunner();
      await other.connect();
      try {
        await other.query("SELECT pg_advisory_lock(hashtextextended('cash-jobs',0))");
        await scheduler.tick();
        expect(await settlement(id)).toBeUndefined();
        expectApiError(await runMaturity(api, backOffice), 409, 'JOB_RUNNING');
      } finally {
        await other.query("SELECT pg_advisory_unlock(hashtextextended('cash-jobs',0))");
        await other.release();
      }
    });
  });
});

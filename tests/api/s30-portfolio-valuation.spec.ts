import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { actors, insertStaff, staff, viaDataSource } from '../helpers/actors.js';
import { expectApiError, startApiFixture } from '../helpers/application.js';
import { activeCustomer, audit, CUSTOMER, fund, insertBackOffice } from '../helpers/cash.js';
import type { Api } from '../helpers/cash.js';
import { createAsset, holdDeposit, holdUnits, RM, runSnapshot } from '../helpers/portfolio.js';

describe('S30 UC-11 portfolio valuation', () => {
  let api: Api;
  let backOffice: string;
  let customerId: string;
  beforeAll(async () => {
    api = await startApiFixture();
    customerId = (await activeCustomer(api)).customerId;
    backOffice = await insertBackOffice(api);
  }, 120_000);
  afterAll(async () => { await api?.stop(); });

  const mine = async () => api.request('/me/portfolio', { token: await api.tokenFor(CUSTOMER) });

  test('an empty account is worth zero and has no weights', async () => {
    const response = await mine();
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({ asOf: '2026-01-15', dataStatus: 'COMPLETE', aum: '0.00', cash: '0.00', items: [] }));
    expect(response.body.allocation.every((row: { actualWeight: unknown }) => row.actualWeight === null)).toBe(true);
  });

  test('values each class by hand-computed numbers, with cost, profit and weights', async () => {
    await fund(api, '100000000');
    const deposit = await createAsset(api, backOffice, 'TERM_DEPOSIT');
    const bond = await createAsset(api, backOffice, 'BOND', { initialPrice: '110000' });
    const fundAsset = await createAsset(api, backOffice, 'MUTUAL_FUND', { initialPrice: '21000' });
    // 100,000,000 x 6% x 90 / 365 = 1,479,452.05..., floored.
    await holdDeposit(api, deposit.assetId, { principal: '100000000', rate: '6', start: '2025-10-17', maturity: '2026-10-17' });
    await holdUnits(api, bond.assetId, '1000', '100000');
    await holdUnits(api, fundAsset.assetId, '5000', '20000');
    const { body } = await mine();
    expect(body).toEqual(expect.objectContaining({ dataStatus: 'COMPLETE', cash: '100000000.00', depositValue: '101479452.00', bondValue: '110000000.00', fundValue: '105000000.00',
      aum: '416479452.00', totalCost: '300000000.00', unrealizedPnl: '16479452.00' }));
    const item = (code: string) => body.items.find((row: { assetCode: string }) => row.assetCode === code);
    expect(item(deposit.assetCode)).toEqual(expect.objectContaining({ assetClass: 'TERM_DEPOSIT', principal: '100000000.00', accruedInterest: '1479452.00', cost: '100000000.00', value: '101479452.00',
      unrealizedPnl: '1479452.00', maturityDate: '2026-10-17', unitPrice: null, priceStale: false }));
    expect(item(bond.assetCode)).toEqual(expect.objectContaining({ unitPrice: '110000.0000', priceDate: '2026-01-15', cost: '100000000.00', value: '110000000.00', unrealizedPnl: '10000000.00' }));
    expect(body.allocation).toEqual([
      expect.objectContaining({ allocationClass: 'CASH', value: '100000000.00', actualWeight: '24.01', targetWeight: '5.00', deviation: '19.01', drifted: true, direction: 'DECREASE', suggestedAmount: '79176027.40' }),
      expect.objectContaining({ allocationClass: 'TERM_DEPOSIT', actualWeight: '24.37', targetWeight: '30.00', drifted: true, direction: 'INCREASE' }),
      expect.objectContaining({ allocationClass: 'BOND', actualWeight: '26.41', targetWeight: '30.00', deviation: '3.59', drifted: false, direction: null, suggestedAmount: null }),
      expect.objectContaining({ allocationClass: 'MUTUAL_FUND', actualWeight: '25.21', targetWeight: '35.00', drifted: true, direction: 'INCREASE' })]);
  });

  test('interest stops at maturity even if the deposit was not settled yet', async () => {
    const deposit = await createAsset(api, backOffice, 'TERM_DEPOSIT');
    await holdDeposit(api, deposit.assetId, { principal: '36500000', rate: '10', start: '2026-01-01', maturity: '2026-01-11' });
    const row = (await mine()).body.items.find((item: { assetCode: string }) => item.assetCode === deposit.assetCode);
    expect(row.accruedInterest).toBe('100000.00'); // 10 days, not 14
  });

  test('a price older than three working days is labelled; a missing price makes the portfolio INCOMPLETE and not counted', async () => {
    const before = (await mine()).body.aum;
    const old = await createAsset(api, backOffice, 'MUTUAL_FUND', { initialPrice: undefined });
    await holdUnits(api, old.assetId, '1', '100');
    const row = (body: { items: Array<{ assetCode: string }> }) => body.items.find(item => item.assetCode === old.assetCode);
    let { body } = await mine();
    expect(body.dataStatus).toBe('INCOMPLETE');
    expect(body.aum).toBe(before);
    expect(row(body)).toEqual(expect.objectContaining({ value: null, unrealizedPnl: null, unitPrice: null }));
    const creator = (await api.dataSource.query("SELECT staff_id FROM wms.staff_users WHERE employee_code='NV0190'"))[0].staff_id;
    const priced = (date: string) => api.dataSource.query("INSERT INTO wms.asset_pricing(asset_id,price_type,value,effective_date,status,created_by) VALUES($1,'NAV',100,$2,'APPLIED',$3)", [old.assetId, date, creator]);
    // Thursday 2026-01-15: Monday the 12th is three working days back (fresh); Friday the 9th is four.
    await priced('2026-01-09');
    ({ body } = await mine());
    expect(body.dataStatus).toBe('COMPLETE');
    expect(row(body)).toEqual(expect.objectContaining({ priceStale: true }));
    await priced('2026-01-12');
    ({ body } = await mine());
    expect(row(body)).toEqual(expect.objectContaining({ priceStale: false }));
  });

  test('history lists daily snapshots only, then a live point for today', async () => {
    const token = await api.tokenFor(CUSTOMER);
    await api.dataSource.query(`INSERT INTO wms.portfolio_snapshots(customer_id,account_id,snapshot_date,cash_balance,aum,snapshot_kind)
      SELECT customer_id,account_id,t.d::date,5,5,t.k FROM wms.investment_accounts,(VALUES('2026-01-13','DAILY'),('2026-01-14','EVENT')) AS t(d,k) WHERE customer_id=$1`, [customerId]);
    const { body } = await api.request('/me/portfolio/aum-history', { token });
    expect(body.points.slice(0, 1)).toEqual([{ date: '2026-01-13', aum: '5.00', live: false }]);
    expect(body.points.at(-1)).toEqual(expect.objectContaining({ date: '2026-01-15', live: true }));
    expect(body.points).toHaveLength(2);
    expectApiError(await api.request('/me/portfolio/aum-history?days=0', { token }), 400, 'VALIDATION_ERROR');
  });

  test('scope: RM and leader of the customer see it with an audit row; others are 403 and audited DENIED', async () => {
    const rm = await api.request(`/customers/${customerId}/portfolio`, { token: await api.tokenFor(RM) });
    expect(rm.status).toBe(200);
    expect(rm.body.customerId).toBe(customerId);
    expect((await api.request(`/customers/${customerId}/portfolio`, { token: await api.tokenFor(actors.leader.actorId) })).status).toBe(200);
    expect((await audit(api, 'PORTFOLIO_VIEW')).at(-1)).toEqual(expect.objectContaining({ outcome: 'SUCCESS', reference_id: customerId }));
    await insertStaff(viaDataSource(api.dataSource), staff.foreign);
    expectApiError(await api.request(`/customers/${customerId}/portfolio`, { token: await api.tokenFor(staff.foreign.actorId) }), 403, 'FORBIDDEN');
    expect((await audit(api, 'PORTFOLIO_VIEW')).at(-1)).toEqual(expect.objectContaining({ outcome: 'DENIED', actor_id: staff.foreign.actorId }));
    expectApiError(await api.request(`/customers/${customerId}/portfolio`, { token: backOffice }), 403, 'FORBIDDEN');
    expectApiError(await api.request('/me/portfolio', { token: backOffice }), 403, 'FORBIDDEN');
  });

  test('viewing changes no data, and only back-office runs the job', async () => {
    const count = async () => (await api.dataSource.query('SELECT (SELECT count(*) FROM wms.portfolio_snapshots)+(SELECT count(*) FROM wms.drift_alerts) AS n'))[0].n;
    const before = await count();
    await mine();
    expect(await count()).toBe(before);
    expect((await runSnapshot(api, await api.tokenFor(CUSTOMER))).status).toBe(403);
  });
});

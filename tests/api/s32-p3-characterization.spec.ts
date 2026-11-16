import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { startApiFixture } from '../helpers/application.js';
import { activeCustomer, CUSTOMER, nextKey } from '../helpers/cash.js';
import type { Api } from '../helpers/cash.js';
import { createAsset, holdDeposit, holdUnits, staffTokens, submitPrice } from '../helpers/portfolio.js';

/**
 * R10 characterization tests: the behaviour below already exists and had no test. Each test passes on first run and pins a decision
 * (the reason is in the test name or the comment), so a later change shows up as a red test and not as a silent drift.
 */
describe('S32 P3 characterization: valuation', () => {
  let api: Api;
  let backOffice: string;
  beforeEach(async () => { api = await startApiFixture(); await activeCustomer(api); ({ backOffice } = await staffTokens(api)); }, 120_000);
  afterEach(async () => { await api?.stop(); });
  const mine = async () => (await api.request('/me/portfolio', { token: await api.tokenFor(CUSTOMER) })).body;

  // Reason: BR-17 says profit or loss; only gains were tested, and money maths on a negative bigint is an easy place to break the sign or the decimal point.
  test('unrealized PnL is negative when the price is below the cost, with the sign and two decimals intact', async () => {
    const fund = await createAsset(api, backOffice, 'MUTUAL_FUND', { initialPrice: '20000' });
    await holdUnits(api, fund.assetId, '100', '25000');
    const body = await mine();
    expect(body.items.find((row: { assetCode: string }) => row.assetCode === fund.assetCode))
      .toEqual(expect.objectContaining({ cost: '2500000.00', value: '2000000.00', unrealizedPnl: '-500000.00' }));
    expect(body).toEqual(expect.objectContaining({ totalCost: '2500000.00', fundValue: '2000000.00', aum: '2000000.00', unrealizedPnl: '-500000.00' }));
  });

  // Reason: ported from the prototype's valuation spec (deposit + fund + bond), in decimal strings: a gain and a loss net in the total.
  test('a gain, a loss and accrued interest net into one total', async () => {
    const deposit = await createAsset(api, backOffice, 'TERM_DEPOSIT');
    const fund = await createAsset(api, backOffice, 'MUTUAL_FUND', { initialPrice: '12000' });
    const bond = await createAsset(api, backOffice, 'BOND', { initialPrice: '960000' });
    // 30 days from 2025-12-16 to 2026-01-15: floor(10,000,000 x 6 x 30 / 36500) = 49,315.
    await holdDeposit(api, deposit.assetId, { principal: '10000000', rate: '6', start: '2025-12-16', maturity: '2026-12-16' });
    await holdUnits(api, fund.assetId, '1000', '10000');
    await holdUnits(api, bond.assetId, '50', '1000000');
    const body = await mine();
    expect(body).toEqual(expect.objectContaining({ depositValue: '10049315.00', fundValue: '12000000.00', bondValue: '48000000.00', aum: '70049315.00',
      totalCost: '70000000.00', unrealizedPnl: '49315.00' }));
    const pnl = (code: string) => body.items.find((row: { assetCode: string }) => row.assetCode === code).unrealizedPnl;
    expect([pnl(deposit.assetCode), pnl(fund.assetCode), pnl(bond.assetCode)]).toEqual(['49315.00', '2000000.00', '-2000000.00']);
  });
});

describe('S32 P3 characterization: prices and products', () => {
  let api: Api;
  let backOffice: string;
  beforeAll(async () => { api = await startApiFixture(); await activeCustomer(api); ({ backOffice } = await staffTokens(api)); }, 120_000);
  afterAll(async () => { await api?.stop(); });
  const latest = async (assetId: string) => (await api.dataSource.query('SELECT value::text FROM wms.v_asset_latest_price WHERE asset_id=$1', [assetId]))[0]?.value;

  // Reason: there is nothing to compare with, so no change percentage and no approval, however large the first value is (the prototype returned 0 here; the team trigger leaves NULL).
  test('the first price of an asset has no previous value and no change percent, and applies at once', async () => {
    const { assetId } = await createAsset(api, backOffice, 'MUTUAL_FUND', { initialPrice: undefined });
    const response = await submitPrice(api, backOffice, assetId, '99999999');
    expect(response.status).toBe(201);
    expect(response.body).toEqual(expect.objectContaining({ previousValue: null, changePct: null, status: 'APPLIED', value: '99999999.0000' }));
    expect(await latest(assetId)).toBe('99999999.0000');
  });

  // Reason: a discontinued product keeps its holders (spec UC-09), so its price must still move their value. Pinned: price entry does not check the product status.
  test('a price for a DISCONTINUED product is accepted and still revalues the holders', async () => {
    const { assetId, assetCode } = await createAsset(api, backOffice, 'MUTUAL_FUND', { initialPrice: '20000' });
    await holdUnits(api, assetId, '10', '20000');
    const changed = await api.request(`/back-office/assets/${assetId}/status`, { method: 'PATCH', token: backOffice, key: nextKey('status'), body: { status: 'DISCONTINUED' } });
    expect(changed.body.status).toBe('DISCONTINUED');
    const response = await submitPrice(api, backOffice, assetId, '21000');
    expect(response.status).toBe(201);
    expect(response.body).toEqual(expect.objectContaining({ status: 'APPLIED', value: '21000.0000', scan: expect.objectContaining({ scanned: 1, failed: 0 }) }));
    const portfolio = (await api.request('/me/portfolio', { token: await api.tokenFor(CUSTOMER) })).body;
    expect(portfolio.items.find((row: { assetCode: string }) => row.assetCode === assetCode)).toEqual(expect.objectContaining({ unitPrice: '21000.0000', value: '210000.00' }));
  });

  // Reason: PRICE_NOT_LATEST only refuses an OLDER date; the same date is allowed and the later entry wins (v_asset_latest_price breaks the tie by created_at).
  test('two prices with the same effective date are both stored and the later one wins', async () => {
    const { assetId } = await createAsset(api, backOffice, 'MUTUAL_FUND', { initialPrice: '20000' });
    expect((await submitPrice(api, backOffice, assetId, '20100', '2026-01-15')).status).toBe(201);
    expect((await submitPrice(api, backOffice, assetId, '20200', '2026-01-15')).status).toBe(201);
    expect(await latest(assetId)).toBe('20200.0000');
    expect(await api.dataSource.query("SELECT 1 FROM wms.asset_pricing WHERE asset_id=$1 AND effective_date='2026-01-15'", [assetId])).toHaveLength(3);
  });

  // Reason: BR-15 says "above 20%"; the comparison is on the percent rounded to 4 digits, like the team trigger. 20.00004% rounds to 20.0000 (applies); 20.00005% rounds to 20.0001 (waits).
  test.each([
    ['exactly 20.00%', '24000', 'APPLIED', '24000.0000'],
    ['20.00004%', '24000.008', 'APPLIED', '24000.0080'],
    ['20.00005%', '24000.01', 'PENDING_APPROVAL', '20000.0000'],
    ['20.01%', '24002', 'PENDING_APPROVAL', '20000.0000'],
  ])('the 20%% guard at %s is %s', async (_label, value, status, inUse) => {
    const { assetId } = await createAsset(api, backOffice, 'MUTUAL_FUND', { initialPrice: '20000' });
    const response = await submitPrice(api, backOffice, assetId, value);
    expect(response.body.status).toBe(status);
    expect(await latest(assetId)).toBe(inUse);
  });
});

describe('S32 P3 characterization: bond maturing today', () => {
  let api: Api;
  let backOffice: string;
  beforeAll(async () => {
    api = await startApiFixture();
    await activeCustomer(api);
    api.state.now = new Date(); // after the fixture customer exists: tokens are issued at the moved clock, so they stay valid
    ({ backOffice } = await staffTokens(api));
  }, 120_000);
  afterAll(async () => { await api?.stop(); });

  // Reason: s28 pins "yesterday is refused"; the boundary is today (Vietnam date), which must be allowed, and the bond is then valued by its last price.
  // The team trigger compares with the database's own CURRENT_DATE, not the injected test clock, so this test moves the clock to the real "now" (a fixed 2026-01-15 would be refused by the trigger as a 500).
  test('a bond maturing today can be added and is valued by its latest price', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(api.state.now);
    const created = await api.request('/back-office/assets', { method: 'POST', token: backOffice, key: nextKey('asset'),
      body: { assetClass: 'BOND', assetCode: 'P3-MATURES-TODAY', assetName: 'Trái phiếu đáo hạn hôm nay', riskLevel: 2, minInvestment: '1000000', faceValue: '100000', couponRate: '8.5',
        maturityDate: today, issuer: 'Synthetic issuer', initialPrice: '100000' } });
    expect(created.status).toBe(201);
    await holdUnits(api, created.body.assetId, '10', '100000');
    const portfolio = (await api.request('/me/portfolio', { token: await api.tokenFor(CUSTOMER) })).body;
    expect(portfolio.items.find((row: { assetCode: string }) => row.assetCode === 'P3-MATURES-TODAY')).toEqual(expect.objectContaining({ value: '1000000.00', unrealizedPnl: '0.00' }));
  });
});

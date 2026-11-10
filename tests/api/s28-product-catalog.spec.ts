import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { expectApiError, startApiFixture } from '../helpers/application.js';
import { activeCustomer, audit, nextKey } from '../helpers/cash.js';
import type { Api } from '../helpers/cash.js';
import { assetBody, createAsset, holdUnits, RM, staffTokens } from '../helpers/portfolio.js';

describe('S28 UC-09 product catalog', () => {
  let api: Api;
  let backOffice: string;
  let manager: string;
  beforeAll(async () => { api = await startApiFixture(); await activeCustomer(api); ({ backOffice, manager } = await staffTokens(api)); }, 120_000);
  afterAll(async () => { await api?.stop(); });

  const post = (body: unknown, token = backOffice, key = nextKey('asset')) => api.request('/back-office/assets', { method: 'POST', token, key, body });

  test.each(['TERM_DEPOSIT', 'BOND', 'MUTUAL_FUND'] as const)('creates a %s with its child row, starting price and audit, ON_SALE', async assetClass => {
    const body = assetBody(assetClass);
    const created = await post(body);
    expect(created.status).toBe(201);
    expect(created.body).toEqual(expect.objectContaining({ assetCode: body.assetCode, assetClass, riskLevel: 2, status: 'ON_SALE', minInvestment: '1000000.00' }));
    const detail = await api.request(`/back-office/assets/${created.body.assetId}`, { token: backOffice });
    expect(detail.status).toBe(200);
    expect(detail.body.details).toEqual(expect.objectContaining(assetClass === 'BOND' ? { issuer: 'Synthetic issuer', faceValue: '100000.00' }
      : assetClass === 'MUTUAL_FUND' ? { fundType: 'BALANCED' } : { termMonths: 6, interestRate: '5.2000' }));
    expect(detail.body.prices).toHaveLength(1);
    expect(detail.body.prices[0]).toEqual(expect.objectContaining({ status: 'APPLIED', previousValue: null, priceType: assetClass === 'BOND' ? 'BOND_PRICE' : assetClass === 'MUTUAL_FUND' ? 'NAV' : 'INTEREST_RATE' }));
    expect((await audit(api, 'ASSET_CREATED')).at(-1)).toEqual(expect.objectContaining({ actor_role: 'BACK_OFFICE', reference_id: created.body.assetId }));
  });

  test('a duplicate code is 409 PRODUCT_CODE_EXISTS and leaves no second row', async () => {
    const body = assetBody('MUTUAL_FUND');
    expect((await post(body)).status).toBe(201);
    expectApiError(await post(body), 409, 'PRODUCT_CODE_EXISTS');
    expect(await api.dataSource.query('SELECT 1 FROM wms.assets WHERE asset_code=$1', [body.assetCode])).toHaveLength(1);
  });

  test('a bond maturing in the past is 400 BOND_MATURITY_PASSED, nothing is stored', async () => {
    const body = assetBody('BOND', { maturityDate: '2026-01-14' });
    expectApiError(await post(body), 400, 'BOND_MATURITY_PASSED');
    expect(await api.dataSource.query('SELECT 1 FROM wms.assets WHERE asset_code=$1', [body.assetCode])).toHaveLength(0);
  });

  test.each([
    ['risk level 0', { riskLevel: 0 }], ['risk level 6', { riskLevel: 6 }], ['risk level 2.5', { riskLevel: 2.5 }], ['empty code', { assetCode: ' ' }], ['float money', { minInvestment: 1000 }],
    ['fields of another class', { issuer: 'x' }], ['missing class fields', { fundType: undefined }], ['unknown fund type', { fundType: 'CRYPTO' }], ['unknown field', { color: 'red' }],
  ])('%s is 400 VALIDATION_ERROR', async (_label, extra) => {
    expectApiError(await post(assetBody('MUTUAL_FUND', extra)), 400, 'VALIDATION_ERROR');
  });

  test('a replay returns the stored result; the same key with another body is 409', async () => {
    const key = nextKey('asset');
    const body = assetBody('MUTUAL_FUND');
    const first = await post(body, backOffice, key);
    const again = await post(body, backOffice, key);
    expect(again.body).toEqual(first.body);
    expectApiError(await post(assetBody('MUTUAL_FUND'), backOffice, key), 409, 'IDEMPOTENCY_CONFLICT');
  });

  test('only BACK_OFFICE manages the catalog; the manager, RM and customer are 403', async () => {
    const rm = await api.tokenFor(RM);
    for (const token of [manager, rm]) expectApiError(await post(assetBody('MUTUAL_FUND'), token), 403, 'FORBIDDEN');
    expectApiError(await api.request('/back-office/assets', { token: rm }), 403, 'FORBIDDEN');
  });

  test('list filters by class, status and code', async () => {
    const asset = await createAsset(api, backOffice, 'BOND');
    const found = await api.request(`/back-office/assets?assetClass=BOND&status=ON_SALE&q=${asset.assetCode}`, { token: backOffice });
    expect(found.body.items.map((item: { assetId: string }) => item.assetId)).toEqual([asset.assetId]);
    expectApiError(await api.request('/back-office/assets?assetClass=GOLD', { token: backOffice }), 400, 'VALIDATION_ERROR');
  });

  test('discontinued products leave GET /products; the holdings stay', async () => {
    const asset = await createAsset(api, backOffice, 'MUTUAL_FUND');
    await holdUnits(api, asset.assetId, '10', '20000');
    const rm = await api.tokenFor(RM);
    const codes = async () => (await api.request('/products', { token: rm })).body.items.map((item: { assetCode: string }) => item.assetCode);
    expect(await codes()).toContain(asset.assetCode);
    const changed = await api.request(`/back-office/assets/${asset.assetId}/status`, { method: 'PATCH', token: backOffice, key: nextKey('status'), body: { status: 'DISCONTINUED' } });
    expect(changed.body.status).toBe('DISCONTINUED');
    expect(await codes()).not.toContain(asset.assetCode);
    expect(await api.dataSource.query("SELECT 1 FROM wms.portfolio_holdings WHERE asset_id=$1 AND status='OPEN'", [asset.assetId])).toHaveLength(1);
    expect((await audit(api, 'ASSET_STATUS_CHANGED')).at(-1)).toEqual(expect.objectContaining({ old_value: { status: 'ON_SALE' }, new_value: { status: 'DISCONTINUED' } }));
  });

  test('raising a risk level warns the RM of holders above their maximum, and the warning clears when it is lowered', async () => {
    const asset = await createAsset(api, backOffice, 'MUTUAL_FUND', { riskLevel: 3 });
    await holdUnits(api, asset.assetId, '10', '20000');
    const rm = await api.tokenFor(RM);
    const warnings = async () => (await api.request('/rm/product-risk-warnings', { token: rm })).body.items.filter((item: { assetCode: string }) => item.assetCode === asset.assetCode);
    expect(await warnings()).toEqual([]);
    const raise = (riskLevel: number) => api.request(`/back-office/assets/${asset.assetId}/risk-level`, { method: 'PATCH', token: backOffice, key: nextKey('risk'), body: { riskLevel } });
    expect((await raise(5)).body.riskLevel).toBe(5);
    expect(await warnings()).toEqual([expect.objectContaining({ riskLevel: 5, maxProductRisk: 3, fullName: expect.any(String), customerId: expect.any(String) })]);
    await raise(3);
    expect(await warnings()).toEqual([]);
    expectApiError(await raise(9), 400, 'VALIDATION_ERROR');
    expectApiError(await api.request('/back-office/assets/00000000-0000-4000-8000-000000000000/status', { method: 'PATCH', token: backOffice, key: nextKey('status'), body: { status: 'ON_SALE' } }), 404, 'ASSET_NOT_FOUND');
  });
});

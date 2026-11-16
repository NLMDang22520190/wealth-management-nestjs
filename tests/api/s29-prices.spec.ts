import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { expectApiError, startApiFixture } from '../helpers/application.js';
import { activeCustomer, audit, nextKey } from '../helpers/cash.js';
import type { Api } from '../helpers/cash.js';
import { BACK_OFFICE, createAsset, decide, holdUnits, MANAGER, snapshots, staffTokens, submitPrice } from '../helpers/portfolio.js';

describe('S29 UC-10 prices, NAV and interest rates', () => {
  let api: Api;
  let backOffice: string;
  let manager: string;
  beforeEach(async () => { api = await startApiFixture(); await activeCustomer(api); ({ backOffice, manager } = await staffTokens(api)); }, 120_000);
  afterEach(async () => { await api?.stop(); });

  const latest = async (assetId: string) => (await api.dataSource.query('SELECT value::text FROM wms.v_asset_latest_price WHERE asset_id=$1', [assetId]))[0]?.value;

  test('a change of exactly 20% applies at once and reports old, new and percent', async () => {
    const { assetId } = await createAsset(api, backOffice, 'MUTUAL_FUND');
    const response = await submitPrice(api, backOffice, assetId, '24000');
    expect(response.status).toBe(201);
    expect(response.body).toEqual(expect.objectContaining({ status: 'APPLIED', previousValue: '20000.0000', value: '24000.0000', changePct: '20.0000', effectiveDate: '2026-01-15', priceType: 'NAV' }));
    expect(await latest(assetId)).toBe('24000.0000');
    expect((await audit(api, 'PRICE_SUBMITTED')).at(-1)).toEqual(expect.objectContaining({ actor_id: BACK_OFFICE, outcome: 'SUCCESS' }));
  });

  test('just above 20% waits for approval and is not used for valuation', async () => {
    const { assetId } = await createAsset(api, backOffice, 'MUTUAL_FUND');
    const response = await submitPrice(api, backOffice, assetId, '24000.0100');
    expect(response.body).toEqual(expect.objectContaining({ status: 'PENDING_APPROVAL', scan: null }));
    expect(await latest(assetId)).toBe('20000.0000');
    expectApiError(await submitPrice(api, backOffice, assetId, '20100'), 409, 'PRICE_PENDING_EXISTS');
    const pending = await api.request('/back-office/prices/pending', { token: manager });
    expect(pending.body.items).toEqual([expect.objectContaining({ pricingId: response.body.pricingId, assetId, previousValue: '20000.0000', value: '24000.0100', makerCode: BACK_OFFICE })]);
    expect((await api.request('/back-office/prices/pending', { token: backOffice })).status).toBe(200);
  });

  test('the same 20% guard covers a bond price and a falling price, and an interest rate', async () => {
    const bond = await createAsset(api, backOffice, 'BOND');
    expect((await submitPrice(api, backOffice, bond.assetId, '79999')).body.status).toBe('PENDING_APPROVAL');
    const deposit = await createAsset(api, backOffice, 'TERM_DEPOSIT');
    expect((await submitPrice(api, backOffice, deposit.assetId, '7')).body.status).toBe('PENDING_APPROVAL');
  });

  test('approval applies the price, records maker and checker, and revalues holders', async () => {
    const { assetId } = await createAsset(api, backOffice, 'MUTUAL_FUND');
    await holdUnits(api, assetId, '100', '20000');
    const { pricingId } = (await submitPrice(api, backOffice, assetId, '30000')).body;
    expect(await snapshots(api)).toEqual([]);
    const approved = await decide(api, manager, pricingId, 'approve');
    expect(approved.status).toBe(200);
    expect(approved.body).toEqual(expect.objectContaining({ decision: 'APPROVED', value: '30000.0000', scan: expect.objectContaining({ scanned: 1, failed: 0 }) }));
    expect(await latest(assetId)).toBe('30000.0000');
    expect(await snapshots(api)).toEqual([expect.objectContaining({ snapshot_kind: 'EVENT', aum: '3000000.00' })]);
    expect((await api.request('/back-office/prices/pending', { token: manager })).body.items).toEqual([]);
    expectApiError(await decide(api, manager, pricingId, 'approve'), 409, 'PRICE_NOT_PENDING');
    expect((await audit(api, 'PRICE_APPROVED')).at(-1)).toEqual(expect.objectContaining({ actor_role: 'BACK_OFFICE_MANAGER', reference_id: pricingId }));
  });

  test('rejection keeps the old price, needs a reason and frees the product for a new price', async () => {
    const { assetId } = await createAsset(api, backOffice, 'MUTUAL_FUND');
    const { pricingId } = (await submitPrice(api, backOffice, assetId, '30000')).body;
    expectApiError(await decide(api, manager, pricingId, 'reject', ' '), 400, 'VALIDATION_ERROR');
    expect((await decide(api, manager, pricingId, 'reject')).body.decision).toBe('REJECTED');
    expect(await latest(assetId)).toBe('20000.0000');
    expect((await submitPrice(api, backOffice, assetId, '20100')).body.status).toBe('APPLIED');
  });

  test('only the manager decides, and a manager cannot check their own entry', async () => {
    const { assetId } = await createAsset(api, backOffice, 'MUTUAL_FUND');
    const { pricingId } = (await submitPrice(api, backOffice, assetId, '30000')).body;
    expectApiError(await decide(api, backOffice, pricingId, 'approve'), 403, 'FORBIDDEN');
    expectApiError(await submitPrice(api, manager, assetId, '20100'), 403, 'FORBIDDEN');
    const managerStaff = (await api.dataSource.query("SELECT staff_id FROM wms.staff_users WHERE employee_code='NV0191'"))[0].staff_id;
    const other = await createAsset(api, backOffice, 'MUTUAL_FUND');
    const [own] = await api.dataSource.query(`INSERT INTO wms.asset_pricing(asset_id,price_type,value,previous_value,effective_date,status,created_by)
      VALUES($1,'NAV',50000,20000,'2026-01-15','PENDING_APPROVAL',$2) RETURNING pricing_id`, [other.assetId, managerStaff]);
    expectApiError(await decide(api, manager, own.pricing_id, 'approve'), 403, 'MAKER_CHECKER_VIOLATION');
  });

  test('a manager deciding their own entry is refused with 403 and the attempt is audited DENIED, without secrets', async () => {
    const { assetId } = await createAsset(api, backOffice, 'MUTUAL_FUND');
    const managerStaff = (await api.dataSource.query(`SELECT staff_id FROM wms.staff_users WHERE employee_code='${MANAGER}'`))[0].staff_id;
    const [own] = await api.dataSource.query(`INSERT INTO wms.asset_pricing(asset_id,price_type,value,previous_value,effective_date,status,created_by)
      VALUES($1,'NAV',50000,20000,'2026-01-15','PENDING_APPROVAL',$2) RETURNING pricing_id`, [assetId, managerStaff]);
    expectApiError(await decide(api, manager, own.pricing_id, 'approve', 'Tự duyệt giá của mình'), 403, 'MAKER_CHECKER_VIOLATION');
    const denied = (await audit(api, 'PRICE_DECISION')).filter(row => row.outcome === 'DENIED');
    expect(denied).toEqual([expect.objectContaining({ actor_id: MANAGER, actor_role: 'BACK_OFFICE_MANAGER', reference_type: 'ASSET_PRICING', reference_id: own.pricing_id,
      new_value: { errorCode: 'MAKER_CHECKER_VIOLATION' } })]);
    expect(JSON.stringify(denied)).not.toContain('Tự duyệt');
    expect(await api.dataSource.query('SELECT 1 FROM wms.price_approvals WHERE pricing_id=$1', [own.pricing_id])).toEqual([]);
    expect((await api.request('/back-office/prices/pending', { token: manager })).body.items.map((item: { pricingId: string }) => item.pricingId)).toContain(own.pricing_id);
  });

  test('deciding a price that does not exist is 404 PRICE_NOT_FOUND; one that exists but is already decided stays 409', async () => {
    const unknown = '00000000-0000-4000-8000-000000000000';
    expectApiError(await decide(api, manager, unknown, 'approve'), 404, 'PRICE_NOT_FOUND');
    expectApiError(await decide(api, manager, unknown, 'reject'), 404, 'PRICE_NOT_FOUND');
    const { assetId } = await createAsset(api, backOffice, 'MUTUAL_FUND');
    const { pricingId } = (await submitPrice(api, backOffice, assetId, '30000')).body;
    expect((await decide(api, manager, pricingId, 'reject')).status).toBe(200);
    expectApiError(await decide(api, manager, pricingId, 'approve'), 409, 'PRICE_NOT_PENDING');
    const applied = (await submitPrice(api, backOffice, assetId, '20100')).body.pricingId;
    expectApiError(await decide(api, manager, applied, 'approve'), 409, 'PRICE_NOT_PENDING');
  });

  test('value and date rules', async () => {
    const { assetId } = await createAsset(api, backOffice, 'MUTUAL_FUND');
    expectApiError(await submitPrice(api, backOffice, assetId, '0'), 400, 'VALIDATION_ERROR');
    expectApiError(await submitPrice(api, backOffice, assetId, '-1'), 400, 'VALIDATION_ERROR');
    expectApiError(await submitPrice(api, backOffice, assetId, '20100', '2026-01-16'), 400, 'VALIDATION_ERROR');
    expect((await submitPrice(api, backOffice, assetId, '20100', '2026-01-15')).status).toBe(201);
    expectApiError(await submitPrice(api, backOffice, assetId, '20200', '2026-01-14'), 409, 'PRICE_NOT_LATEST');
    expectApiError(await submitPrice(api, backOffice, '00000000-0000-4000-8000-000000000000', '1'), 404, 'ASSET_NOT_FOUND');
  });

  test('today is the Vietnam day: at 17:30 UTC the default effective date is already the next day', async () => {
    const { assetId } = await createAsset(api, backOffice, 'MUTUAL_FUND');
    api.state.now = new Date('2026-01-15T17:30:00.000Z');
    expect((await submitPrice(api, await api.tokenFor(BACK_OFFICE), assetId, '20100')).body.effectiveDate).toBe('2026-01-16');
  });

  test('a new interest rate updates the product and needs no scan: open deposits keep their locked rate', async () => {
    const { assetId } = await createAsset(api, backOffice, 'TERM_DEPOSIT');
    expect((await submitPrice(api, backOffice, assetId, '5.5')).body).toEqual(expect.objectContaining({ status: 'APPLIED', priceType: 'INTEREST_RATE', scan: null }));
    expect((await api.dataSource.query('SELECT interest_rate::text FROM wms.term_deposit_products WHERE asset_id=$1', [assetId]))[0].interest_rate).toBe('5.5000');
  });

  test('a replay returns the stored result without a second price', async () => {
    const { assetId } = await createAsset(api, backOffice, 'MUTUAL_FUND');
    const key = nextKey('price');
    const first = await submitPrice(api, backOffice, assetId, '20100', undefined, key);
    const again = await submitPrice(api, backOffice, assetId, '20100', undefined, key);
    expect(again.body.pricingId).toBe(first.body.pricingId);
    expect(await api.dataSource.query('SELECT 1 FROM wms.asset_pricing WHERE asset_id=$1', [assetId])).toHaveLength(2);
  });

  describe('CSV import', () => {
    const load = (csv: string, token = backOffice) => api.request('/back-office/prices/import', { method: 'POST', token, key: nextKey('csv'), body: { csv } });

    test('a bad row does not stop the others; each row reports its result; holders are scanned once', async () => {
      const a = await createAsset(api, backOffice, 'MUTUAL_FUND');
      const b = await createAsset(api, backOffice, 'MUTUAL_FUND');
      const c = await createAsset(api, backOffice, 'MUTUAL_FUND');
      await holdUnits(api, a.assetId, '10', '20000');
      await holdUnits(api, b.assetId, '10', '20000');
      const csv = `﻿assetCode,value,effectiveDate\r\n${a.assetCode},20100,2026-01-15\n${b.assetCode},20200,\n${c.assetCode},90000,2026-01-15\nNOPE,1,2026-01-15\n${a.assetCode},abc,2026-01-15\n\n`;
      const response = await load(csv);
      expect(response.status).toBe(200);
      expect(response.body.rows).toEqual([
        { line: 2, assetCode: a.assetCode, status: 'APPLIED', code: null }, { line: 3, assetCode: b.assetCode, status: 'APPLIED', code: null },
        { line: 4, assetCode: c.assetCode, status: 'PENDING_APPROVAL', code: null }, { line: 5, assetCode: 'NOPE', status: 'ERROR', code: 'ASSET_NOT_FOUND' },
        { line: 6, assetCode: a.assetCode, status: 'ERROR', code: 'VALIDATION_ERROR' }]);
      expect(response.body.scan).toEqual(expect.objectContaining({ scanned: 1, failed: 0 }));
      expect(await snapshots(api)).toHaveLength(1);
    });

    test('a wrong header or more than 500 rows is refused as a whole', async () => {
      expectApiError(await load('code,value\nA,1'), 400, 'VALIDATION_ERROR');
      const rows = Array.from({ length: 501 }, () => 'A,1,2026-01-15').join('\n');
      expectApiError(await load(`assetCode,value,effectiveDate\n${rows}`), 400, 'VALIDATION_ERROR');
      expectApiError(await load('assetCode,value,effectiveDate\n', manager), 403, 'FORBIDDEN');
    });
  });
});

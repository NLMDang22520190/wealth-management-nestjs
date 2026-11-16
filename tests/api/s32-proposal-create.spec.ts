import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { actors, insertStaff, staff, viaDataSource } from '../helpers/actors.js';
import { expectApiError, startApiFixture } from '../helpers/application.js';
import { audit, fund, nextKey } from '../helpers/cash.js';
import type { Api } from '../helpers/cash.js';
import { createAsset, holdUnits, RM, runSnapshot } from '../helpers/portfolio.js';
import { created, propose, proposalCustomer, proposalRow } from '../helpers/proposals.js';

describe('S32 UC-13 create a proposal', () => {
  let api: Api;
  let customerId: string;
  let backOffice: string;
  let fundId: string;
  beforeEach(async () => {
    api = await startApiFixture();
    ({ customerId, backOffice } = await proposalCustomer(api));
    await fund(api, '100000000');
    fundId = (await createAsset(api, backOffice, 'MUTUAL_FUND')).assetId; // risk 2, NAV 20,000, minimum 1,000,000
  }, 120_000);
  afterEach(async () => { await api?.stop(); });

  test('stores legs at the latest prices, totals, a 24-hour expiry, audit and outbox', async () => {
    const deposit = await createAsset(api, backOffice, 'TERM_DEPOSIT');
    const response = await propose(api, customerId, [{ action: 'BUY', assetId: fundId, quantity: '1000' }, { action: 'OPEN', assetId: deposit.assetId, amount: '30000000' }], { note: 'Tái cân bằng' });
    expect(response.status).toBe(201);
    const body = response.body;
    expect(body).toEqual(expect.objectContaining({ status: 'PENDING_APPROVAL', customerId, totalEstimatedBuy: '50000000.00', totalEstimatedSell: '0.00', cashAtCreation: '100000000.00', note: 'Tái cân bằng' }));
    expect(body.proposalCode).toMatch(/^PROP-20260115-\d{3}$/);
    expect(new Date(body.expiresAt).getTime() - new Date(body.createdAt).getTime()).toBe(24 * 3_600_000);
    expect(body.legs).toEqual([
      expect.objectContaining({ legNo: 1, action: 'BUY', assetId: fundId, quantity: '1000.000000', expectedPrice: '20000.0000', estimatedAmount: '20000000.00' }),
      expect.objectContaining({ legNo: 2, action: 'OPEN', assetId: deposit.assetId, quantity: '30000000.000000', expectedPrice: '1.0000', estimatedAmount: '30000000.00' })]);
    expect((await audit(api, 'PROPOSAL_CREATED')).at(-1)).toEqual(expect.objectContaining({ actor_id: RM, reference_id: body.proposalId }));
    expect(await api.dataSource.query("SELECT 1 FROM wms.outbox_events WHERE event_type='ProposalCreated' AND aggregate_id=$1", [body.proposalId])).toHaveLength(1);
  });

  test('one pending proposal per customer (BR-24); an expired one no longer blocks', async () => {
    const first = await created(api, customerId, [{ action: 'BUY', assetId: fundId, quantity: '100' }]);
    expectApiError(await propose(api, customerId, [{ action: 'BUY', assetId: fundId, quantity: '100' }]), 409, 'PROPOSAL_PENDING_EXISTS');
    api.tick(24 * 3_600_000);
    expect((await propose(api, customerId, [{ action: 'BUY', assetId: fundId, quantity: '100' }])).status).toBe(201);
    expect((await proposalRow(api, first.proposalId)).status).toBe('EXPIRED');
  });

  test('suitability (BR-18), products on sale, prices and minimum investment are checked per leg', async () => {
    const risky = await createAsset(api, backOffice, 'MUTUAL_FUND', { riskLevel: 4 });
    const failure = await propose(api, customerId, [{ action: 'BUY', assetId: fundId, quantity: '100' }, { action: 'BUY', assetId: risky.assetId, quantity: '100' }]);
    expectApiError(failure, 422, 'SUITABILITY_VIOLATION');
    expect(failure.body.details).toEqual(expect.objectContaining({ legNo: 2, assetCode: risky.assetCode }));
    const stopped = await createAsset(api, backOffice, 'MUTUAL_FUND');
    await api.request(`/back-office/assets/${stopped.assetId}/status`, { method: 'PATCH', token: backOffice, key: nextKey('status'), body: { status: 'DISCONTINUED' } });
    expectApiError(await propose(api, customerId, [{ action: 'BUY', assetId: stopped.assetId, quantity: '100' }]), 422, 'PRODUCT_NOT_ON_SALE');
    const unpriced = await createAsset(api, backOffice, 'MUTUAL_FUND', { initialPrice: undefined });
    expectApiError(await propose(api, customerId, [{ action: 'BUY', assetId: unpriced.assetId, quantity: '100' }]), 422, 'PRICE_UNAVAILABLE');
    const small = await propose(api, customerId, [{ action: 'BUY', assetId: fundId, quantity: '10' }]);
    expectApiError(small, 422, 'BELOW_MIN_INVESTMENT');
    expect(small.body.details).toEqual(expect.objectContaining({ legNo: 1 }));
    expect(await api.dataSource.query('SELECT 1 FROM wms.proposals')).toHaveLength(0);
  });

  test('budget (BR-20): buys up to cash plus estimated sales; one dong more is refused with the shortfall', async () => {
    expectApiError(await propose(api, customerId, [{ action: 'BUY', assetId: fundId, quantity: '5000.00005' }]), 422, 'BUDGET_EXCEEDED');
    const over = await propose(api, customerId, [{ action: 'BUY', assetId: fundId, quantity: '5000.00005' }]);
    expect(over.body.details).toEqual(expect.objectContaining({ shortfall: '1.00' }));
    const bond = await createAsset(api, backOffice, 'BOND');
    await holdUnits(api, bond.assetId, '100', '100000');
    const holdingId = (await api.dataSource.query('SELECT holding_id FROM wms.portfolio_holdings WHERE asset_id=$1', [bond.assetId]))[0].holding_id;
    const funded = await propose(api, customerId, [{ action: 'SELL', holdingId, quantity: '100' }, { action: 'BUY', assetId: fundId, quantity: '5500' }]);
    expect(funded.status).toBe(201);
    expect(funded.body).toEqual(expect.objectContaining({ totalEstimatedBuy: '110000000.00', totalEstimatedSell: '10000000.00' }));
  });

  test('sell and settle legs need a holding of this customer and no more than it holds', async () => {
    const bond = await createAsset(api, backOffice, 'BOND');
    await holdUnits(api, bond.assetId, '100', '100000');
    const holdingId = (await api.dataSource.query('SELECT holding_id FROM wms.portfolio_holdings WHERE asset_id=$1', [bond.assetId]))[0].holding_id;
    expectApiError(await propose(api, customerId, [{ action: 'SELL', holdingId, quantity: '100.5' }]), 422, 'QUANTITY_EXCEEDS_HOLDING');
    expectApiError(await propose(api, customerId, [{ action: 'SELL', holdingId: '00000000-0000-4000-8000-000000000000', quantity: '1' }]), 422, 'HOLDING_NOT_FOUND');
    expectApiError(await propose(api, customerId, [{ action: 'SETTLE', holdingId }]), 422, 'HOLDING_NOT_FOUND'); // a bond is not a deposit
    expectApiError(await propose(api, customerId, [{ action: 'SELL', holdingId, quantity: '10' }, { action: 'SELL', holdingId, quantity: '10' }]), 400, 'VALIDATION_ERROR');
  });

  test.each([
    ['no legs', []], ['an unknown action', [{ action: 'SWAP', assetId: '00000000-0000-4000-8000-000000000000', quantity: '1' }]],
    ['a buy with a holding', [{ action: 'BUY', holdingId: '00000000-0000-4000-8000-000000000000', quantity: '1' }]],
    ['a float quantity', [{ action: 'BUY', assetId: '00000000-0000-4000-8000-000000000000', quantity: 1 }]], ['a zero amount', [{ action: 'OPEN', assetId: '00000000-0000-4000-8000-000000000000', amount: '0' }]],
  ])('%s is 400 VALIDATION_ERROR', async (_label, legs) => {
    expectApiError(await propose(api, customerId, legs as never), 400, 'VALIDATION_ERROR');
  });

  test('a fund bought must be a fund or bond; a deposit opened must be a deposit', async () => {
    const deposit = await createAsset(api, backOffice, 'TERM_DEPOSIT');
    expectApiError(await propose(api, customerId, [{ action: 'BUY', assetId: deposit.assetId, quantity: '1000' }]), 400, 'VALIDATION_ERROR');
    expectApiError(await propose(api, customerId, [{ action: 'OPEN', assetId: fundId, amount: '1000000' }]), 400, 'VALIDATION_ERROR');
  });

  test('only the current RM proposes; a risk profile past its 12 months is refused', async () => {
    expectApiError(await propose(api, customerId, [{ action: 'BUY', assetId: fundId, quantity: '100' }], {}, nextKey('p'), actors.leader.actorId), 403, 'FORBIDDEN');
    await insertStaff(viaDataSource(api.dataSource), staff.foreign);
    expectApiError(await propose(api, customerId, [{ action: 'BUY', assetId: fundId, quantity: '100' }], {}, nextKey('p'), staff.foreign.actorId), 403, 'FORBIDDEN');
    api.state.now = new Date('2027-02-15T05:00:00.000Z');
    expectApiError(await propose(api, customerId, [{ action: 'BUY', assetId: fundId, quantity: '100' }]), 422, 'RISK_PROFILE_REQUIRED');
  });

  test('from a drift alert: the alert becomes ACTIONED; an alert of nobody is 404', async () => {
    await runSnapshot(api, backOffice);
    const alert = (await api.request('/rm/drift-alerts', { token: await api.tokenFor(RM) })).body.items[0];
    expectApiError(await propose(api, customerId, [{ action: 'BUY', assetId: fundId, quantity: '100' }], { driftAlertId: '00000000-0000-4000-8000-000000000000' }), 404, 'ALERT_NOT_FOUND');
    const proposal = await created(api, customerId, [{ action: 'BUY', assetId: fundId, quantity: '100' }], { driftAlertId: alert.alertId });
    expect((await proposalRow(api, proposal.proposalId)).drift_alert_id).toBe(alert.alertId);
    expect((await api.dataSource.query('SELECT status::text FROM wms.drift_alerts WHERE alert_id=$1', [alert.alertId]))[0].status).toBe('ACTIONED');
  });

  test('a replay returns the stored proposal; the same key with another body is 409', async () => {
    const key = nextKey('proposal');
    const first = await propose(api, customerId, [{ action: 'BUY', assetId: fundId, quantity: '100' }], {}, key);
    const again = await propose(api, customerId, [{ action: 'BUY', assetId: fundId, quantity: '100' }], {}, key);
    expect(again.body.proposalId).toBe(first.body.proposalId);
    expectApiError(await propose(api, customerId, [{ action: 'BUY', assetId: fundId, quantity: '200' }], {}, key), 409, 'IDEMPOTENCY_CONFLICT');
  });
});

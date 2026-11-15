import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { expectApiError, startApiFixture } from '../helpers/application.js';
import { account, audit, createOrder, fund, nextKey } from '../helpers/cash.js';
import type { Api } from '../helpers/cash.js';
import { createAsset, submitPrice } from '../helpers/portfolio.js';
import { approve, approveNow, challenge, codeOf, created, proposalCustomer, proposalRow, wrongCode } from '../helpers/proposals.js';

describe('S34 UC-15 approval with Smart OTP and the slippage guard (BR-22)', () => {
  let api: Api;
  let customerId: string;
  let backOffice: string;
  let fundId: string;
  beforeEach(async () => {
    api = await startApiFixture();
    ({ customerId, backOffice } = await proposalCustomer(api));
    await fund(api, '100000000');
    fundId = (await createAsset(api, backOffice, 'MUTUAL_FUND')).assetId; // NAV 20,000
  }, 120_000);
  afterEach(async () => { await api?.stop(); });

  const buy = () => created(api, customerId, [{ action: 'BUY', assetId: fundId, quantity: '1000' }]);

  test('a move of exactly 5% still gets a code; the approval executes', async () => {
    const { proposalId } = await buy();
    await submitPrice(api, backOffice, fundId, '21000');
    const issued = await challenge(api, proposalId);
    expect(issued.status).toBe(201);
    expect(issued.body).toEqual(expect.objectContaining({ challengeId: expect.any(String), expiresAt: expect.any(String) }));
    expect(issued.body.legs).toEqual([expect.objectContaining({ legNo: 1, expectedPrice: '20000.0000', currentPrice: '21000.0000', slippagePct: '5.0000' })]);
    const done = await approve(api, proposalId, issued.body.challengeId, codeOf(api, issued.body.challengeId));
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('EXECUTED');
  });

  test('above 5% the proposal fails before any code is sent', async () => {
    const { proposalId } = await buy();
    await submitPrice(api, backOffice, fundId, '21001');
    const sent = api.deliveries.length;
    const refused = await challenge(api, proposalId);
    expectApiError(refused, 409, 'SLIPPAGE_EXCEEDED');
    expect(refused.body.details).toEqual(expect.objectContaining({ legs: [expect.objectContaining({ legNo: 1, slippagePct: '5.0050' })] }));
    expect(api.deliveries.length).toBe(sent);
    expect(await proposalRow(api, proposalId)).toEqual(expect.objectContaining({ status: 'FAILED', failure_reason: 'SLIPPAGE_EXCEEDED' }));
    expect((await audit(api, 'PROPOSAL_FAILED')).at(-1)).toEqual(expect.objectContaining({ reference_id: proposalId }));
  });

  test('a price that moves while the customer types the code fails the proposal and changes no money', async () => {
    const { proposalId } = await buy();
    const issued = await challenge(api, proposalId);
    await submitPrice(api, backOffice, fundId, '22000');
    const done = await approve(api, proposalId, issued.body.challengeId, codeOf(api, issued.body.challengeId));
    expect(done.status).toBe(200);
    expect(done.body).toEqual(expect.objectContaining({ status: 'FAILED', failureReason: 'SLIPPAGE_EXCEEDED' }));
    expect((await account(api)).balance).toBe('100000000.00');
  });

  test('a wrong code keeps the proposal pending, three times at most per code; a new code works', async () => {
    const { proposalId } = await buy();
    const issued = await challenge(api, proposalId);
    const code = codeOf(api, issued.body.challengeId);
    for (let attempt = 0; attempt < 3; attempt++) expectApiError(await approve(api, proposalId, issued.body.challengeId, wrongCode(code)), 400, 'OTP_INVALID');
    expect((await proposalRow(api, proposalId)).status).toBe('PENDING_APPROVAL');
    expectApiError(await approve(api, proposalId, issued.body.challengeId, code), 409, 'OTP_ATTEMPTS_EXCEEDED');
    expect((await audit(api, 'PROPOSAL_APPROVE')).filter(row => row.outcome === 'FAILURE')).toHaveLength(3);
    expect((await approveNow(api, proposalId)).body.status).toBe('EXECUTED');
  });

  test('a code issued for another operation does not approve', async () => {
    const { proposalId } = await buy();
    const order = await createOrder(api, 'deposits', '1000000');
    expectApiError(await approve(api, proposalId, order.body.challengeId, codeOf(api, order.body.challengeId)), 409, 'OTP_BINDING_MISMATCH');
  });

  test('a replay returns the stored result; an expired proposal cannot be approved', async () => {
    const { proposalId } = await buy();
    const issued = await challenge(api, proposalId);
    const key = nextKey('approve');
    const first = await approve(api, proposalId, issued.body.challengeId, codeOf(api, issued.body.challengeId), key);
    const again = await approve(api, proposalId, issued.body.challengeId, codeOf(api, issued.body.challengeId), key);
    expect(again.body).toEqual(first.body);
    const late = await created(api, customerId, [{ action: 'BUY', assetId: fundId, quantity: '100' }]);
    api.tick(24 * 3_600_000);
    expectApiError(await challenge(api, late.proposalId), 410, 'PROPOSAL_EXPIRED');
  });

  test('another customer cannot see or approve it', async () => {
    const { proposalId } = await buy();
    const rmToken = await api.tokenFor('NV0102');
    expectApiError(await api.request(`/me/proposals/${proposalId}/approval-challenge`, { method: 'POST', token: rmToken, key: nextKey('c') }), 403, 'FORBIDDEN');
  });
});

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { actors } from '../helpers/actors.js';
import { expectApiError, startApiFixture } from '../helpers/application.js';
import { audit, CUSTOMER, fund } from '../helpers/cash.js';
import type { Api } from '../helpers/cash.js';
import { createAsset, RM, runSnapshot } from '../helpers/portfolio.js';
import { cancel, created, proposalCustomer, proposalRow, reject } from '../helpers/proposals.js';

const DAY = 24 * 3_600_000;

describe('S33 UC-14 cancel, UC-15 reject, BR-21 expiry, BR-25 terminal states', () => {
  let api: Api;
  let customerId: string;
  let backOffice: string;
  let fundId: string;
  beforeEach(async () => {
    api = await startApiFixture();
    ({ customerId, backOffice } = await proposalCustomer(api));
    await fund(api, '100000000');
    fundId = (await createAsset(api, backOffice, 'MUTUAL_FUND')).assetId;
  }, 120_000);
  afterEach(async () => { await api?.stop(); });

  const buy = () => created(api, customerId, [{ action: 'BUY', assetId: fundId, quantity: '100' }]);

  test('RM cancels with a reason of 10 to 255 characters; a second cancel is 409 with the state', async () => {
    const { proposalId } = await buy();
    expectApiError(await cancel(api, proposalId, 'ngắn'), 400, 'VALIDATION_ERROR');
    const done = await cancel(api, proposalId);
    expect(done.status).toBe(200);
    expect(done.body).toEqual(expect.objectContaining({ status: 'CANCELLED', cancelReason: 'Khách hàng yêu cầu thay đổi tỷ trọng', closedAt: expect.any(String) }));
    const again = await cancel(api, proposalId);
    expectApiError(again, 409, 'PROPOSAL_NOT_PENDING');
    expect(again.body.details).toEqual(expect.objectContaining({ status: 'CANCELLED', closedAt: expect.any(String) }));
    expect((await audit(api, 'PROPOSAL_CANCELLED')).at(-1)).toEqual(expect.objectContaining({ actor_id: RM, reference_id: proposalId }));
  });

  test('only the current RM cancels', async () => {
    const { proposalId } = await buy();
    expectApiError(await cancel(api, proposalId, 'Khách hàng yêu cầu thay đổi', actors.leader.actorId), 403, 'FORBIDDEN');
    expectApiError(await cancel(api, proposalId, 'Khách hàng yêu cầu thay đổi', CUSTOMER), 403, 'FORBIDDEN');
  });

  test('the customer rejects with a reason; RM can no longer cancel', async () => {
    const { proposalId } = await buy();
    const done = await reject(api, proposalId);
    expect(done.status).toBe(200);
    expect(done.body).toEqual(expect.objectContaining({ status: 'REJECTED', rejectionReason: 'Chưa phù hợp thời điểm' }));
    expectApiError(await reject(api, proposalId), 409, 'PROPOSAL_NOT_PENDING');
    expect((await cancel(api, proposalId)).body.details.status).toBe('REJECTED');
    expectApiError(await reject(api, '00000000-0000-4000-8000-000000000000'), 404, 'NOT_FOUND');
  });

  test('expiry is exactly 24 hours; opening it marks it EXPIRED and acting on it is 410', async () => {
    const { proposalId } = await buy();
    const read = async () => (await api.request(`/me/proposals/${proposalId}`, { token: await api.tokenFor(CUSTOMER) })).body.status;
    api.tick(DAY - 1);
    expect(await read()).toBe('PENDING_APPROVAL');
    api.tick(1);
    expect(await read()).toBe('EXPIRED');
    expectApiError(await reject(api, proposalId), 410, 'PROPOSAL_EXPIRED');
    expectApiError(await cancel(api, proposalId), 410, 'PROPOSAL_EXPIRED');
    expect((await audit(api, 'PROPOSAL_EXPIRED')).at(-1)).toEqual(expect.objectContaining({ actor_role: 'SYSTEM_JOB', reference_id: proposalId }));
  });

  test('acting after 24 hours without reading first answers 410 and leaves it EXPIRED', async () => {
    const { proposalId } = await buy();
    api.tick(DAY);
    expectApiError(await reject(api, proposalId), 410, 'PROPOSAL_EXPIRED');
    expect((await proposalRow(api, proposalId)).status).toBe('EXPIRED');
  });

  test('the job expires proposals nobody opened', async () => {
    const { proposalId } = await buy();
    const compiled = new URL('../../apps/api/dist/modules/advisory-trading/proposal-jobs.js', import.meta.url).href;
    const jobs = api.app.get((await import(/* @vite-ignore */ compiled)).ProposalJobs);
    await jobs.tick();
    expect((await proposalRow(api, proposalId)).status).toBe('PENDING_APPROVAL');
    api.tick(DAY);
    await jobs.tick();
    expect((await proposalRow(api, proposalId)).status).toBe('EXPIRED');
  });

  test('a proposal made from a drift alert releases it when it closes', async () => {
    await runSnapshot(api, backOffice);
    const alert = (await api.request('/rm/drift-alerts', { token: await api.tokenFor(RM) })).body.items[0];
    const { proposalId } = await created(api, customerId, [{ action: 'BUY', assetId: fundId, quantity: '100' }], { driftAlertId: alert.alertId });
    await cancel(api, proposalId);
    expect((await api.dataSource.query('SELECT status::text FROM wms.drift_alerts WHERE alert_id=$1', [alert.alertId]))[0].status).toBe('RESOLVED');
  });

  test('staff and customer reads: lists, detail with legs, views of staff audited; terminal rows are frozen', async () => {
    const { proposalId } = await buy();
    const mine = await api.request('/me/proposals', { token: await api.tokenFor(CUSTOMER) });
    expect(mine.body.items.map((item: { proposalId: string }) => item.proposalId)).toEqual([proposalId]);
    const leader = await api.request(`/customers/${customerId}/proposals`, { token: await api.tokenFor(actors.leader.actorId) });
    expect(leader.body.items).toHaveLength(1);
    expect((await audit(api, 'PROPOSAL_VIEW')).at(-1)).toEqual(expect.objectContaining({ actor_id: actors.leader.actorId, outcome: 'SUCCESS' }));
    const detail = await api.request(`/proposals/${proposalId}`, { token: await api.tokenFor(RM) });
    expect(detail.body.legs).toHaveLength(1);
    expect((await api.request('/rm/proposals?status=PENDING_APPROVAL', { token: await api.tokenFor(RM) })).body.items).toHaveLength(1);
    await cancel(api, proposalId);
    await expect(api.dataSource.query("UPDATE wms.proposals SET status='PENDING_APPROVAL' WHERE proposal_id=$1", [proposalId])).rejects.toThrow();
  });
});

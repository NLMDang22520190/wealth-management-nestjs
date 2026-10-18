import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { actors } from '../helpers/actors.js';
import { eligibleCustomer, startApiFixture } from '../helpers/application.js';

type Fixture = Awaited<ReturnType<typeof startApiFixture>>;

const replacement = { actorId: 'rm-s15-replacement', rmId: '66666666-6666-4666-8666-666666666666' };

/** S15 AC4 (API part): team/rms and team/customers expose rmName = mock_actors.actor_id of the RM. */
describe('S15 AC4 rmName on leader team endpoints', () => {
  let api: Fixture;
  beforeEach(async () => {
    api = await startApiFixture();
    await api.dataSource.query('INSERT INTO mock_actors(actor_id,subject_id,role,rm_id,team_id,active) VALUES($1,$2,$3,$4,$5,true)',
      [replacement.actorId, `mock-${replacement.actorId}`, 'RM', replacement.rmId, actors.rm.teamId]);
  });
  afterEach(async () => { await api?.stop(); });

  async function registerCustomer() {
    const cifId = actors.customer.cifId;
    const created = await api.request('/onboarding/requests', { method: 'POST', token: await api.tokenFor(), key: 's15-onboard',
      body: { cifRef: cifId, selectedAccountId: eligibleCustomer(cifId).accounts[0].id } });
    expect(created.status).toBe(201);
    const customerToken = await api.tokenFor(actors.customer.actorId);
    const challenge = await api.request('/otp/challenges', { method: 'POST', token: customerToken, body: { purpose: 'SERVICE_CONSENT', operationId: created.body.id } });
    expect(challenge.status).toBe(201);
    const otp = api.deliveries.find(item => item.challengeId === challenge.body.challengeId)!;
    const accepted = await api.request(`/me/onboarding-requests/${created.body.id}/confirm`, { method: 'POST', token: customerToken, key: 's15-consent',
      body: { challengeId: otp.challengeId, code: otp.code } });
    expect(accepted.status).toBe(200);
    return accepted.body.customerId as string;
  }
  const leaderToken = () => api.tokenFor(actors.leader.actorId);

  test('AC4 team/rms items carry rmName equal to each RM actor_id', async () => {
    const response = await api.request('/team/rms', { token: await leaderToken() });
    expect(response.status).toBe(200);
    const byRm = (rmId: string) => response.body.items.find((item: any) => item.rmId === rmId);
    expect(byRm(actors.rm.rmId)).toMatchObject({ rmId: actors.rm.rmId, teamId: actors.rm.teamId, rmName: actors.rm.actorId });
    expect(byRm(replacement.rmId)).toMatchObject({ rmId: replacement.rmId, rmName: replacement.actorId });
  });

  test('AC4 team/rms keeps existing fields unchanged alongside rmName', async () => {
    const response = await api.request('/team/rms', { token: await leaderToken() });
    expect(response.status).toBe(200);
    expect(response.body.items.find((item: any) => item.rmId === actors.rm.rmId)).toEqual({
      rmId: actors.rm.rmId, teamId: actors.rm.teamId, active: true, assigned: 0, reserved: 0, available: 80, capacityLimit: 80,
      rmName: actors.rm.actorId });
  });

  test('AC4 team/customers items carry rmName of the current RM and follow a reassignment', async () => {
    const customerId = await registerCustomer();
    const list = async () => (await api.request('/team/customers', { token: await leaderToken() })).body.items.find((item: any) => item.customerId === customerId);
    expect(await list()).toMatchObject({ customerId, rmId: actors.rm.rmId, assignmentVersion: 1, rmName: actors.rm.actorId });
    await api.dataSource.query('UPDATE rm_assignment_history SET rm_id=$2 WHERE customer_id=$1 AND valid_to IS NULL', [customerId, replacement.rmId]);
    expect(await list()).toMatchObject({ customerId, rmId: replacement.rmId, rmName: replacement.actorId });
  });

  test('AC4 team/customers rmName is null when the assigned RM has no actor row', async () => {
    const customerId = await registerCustomer();
    const orphan = randomUUID();
    await api.dataSource.query('UPDATE rm_assignment_history SET rm_id=$2 WHERE customer_id=$1 AND valid_to IS NULL', [customerId, orphan]);
    const body = (await api.request('/team/customers', { token: await leaderToken() })).body;
    const row = body.items.find((item: any) => item.customerId === customerId);
    expect(row).toMatchObject({ customerId, rmId: orphan });
    expect(row.rmName).toBeNull();
  });
});

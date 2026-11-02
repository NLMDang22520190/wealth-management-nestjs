import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { actors, insertStaff, staff, viaDataSource } from '../helpers/actors.js';
import { eligibleCustomer, startApiFixture } from '../helpers/application.js';

type Fixture = Awaited<ReturnType<typeof startApiFixture>>;

const replacement = staff.replacement;

/** S15 AC4 (API part): team/rms and team/customers expose rmFullName = staff_users.full_name of the RM (R9 S3c; S1 served employee_code as rmFullName). */
describe('S15 AC4 rmFullName on leader team endpoints', () => {
  let api: Fixture;
  beforeEach(async () => {
    api = await startApiFixture();
    await insertStaff(viaDataSource(api.dataSource), replacement);
  });
  afterEach(async () => { await api?.stop(); });

  async function registerCustomer() {
    const cifId = actors.customer.cifId;
    const created = await api.request('/onboarding/requests', { method: 'POST', token: await api.tokenFor(), key: 's15-onboard',
      body: { cifRef: cifId, selectedCasaNo: eligibleCustomer(cifId).accounts[0].id } });
    expect(created.status).toBe(201);
    const customerToken = await api.tokenFor(actors.customer.actorId);
    const challenge = await api.request('/otp/challenges', { method: 'POST', token: customerToken, body: { purpose: 'SERVICE_CONSENT', operationId: created.body.requestId } });
    expect(challenge.status).toBe(201);
    const otp = api.deliveries.find(item => item.challengeId === challenge.body.challengeId)!;
    const accepted = await api.request(`/me/onboarding-requests/${created.body.requestId}/confirm`, { method: 'POST', token: customerToken, key: 's15-consent',
      body: { challengeId: otp.challengeId, code: otp.code } });
    expect(accepted.status).toBe(200);
    return accepted.body.customerId as string;
  }
  const leaderToken = () => api.tokenFor(actors.leader.actorId);

  test('AC4 team/rms items carry rmFullName equal to each RM full_name', async () => {
    const response = await api.request('/team/rms', { token: await leaderToken() });
    expect(response.status).toBe(200);
    const byRm = (rmId: string) => response.body.items.find((item: any) => item.rmId === rmId);
    expect(byRm(actors.rm.rmId)).toMatchObject({ rmId: actors.rm.rmId, teamId: actors.rm.teamId, rmFullName: `Synthetic RM ${actors.rm.actorId}` });
    expect(byRm(replacement.rmId)).toMatchObject({ rmId: replacement.rmId, rmFullName: `Synthetic RM ${replacement.actorId}` });
  });

  test('AC4 team/rms keeps existing fields unchanged alongside rmFullName', async () => {
    const response = await api.request('/team/rms', { token: await leaderToken() });
    expect(response.status).toBe(200);
    expect(response.body.items.find((item: any) => item.rmId === actors.rm.rmId)).toEqual({
      rmId: actors.rm.rmId, teamId: actors.rm.teamId, active: true, assigned: 0, reserved: 0, available: 80, capacityLimit: 80,
      rmFullName: `Synthetic RM ${actors.rm.actorId}` });
  });

  test('AC4 team/customers items carry rmFullName of the current RM and follow a reassignment', async () => {
    const customerId = await registerCustomer();
    const list = async () => (await api.request('/team/customers', { token: await leaderToken() })).body.items.find((item: any) => item.customerId === customerId);
    expect(await list()).toMatchObject({ customerId, rmId: actors.rm.rmId, assignmentVersion: 1, rmFullName: `Synthetic RM ${actors.rm.actorId}` });
    await api.dataSource.query('UPDATE wms.rm_assignments SET rm_id=$2 WHERE customer_id=$1 AND valid_to IS NULL', [customerId, replacement.rmId]);
    expect(await list()).toMatchObject({ customerId, rmId: replacement.rmId, rmFullName: `Synthetic RM ${replacement.actorId}` });
  });

  // Category 4: rm_assignments.rm_id is a FK to staff_users, so "an assigned RM without an actor row" is no longer a reachable
  // state; the database refuses it, hence rmFullName can never be null.
  test('AC4 an assignment to an RM without a staff row is refused by the database (rmFullName is never null)', async () => {
    const customerId = await registerCustomer();
    const orphan = randomUUID();
    await expect(api.dataSource.query('UPDATE wms.rm_assignments SET rm_id=$2 WHERE customer_id=$1 AND valid_to IS NULL', [customerId, orphan]))
      .rejects.toMatchObject({ code: '23503' });
    const body = (await api.request('/team/customers', { token: await leaderToken() })).body;
    const row = body.items.find((item: any) => item.customerId === customerId);
    expect(row).toMatchObject({ customerId, rmId: actors.rm.rmId, rmFullName: `Synthetic RM ${actors.rm.actorId}` });
  });
});

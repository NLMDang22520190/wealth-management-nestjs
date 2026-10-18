import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { actors } from '../helpers/actors.js';
import { eligibleCustomer, expectApiError, startApiFixture } from '../helpers/application.js';

type Fixture = Awaited<ReturnType<typeof startApiFixture>>;
type Registered = { customerId: string; serviceId: string; accountId: string };

describe('S14 W6/FR-04 RM sees cash balance from the P2 investment account', () => {
  let api: Fixture;

  beforeEach(async () => { api = await startApiFixture(); });
  afterEach(async () => { await api?.stop(); });

  async function register(cifId: string = actors.customer.cifId, actorId: string = actors.customer.actorId): Promise<Registered> {
    const created = await api.request('/onboarding/requests', {
      method: 'POST', token: await api.tokenFor(), key: `s14-register-${cifId}`,
      body: { cifRef: cifId, selectedAccountId: eligibleCustomer(cifId).accounts[0].id },
    });
    expect(created.status).toBe(201);
    const challenge = await api.request('/otp/challenges', {
      method: 'POST', token: await api.tokenFor(actorId),
      body: { purpose: 'SERVICE_CONSENT', operationId: created.body.id },
    });
    expect(challenge.status).toBe(201);
    const delivery = api.deliveries.find(item => item.challengeId === challenge.body.challengeId)!;
    const accepted = await api.request(`/me/onboarding-requests/${created.body.id}/confirm`, {
      method: 'POST', token: await api.tokenFor(actorId), key: `s14-consent-${cifId}`,
      body: { challengeId: delivery.challengeId, code: delivery.code },
    });
    expect(accepted.status).toBe(200);
    return accepted.body;
  }

  const listItem = async (customerId: string, token?: string) => {
    const list = await api.request('/rm/customers?page=1&pageSize=50', { token: token ?? await api.tokenFor() });
    expect(list.status).toBe(200);
    return list.body.items.find((item: any) => item.customerId === customerId);
  };

  test('AC1 freshly onboarded customer has a known zero cash "0.00", AVAILABLE, with provenance, on list and detail', async () => {
    const registered = await register();
    const detail = await api.request(`/customers/${registered.customerId}`, { token: await api.tokenFor() });
    expect(detail.status).toBe(200);
    const item = await listItem(registered.customerId);
    expect(item, 'customer present in list').toBeDefined();
    for (const cash of [detail.body.cash, item.cash]) {
      expect(cash).toEqual({
        value: '0.00', asOf: expect.any(String), provenance: expect.stringMatching(/\S/), dataStatus: 'AVAILABLE',
      });
      expect(Number.isNaN(Date.parse(cash.asOf))).toBe(false);
    }
    expect(detail.body.cash.provenance).toBe(item.cash.provenance);
  });

  test('AC2 an investment-account balance set via SQL is returned as the exact decimal string, no float rounding', async () => {
    const registered = await register();
    const other = await register(actors.otherCustomer.cifId, actors.otherCustomer.actorId);
    await api.dataSource.query('UPDATE investment_accounts SET balance=$1 WHERE customer_id=$2', ['1250000.50', registered.customerId]);
    const detail = await api.request(`/customers/${registered.customerId}`, { token: await api.tokenFor() });
    expect(detail.status).toBe(200);
    expect(detail.body.cash).toMatchObject({ value: '1250000.50', dataStatus: 'AVAILABLE' });
    expect((await listItem(registered.customerId)).cash).toMatchObject({ value: '1250000.50', dataStatus: 'AVAILABLE' });
    // another customer's cash is unaffected
    expect((await listItem(other.customerId)).cash).toMatchObject({ value: '0.00', dataStatus: 'AVAILABLE' });

    // a value a JS float cannot hold exactly, and a short scale: both formatted with 2 decimals
    await api.dataSource.query('UPDATE investment_accounts SET balance=$1 WHERE customer_id=$2', ['9007199254740993.07', registered.customerId]);
    await api.dataSource.query('UPDATE investment_accounts SET balance=$1 WHERE customer_id=$2', ['5', other.customerId]);
    expect((await api.request(`/customers/${registered.customerId}`, { token: await api.tokenFor() })).body.cash.value).toBe('9007199254740993.07');
    expect((await listItem(other.customerId)).cash.value).toBe('5.00');
  });

  test('AC3 existing aum semantics are unchanged by cash (no holdings stays UNAVAILABLE, cash not folded in)', async () => {
    const registered = await register();
    await api.dataSource.query('UPDATE investment_accounts SET balance=$1 WHERE customer_id=$2', ['777.00', registered.customerId]);
    const detail = await api.request(`/customers/${registered.customerId}`, { token: await api.tokenFor() });
    expect(detail.status).toBe(200);
    expect(detail.body.cash).toMatchObject({ value: '777.00', dataStatus: 'AVAILABLE' });
    expect(detail.body.aum).toEqual(expect.objectContaining({ value: null, dataStatus: 'UNAVAILABLE' }));
    expect((await listItem(registered.customerId)).aum).toEqual(expect.objectContaining({ value: null, dataStatus: 'UNAVAILABLE' }));
  });

  test('AC4 scope unchanged: old RM still gets 403 on detail and does not see the customer or its cash in the list', async () => {
    const registered = await register();
    await api.dataSource.query('UPDATE investment_accounts SET balance=$1 WHERE customer_id=$2', ['42.00', registered.customerId]);
    const questionnaire = await api.request('/risk-questionnaires/current', { token: await api.tokenFor(actors.customer.actorId) });
    const answers = questionnaire.body.questions.map((q: any) => ({ questionId: q.id, optionId: q.options[2].id }));
    const draft = await api.request('/me/risk-assessments', {
      method: 'POST', token: await api.tokenFor(actors.customer.actorId), key: 's14-draft',
      body: { questionnaireVersion: questionnaire.body.version, answers },
    });
    const challenge = await api.request('/otp/challenges', {
      method: 'POST', token: await api.tokenFor(actors.customer.actorId),
      body: { purpose: 'RISK_PROFILE_CONFIRM', operationId: draft.body.id },
    });
    const delivery = api.deliveries.find(item => item.challengeId === challenge.body.challengeId)!;
    expect((await api.request(`/me/risk-assessments/${draft.body.id}/confirm`, {
      method: 'POST', token: await api.tokenFor(actors.customer.actorId), key: 's14-confirm',
      body: { challengeId: delivery.challengeId, code: delivery.code, expectedCurrentProfileVersion: 0 },
    })).status).toBe(200);
    await api.dataSource.query('INSERT INTO mock_actors(actor_id,subject_id,role,rm_id,team_id,active) VALUES($1,$2,$3,$4,$5,true)',
      ['rm-s14-replacement', 'mock-rm-s14-replacement', 'RM', '22222222-2222-4222-8222-222222222222', actors.rm.teamId]);
    const moved = await api.request(`/customers/${registered.customerId}/rm-assignment`, {
      method: 'POST', token: await api.tokenFor(actors.leader.actorId), key: 's14-transfer',
      body: { targetRmId: '22222222-2222-4222-8222-222222222222', reason: 'S14 scope test', expectedAssignmentVersion: 1 },
    });
    expect(moved.status).toBe(200);
    expectApiError(await api.request(`/customers/${registered.customerId}`, { token: await api.tokenFor(actors.rm.actorId) }), 403, 'FORBIDDEN');
    expect(await listItem(registered.customerId, await api.tokenFor(actors.rm.actorId))).toBeUndefined();
    const newDetail = await api.request(`/customers/${registered.customerId}`, { token: await api.tokenFor('rm-s14-replacement') });
    expect(newDetail.status).toBe(200);
    expect(newDetail.body.cash).toMatchObject({ value: '42.00', dataStatus: 'AVAILABLE' });
  });
});

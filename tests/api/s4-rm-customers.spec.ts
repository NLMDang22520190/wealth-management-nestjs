import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { actors } from '../helpers/actors.js';
import { eligibleCustomer, expectApiError, startApiFixture } from '../helpers/application.js';

type Fixture = Awaited<ReturnType<typeof startApiFixture>>;
type Registered = { customerId: string; serviceId: string; accountId: string };

describe('S4 AC06/AC02 scoped RM customer summaries over real PostgreSQL', () => {
  let api: Fixture;

  beforeEach(async () => { api = await startApiFixture(); });
  afterEach(async () => { await api?.stop(); });

  async function register(cifId: string = actors.customer.cifId, actorId: string = actors.customer.actorId): Promise<Registered> {
    const created = await api.request('/onboarding/requests', {
      method: 'POST', token: await api.tokenFor(), key: `s4-register-${cifId}`,
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
      method: 'POST', token: await api.tokenFor(actorId), key: `s4-consent-${cifId}`,
      body: { challengeId: delivery.challengeId, code: delivery.code },
    });
    expect(accepted.status).toBe(200);
    return accepted.body;
  }

  async function activateRisk(actorId: string, customerId: string) {
    const questionnaire = await api.request('/risk-questionnaires/current', { token: await api.tokenFor(actorId) });
    expect(questionnaire.status).toBe(200);
    const answers = questionnaire.body.questions.map((question: any) => ({ questionId: question.id, optionId: question.options[2].id }));
    const draft = await api.request('/me/risk-assessments', {
      method: 'POST', token: await api.tokenFor(actorId), key: `s4-draft-${customerId}`,
      body: { questionnaireVersion: questionnaire.body.version, answers },
    });
    expect(draft.status).toBe(201);
    const challenge = await api.request('/otp/challenges', {
      method: 'POST', token: await api.tokenFor(actorId),
      body: { purpose: 'RISK_PROFILE_CONFIRM', operationId: draft.body.id },
    });
    expect(challenge.status).toBe(201);
    const delivery = api.deliveries.find(item => item.challengeId === challenge.body.challengeId)!;
    const confirmed = await api.request(`/me/risk-assessments/${draft.body.id}/confirm`, {
      method: 'POST', token: await api.tokenFor(actorId), key: `s4-confirm-${customerId}`,
      body: { challengeId: delivery.challengeId, code: delivery.code, expectedCurrentProfileVersion: 0 },
    });
    expect(confirmed.status).toBe(200);
    return confirmed.body;
  }

  async function addHolding(customerId: string, productId: string, marketValue: string, asOf: string, provenance = 'SYNTHETIC_P3_READ_BRIDGE') {
    await api.dataSource.query(`INSERT INTO holdings_read_snapshots
      (id,customer_id,product_id,product_risk,asset_class,quantity,market_value,as_of,provenance)
      VALUES($1,$2,$3,3,'FUND',1,$4,$5,$6)`, [randomUUID(), customerId, productId, marketValue, asOf, provenance]);
  }

  test('AC06 current RM list and detail return only current assignments and ignore injected rmId scope', async () => {
    const first = await register();
    await register(actors.otherCustomer.cifId, actors.otherCustomer.actorId);
    const list = await api.request('/rm/customers?page=1&pageSize=10&rmId=foreign-injected', { token: await api.tokenFor() });
    expect(list.status, 'current RM list route must be implemented').toBe(200);
    expect(list.body).toEqual(expect.objectContaining({ page: 1, pageSize: 10, total: expect.any(Number), items: expect.any(Array) }));
    expect(list.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ customerId: first.customerId, name: expect.any(String), currentAssignment: expect.objectContaining({ rmId: actors.rm.rmId }) }),
    ]));
    expect(list.body.items.every((item: any) => item.currentAssignment.rmId === actors.rm.rmId)).toBe(true);
    const detail = await api.request(`/customers/${first.customerId}`, { token: await api.tokenFor() });
    expect(detail.status).toBe(200);
    expect(detail.body).toEqual(expect.objectContaining({ customerId: first.customerId, name: expect.any(String), serviceStatus: expect.any(String), currentAssignment: expect.objectContaining({ rmId: actors.rm.rmId }) }));
    expectApiError(await api.request(`/customers/${first.customerId}`, { token: await api.tokenFor(actors.otherCustomer.actorId) }), 403, 'FORBIDDEN');
  });

  test('AC06 filters, bounded paging, stable id ties and AUM sort use the full authorized set before paging', async () => {
    const first = await register();
    const second = await register(actors.otherCustomer.cifId, actors.otherCustomer.actorId);
    await addHolding(first.customerId, 's4-aum-low', '100.00', '2026-01-15T04:00:00.000Z');
    await addHolding(second.customerId, 's4-aum-high', '900.00', '2026-01-15T04:00:00.000Z');
    const sortedPage = await api.request('/rm/customers?page=1&pageSize=1&sort=aum&direction=desc', { token: await api.tokenFor() });
    expect(sortedPage.status).toBe(200);
    expect(sortedPage.body.items).toHaveLength(1);
    expect(sortedPage.body.items[0].customerId).toBe(second.customerId);
    const tie = await api.request('/rm/customers?page=1&pageSize=10&sort=name&direction=asc', { token: await api.tokenFor() });
    expect(tie.status).toBe(200);
    expect(tie.body.items.map((item: any) => item.customerId)).toEqual([...tie.body.items].sort((a: any, b: any) => a.name.localeCompare(b.name) || a.customerId.localeCompare(b.customerId)).map((item: any) => item.customerId));
    expect((await api.request('/rm/customers?risk=CONSERVATIVE&serviceStatus=ACTIVE&name=synthetic', { token: await api.tokenFor() })).status).toBe(200);
    expectApiError(await api.request('/rm/customers?page=0', { token: await api.tokenFor() }), 400, 'VALIDATION_ERROR');
    expectApiError(await api.request('/rm/customers?sort=sql-injection', { token: await api.tokenFor() }), 400, 'VALIDATION_ERROR');
  });

  test('AC06 P3/P4 summaries preserve unavailable versus known zero and expose asOf/provenance', async () => {
    const registered = await register();
    const profile = await activateRisk(actors.customer.actorId, registered.customerId);
    await addHolding(registered.customerId, 's4-fund', '1250000.50', '2026-01-15T04:59:00.000Z');
    await api.dataSource.query(`INSERT INTO proposals(id,customer_id,author_rm_id,status,created_at,updated_at)
      VALUES($1,$2,$3,'PENDING_APPROVAL',$4,$4)`, [randomUUID(), registered.customerId, actors.rm.rmId, api.state.now]);
    const detail = await api.request(`/customers/${registered.customerId}`, { token: await api.tokenFor() });
    expect(detail.status).toBe(200);
    expect(detail.body.currentRisk).toMatchObject({ id: profile.id, valid: true, expiresAt: expect.any(String) });
    expect(detail.body.aum).toEqual(expect.objectContaining({ value: '1250000.50', asOf: '2026-01-15T04:59:00.000Z', provenance: 'SYNTHETIC_P3_READ_BRIDGE', dataStatus: 'AVAILABLE' }));
    expect(detail.body.driftAlerts).toEqual(expect.objectContaining({ count: expect.any(Number), asOf: expect.any(String), dataStatus: expect.any(String) }));
    expect(detail.body.pendingProposals).toEqual(expect.objectContaining({ count: 1, asOf: expect.any(String), dataStatus: 'AVAILABLE' }));
    const empty = await register(actors.otherCustomer.cifId, actors.otherCustomer.actorId);
    const emptyDetail = await api.request(`/customers/${empty.customerId}`, { token: await api.tokenFor() });
    expect(emptyDetail.status).toBe(200);
    expect(emptyDetail.body.aum).toEqual(expect.objectContaining({ value: null, dataStatus: 'UNAVAILABLE' }));
    expect(emptyDetail.body.pendingProposals).toEqual(expect.objectContaining({ count: 0, dataStatus: 'AVAILABLE' }));
    expect(emptyDetail.body.aum.value).not.toBe(0);
  });

  test('AC05/AC06 current assignment revocation removes old RM list/detail access immediately after transfer', async () => {
    const registered = await register();
    await activateRisk(actors.customer.actorId, registered.customerId); // S3 transfer contract requires an ACTIVE service
    await api.dataSource.query('INSERT INTO mock_actors(actor_id,subject_id,role,rm_id,team_id,active) VALUES($1,$2,$3,$4,$5,true)',
      ['rm-s4-replacement', 'mock-rm-s4-replacement', 'RM', '22222222-2222-4222-8222-222222222222', actors.rm.teamId]);
    const moved = await api.request(`/customers/${registered.customerId}/rm-assignment`, {
      method: 'POST', token: await api.tokenFor(actors.leader.actorId), key: 's4-transfer',
      body: { targetRmId: '22222222-2222-4222-8222-222222222222', reason: 'S4 ownership test', expectedAssignmentVersion: 1 },
    });
    expect(moved.status).toBe(200);
    expectApiError(await api.request('/rm/customers', { token: await api.tokenFor(actors.rm.actorId) }), 403, 'FORBIDDEN');
    expectApiError(await api.request(`/customers/${registered.customerId}`, { token: await api.tokenFor(actors.rm.actorId) }), 403, 'FORBIDDEN');
    const replacementList = await api.request('/rm/customers', { token: await api.tokenFor('rm-s4-replacement') });
    expect(replacementList.status).toBe(200);
    expect(replacementList.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ customerId: registered.customerId })]));
  });

  test('AC02 registered Core lookup checks current RM permission, deterministic rate limit, and impossible calendar DOB', async () => {
    await register();
    await api.dataSource.query('INSERT INTO mock_actors(actor_id,subject_id,role,rm_id,team_id,active) VALUES($1,$2,$3,$4,$5,true)',
      ['rm-s4-foreign', 'mock-rm-s4-foreign', 'RM', '44444444-4444-4444-8444-444444444444', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']);
    expectApiError(await api.request('/onboarding/customer-lookup', { method: 'POST', token: await api.tokenFor('rm-s4-foreign'), body: { cifRef: actors.customer.cifId } }), 403, 'FORBIDDEN');
    for (let attempt = 0; attempt < 30; attempt++) {
      const response = await api.request('/onboarding/customer-lookup', { method: 'POST', token: await api.tokenFor(), body: { cifRef: actors.customer.cifId } });
      expect(response.status).toBe(200);
    }
    expectApiError(await api.request('/onboarding/customer-lookup', { method: 'POST', token: await api.tokenFor(), body: { cifRef: actors.customer.cifId } }), 429, 'RATE_LIMITED');
    api.state.core = { ...eligibleCustomer('00000999'), dateOfBirth: '2000-02-30' };
    expectApiError(await api.request('/onboarding/requests', { method: 'POST', token: await api.tokenFor(), key: 's4-impossible-dob', body: { cifRef: '00000999', selectedAccountId: 'account-00000999' } }), 422, 'CUSTOMER_INELIGIBLE');
  });
});

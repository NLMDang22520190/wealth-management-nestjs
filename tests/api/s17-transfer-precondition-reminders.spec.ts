import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { actors } from '../helpers/actors.js';
import { eligibleCustomer, expectApiError, startApiFixture } from '../helpers/application.js';

type Fixture = Awaited<ReturnType<typeof startApiFixture>>;

const replacementRm = '22222222-2222-4222-8222-222222222222';
const foreignRm = { actorId: 'rm-s17-foreign', rmId: '44444444-4444-4444-8444-444444444444', teamId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
const foreignLeader = 'leader-s17-foreign';
const gamma = { actorId: 'customer-gamma', cifId: '00000103' };
const HOUR = 3_600_000;

/**
 * S17 (spec R4b): transfer precondition (ACTIVE service + valid risk profile) and in-app risk-survey reminders.
 * Customers: alpha = valid profile, beta = no profile (team A), gamma = no profile (foreign team B).
 */
describe('S17 transfer precondition and risk-survey reminders on real PostgreSQL', () => {
  let api: Fixture;
  beforeEach(async () => {
    api = await startApiFixture();
    await api.dataSource.query('INSERT INTO mock_actors(actor_id,subject_id,role,cif_id,active) VALUES($1,$2,$3,$4,true)',
      [gamma.actorId, `mock-${gamma.actorId}`, 'CUSTOMER', gamma.cifId]);
    await api.dataSource.query('INSERT INTO mock_actors(actor_id,subject_id,role,rm_id,team_id,active) VALUES($1,$2,$3,$4,$5,true)',
      ['rm-s17-replacement', 'mock-rm-s17-replacement', 'RM', replacementRm, actors.rm.teamId]);
    await api.dataSource.query('INSERT INTO mock_actors(actor_id,subject_id,role,rm_id,team_id,active) VALUES($1,$2,$3,$4,$5,true)',
      [foreignRm.actorId, `mock-${foreignRm.actorId}`, 'RM', foreignRm.rmId, foreignRm.teamId]);
    await api.dataSource.query("INSERT INTO mock_actors(actor_id,subject_id,role,team_id,active) VALUES($1,$2,'LEADER',$3,true)",
      [foreignLeader, `mock-${foreignLeader}`, foreignRm.teamId]);
  });
  afterEach(async () => { await api?.stop(); });

  async function register(cifId: string, actorId: string, rmActorId: string = actors.rm.actorId): Promise<string> {
    if (cifId === gamma.cifId) api.state.core = eligibleCustomer(cifId);
    const created = await api.request('/onboarding/requests', { method: 'POST', token: await api.tokenFor(rmActorId), key: `s17-onboard-${cifId}`,
      body: { cifRef: cifId, selectedAccountId: eligibleCustomer(cifId).accounts[0].id } });
    expect(created.status).toBe(201);
    const token = await api.tokenFor(actorId);
    const challenge = await api.request('/otp/challenges', { method: 'POST', token, body: { purpose: 'SERVICE_CONSENT', operationId: created.body.id } });
    expect(challenge.status).toBe(201);
    const otp = api.deliveries.find(item => item.challengeId === challenge.body.challengeId)!;
    const accepted = await api.request(`/me/onboarding-requests/${created.body.id}/confirm`, { method: 'POST', token, key: `s17-consent-${cifId}`,
      body: { challengeId: otp.challengeId, code: otp.code } });
    expect(accepted.status).toBe(200);
    return accepted.body.customerId as string;
  }
  async function confirmRisk(actorId: string, tag: string) {
    const token = await api.tokenFor(actorId);
    const questionnaire = await api.request('/risk-questionnaires/current', { token });
    expect(questionnaire.status).toBe(200);
    const draft = await api.request('/me/risk-assessments', { method: 'POST', token, key: `s17-draft-${tag}`, body: {
      questionnaireVersion: questionnaire.body.version,
      answers: questionnaire.body.questions.map((q: any) => ({ questionId: q.id, optionId: q.options[2].id })) } });
    expect(draft.status).toBe(201);
    const challenge = await api.request('/otp/challenges', { method: 'POST', token, body: { purpose: 'RISK_PROFILE_CONFIRM', operationId: draft.body.id } });
    expect(challenge.status).toBe(201);
    const otp = api.deliveries.find(item => item.challengeId === challenge.body.challengeId)!;
    const confirmed = await api.request(`/me/risk-assessments/${draft.body.id}/confirm`, { method: 'POST', token, key: `s17-confirm-${tag}`,
      body: { challengeId: otp.challengeId, code: otp.code, expectedCurrentProfileVersion: 0 } });
    expect(confirmed.status).toBe(200);
  }
  const alpha = async () => { const id = await register(actors.customer.cifId, actors.customer.actorId); await confirmRisk(actors.customer.actorId, 'alpha'); return id; };
  const beta = () => register(actors.otherCustomer.cifId, actors.otherCustomer.actorId);
  const leaderToken = () => api.tokenFor(actors.leader.actorId);
  async function transfer(customerId: string, key = randomUUID()) {
    return api.request(`/customers/${customerId}/rm-assignment`, { method: 'POST', token: await leaderToken(), key,
      body: { targetRmId: replacementRm, reason: 'S17 transfer', expectedAssignmentVersion: 1 } });
  }
  async function remind(body?: unknown, token?: string) {
    return api.request('/team/risk-survey-reminders', { method: 'POST', token: token ?? await leaderToken(), ...(body === undefined ? {} : { body }) });
  }
  async function teamItem(customerId: string) {
    const list = await api.request('/team/customers?page=1&pageSize=50', { token: await leaderToken() });
    expect(list.status).toBe(200);
    return list.body.items.find((item: any) => item.customerId === customerId);
  }
  const notifications = async (actorId: string) => api.request('/notifications', { token: await api.tokenFor(actorId) });
  async function reminderAudits() {
    return api.dataSource.query("SELECT * FROM audit_events WHERE action LIKE 'RISK_SURVEY_REMINDER%' AND outcome='SUCCESS' ORDER BY created_at, id");
  }
  async function assignmentEffects(customerId: string) {
    return {
      history: await api.dataSource.query('SELECT id,rm_id,version,valid_to FROM rm_assignment_history WHERE customer_id=$1 ORDER BY version', [customerId]),
      audits: await api.dataSource.query("SELECT id FROM audit_events WHERE action='RM_ASSIGNMENT_CHANGED'"),
      events: await api.dataSource.query("SELECT id FROM outbox_events WHERE event_type='RmAssignmentChanged'"),
      cancelled: await api.dataSource.query("SELECT id FROM proposals WHERE customer_id=$1 AND status='CANCELLED'", [customerId]),
    };
  }
  async function seedPendingProposal(customerId: string) {
    await api.dataSource.query("INSERT INTO proposals(id,customer_id,author_rm_id,status,created_at,updated_at) VALUES($1,$2,$3,'PENDING_APPROVAL',$4,$4)",
      [randomUUID(), customerId, actors.rm.rmId, api.state.now]);
  }

  test('AC-P2 transfer of an ACTIVE-service customer without any risk profile is 422 RISK_PROFILE_REQUIRED with no state change', async () => {
    const customerId = await beta();
    await api.dataSource.query("UPDATE wealth_services SET status='ACTIVE' WHERE customer_id=$1", [customerId]); // ACTIVE but never answered the survey
    await seedPendingProposal(customerId);
    const before = await assignmentEffects(customerId);
    expectApiError(await transfer(customerId), 422, 'RISK_PROFILE_REQUIRED');
    expect(await assignmentEffects(customerId)).toEqual(before);
    expect(before.history).toHaveLength(1);
    expect(before.history[0].version).toBe(1);
    expect(before.cancelled).toHaveLength(0);
    const [pending] = await api.dataSource.query("SELECT count(*)::integer AS n FROM proposals WHERE customer_id=$1 AND status='PENDING_APPROVAL'", [customerId]);
    expect(pending.n).toBe(1);
  });

  test('AC-P2 transfer with an EXPIRED risk profile is 422 RISK_PROFILE_REQUIRED, unchanged', async () => {
    const customerId = await alpha();
    await seedPendingProposal(customerId);
    api.state.now = new Date(api.state.now.getTime() + 25 * HOUR); // profile is valid for 24h
    const before = await assignmentEffects(customerId);
    expectApiError(await transfer(customerId), 422, 'RISK_PROFILE_REQUIRED');
    expect(await assignmentEffects(customerId)).toEqual(before);
    expect(before.cancelled).toHaveLength(0);
  });

  test('AC-P2 transfer with a valid risk profile still succeeds (200, changed, version 2)', async () => {
    const customerId = await alpha();
    const moved = await transfer(customerId);
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ customerId, rmId: replacementRm, version: 2, changed: true });
  });

  test('AC-P1 (characterization) transfer with an inactive service is still 422 SERVICE_INACTIVE, taking precedence over the profile check', async () => {
    const customerId = await beta(); // consent given, no risk profile => service not ACTIVE
    expectApiError(await transfer(customerId), 422, 'SERVICE_INACTIVE');
  });

  test('AC-P3 team/customers items carry riskProfileValid and lastReminderAt (null until reminded, then ISO)', async () => {
    const a = await alpha();
    const b = await beta();
    expect(await teamItem(a)).toMatchObject({ customerId: a, riskProfileValid: true, lastReminderAt: null });
    expect(await teamItem(b)).toMatchObject({ customerId: b, riskProfileValid: false, lastReminderAt: null });
    const sent = await remind({ customerIds: [b] });
    expect(sent.status).toBe(200);
    const item = await teamItem(b);
    expect(item.lastReminderAt).toBe(api.state.now.toISOString());
    expect((await teamItem(a)).lastReminderAt).toBeNull();
    api.state.now = new Date(api.state.now.getTime() + 25 * HOUR); // alpha's profile expires
    expect((await teamItem(a)).riskProfileValid).toBe(false);
  });

  test('AC-N1 bulk reminder (no ids) sends only to team customers without a valid profile; leaves valid and foreign-team customers alone', async () => {
    await alpha();
    const b = await beta();
    await register(gamma.cifId, gamma.actorId, foreignRm.actorId);
    const response = await remind();
    expect(response.status).toBe(200);
    expect(response.body.sent).toBe(1);
    expect(Array.isArray(response.body.skipped)).toBe(true);
    expect(response.body.skipped.map((s: any) => s.customerId)).not.toContain(b);
    expect((await notifications(actors.otherCustomer.actorId)).body.items).toHaveLength(1);
    expect((await notifications(actors.customer.actorId)).body.items).toHaveLength(0);
    expect((await notifications(gamma.actorId)).body.items).toHaveLength(0);
    const audits = await reminderAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0].actor_id).toBe(actors.leader.actorId);
    expect(JSON.stringify(audits[0].payload) + audits[0].resource_id).toContain(b);
  });

  test('AC-N1 explicit ids: valid profile -> skipped PROFILE_VALID; repeat within 24h -> skipped RECENTLY_REMINDED; after 24h it sends again', async () => {
    const a = await alpha();
    const b = await beta();
    const first = await remind({ customerIds: [a, b] });
    expect(first.status).toBe(200);
    expect(first.body.sent).toBe(1);
    expect(first.body.skipped).toContainEqual({ customerId: a, reason: 'PROFILE_VALID' });
    const second = await remind({ customerIds: [b] });
    expect(second.status).toBe(200);
    expect(second.body.sent).toBe(0);
    expect(second.body.skipped).toContainEqual({ customerId: b, reason: 'RECENTLY_REMINDED' });
    const bulk = await remind();
    expect(bulk.body.sent).toBe(0);
    api.state.now = new Date(api.state.now.getTime() + 24 * HOUR);
    const third = await remind({ customerIds: [b] });
    expect(third.status).toBe(200);
    expect(third.body.sent).toBe(1);
    expect(third.body.skipped).toEqual([]);
    expect((await notifications(actors.otherCustomer.actorId)).body.items).toHaveLength(2);
    expect(await reminderAudits()).toHaveLength(2); // one success audit event per sent reminder, none for skipped
  });

  test('AC-N1 authorization and validation: foreign-team id 403 (nothing sent), non-LEADER 403, invalid ids 400', async () => {
    const b = await beta();
    const g = await register(gamma.cifId, gamma.actorId, foreignRm.actorId);
    expectApiError(await remind({ customerIds: [b, g] }), 403, 'FORBIDDEN');
    expect((await notifications(actors.otherCustomer.actorId)).body.items).toHaveLength(0); // all-or-nothing
    expect(await reminderAudits()).toHaveLength(0);
    for (const actorId of [actors.rm.actorId, actors.customer.actorId]) expectApiError(await remind({}, await api.tokenFor(actorId)), 403, 'FORBIDDEN');
    expectApiError(await remind({ customerIds: ['not-a-uuid'] }), 400, 'VALIDATION_ERROR');
    expectApiError(await remind({ customerIds: 'x' }), 400, 'VALIDATION_ERROR');
    expectApiError(await remind({ customerIds: [b], extra: 1 }), 400, 'VALIDATION_ERROR');
  });

  test('AC-N2 customer sees only own reminders, newest first, with kind/message/readAt; can mark own as read; foreign id 404; RM/LEADER 403', async () => {
    const b = await beta();
    await register(gamma.cifId, gamma.actorId, foreignRm.actorId);
    expect((await remind({ customerIds: [b] })).body.sent).toBe(1);
    api.state.now = new Date(api.state.now.getTime() + 24 * HOUR);
    expect((await remind({ customerIds: [b] })).body.sent).toBe(1);
    const listed = await notifications(actors.otherCustomer.actorId);
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(2);
    expect(listed.body.items[0]).toMatchObject({ id: expect.any(String), kind: 'RISK_SURVEY_REMINDER', readAt: null });
    expect(listed.body.items[0].message.length).toBeGreaterThan(0);
    expect(new Date(listed.body.items[0].createdAt).getTime()).toBeGreaterThan(new Date(listed.body.items[1].createdAt).getTime());
    expect((await notifications(gamma.actorId)).body.items).toEqual([]);
    expect((await notifications(actors.customer.actorId)).body.items).toEqual([]);

    const target = listed.body.items[0].id;
    expectApiError(await api.request(`/notifications/${target}/read`, { method: 'POST', token: await api.tokenFor(gamma.actorId) }), 404, 'NOT_FOUND');
    expect((await notifications(actors.otherCustomer.actorId)).body.items[0].readAt).toBeNull();
    const read = await api.request(`/notifications/${target}/read`, { method: 'POST', token: await api.tokenFor(actors.otherCustomer.actorId) });
    expect(read.status).toBe(200);
    const after = (await notifications(actors.otherCustomer.actorId)).body.items;
    expect(after.find((n: any) => n.id === target).readAt).toBe(api.state.now.toISOString());
    expect(after.find((n: any) => n.id !== target).readAt).toBeNull();

    for (const actorId of [actors.rm.actorId, actors.leader.actorId]) expectApiError(await notifications(actorId), 403, 'FORBIDDEN');
  });
});

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { actors } from '../helpers/actors.js';
import { eligibleCustomer, expectApiError, startApiFixture } from '../helpers/application.js';
import type { OtpDelivery } from '../helpers/application.js';

type Fixture = Awaited<ReturnType<typeof startApiFixture>>;
type Answer = { questionId: string; optionId: string };
type Questionnaire = { version: string; questions: Array<{ id: string; text: string; options: Array<{ id: string; text: string }> }> };
const HOUR = 3_600_000;
const matrix = {
  CONSERVATIVE: { maxProductRisk: 2, allocation: { cash: 10, deposit: 50, bond: 30, fund: 10 } },
  BALANCED: { maxProductRisk: 3, allocation: { cash: 5, deposit: 30, bond: 30, fund: 35 } },
  GROWTH: { maxProductRisk: 5, allocation: { cash: 5, deposit: 15, bond: 20, fund: 60 } },
};

describe('S2 AC04/AC08 risk lifecycle over HTTP and real PostgreSQL', () => {
  let api: Fixture;
  beforeEach(async () => { api = await startApiFixture(); });
  afterEach(async () => { await api?.stop(); });

  async function register(cifId: string = actors.customer.cifId, actorId: string = actors.customer.actorId) {
    const created = await api.request('/onboarding/requests', { method: 'POST', token: await api.tokenFor(), key: `register-${cifId}`,
      body: { cifRef: cifId, selectedAccountId: eligibleCustomer(cifId).accounts[0].id } });
    expect(created.status).toBe(201);
    const consentOtp = await challenge(created.body.id, 'SERVICE_CONSENT', actorId);
    const accepted = await api.request(`/me/onboarding-requests/${created.body.id}/confirm`, { method: 'POST', token: await api.tokenFor(actorId),
      key: `consent-${cifId}`, body: { challengeId: consentOtp.challengeId, code: consentOtp.code } });
    expect(accepted.status).toBe(200);
    return { ...accepted.body, consentOtp };
  }
  async function questionnaire(): Promise<Questionnaire> {
    const response = await api.request('/risk-questionnaires/current', { token: await api.tokenFor(actors.customer.actorId) });
    expect(response.status, 'versioned questionnaire must be available to the registered customer').toBe(200);
    return response.body;
  }
  function answersFor(value: Questionnaire, score: number): Answer[] {
    let remaining = score - 10;
    return value.questions.map(question => {
      const extra = Math.min(4, remaining);
      remaining -= extra;
      return { questionId: question.id, optionId: question.options[extra].id };
    });
  }
  async function draft(value: Questionnaire, score: number, key = `draft-${score}`) {
    const response = await api.request('/me/risk-assessments', { method: 'POST', token: await api.tokenFor(actors.customer.actorId), key,
      body: { questionnaireVersion: value.version, answers: answersFor(value, score) } });
    expect(response.status, 'risk draft is a preview, never an implicit confirmation').toBe(201);
    return response.body;
  }
  async function challenge(id: string, purpose = 'RISK_PROFILE_CONFIRM', actorId: string = actors.customer.actorId): Promise<OtpDelivery> {
    const response = await api.request('/otp/challenges', { method: 'POST', token: await api.tokenFor(actorId), body: { purpose, operationId: id } });
    expect(response.status).toBe(201);
    expect(response.body.code).toBeUndefined();
    const delivered = api.deliveries.find(item => item.challengeId === response.body.challengeId);
    expect(delivered).toMatchObject({ actorId, purpose, operationId: id });
    return delivered!;
  }
  async function confirm(value: any, otp: Pick<OtpDelivery, 'challengeId' | 'code'>, key = `confirm-${value.id}`, actorId: string = actors.customer.actorId, extra: Record<string, unknown> = {}) {
    return api.request(`/me/risk-assessments/${value.id}/confirm`, { method: 'POST', token: await api.tokenFor(actorId), key,
      headers: { 'user-agent': 'Synthetic risk device', 'x-request-id': 's2-risk-confirm' },
      body: { challengeId: otp.challengeId, code: otp.code, expectedCurrentProfileVersion: value.expectedCurrentProfileVersion, ...extra } });
  }
  async function profile(actorId: string = actors.customer.actorId) {
    const response = await api.request('/me/risk-profile', { token: await api.tokenFor(actorId) });
    expect(response.status).toBe(200);
    return response.body;
  }
  async function history(path = '/me/risk-profile/history', actorId: string = actors.customer.actorId, page = 1, pageSize = 10) {
    const response = await api.request(`${path}?page=${page}&pageSize=${pageSize}`, { token: await api.tokenFor(actorId) });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ page, pageSize, total: expect.any(Number), items: expect.any(Array) });
    return response.body;
  }
  async function service(id: string) { return (await api.dataSource.query('SELECT * FROM wealth_services WHERE id=$1', [id]))[0]; }
  async function confirmedRows(customerId: string) { return api.dataSource.query('SELECT * FROM risk_profiles WHERE customer_id=$1 ORDER BY version', [customerId]); }
  async function riskEvents() { return api.dataSource.query("SELECT * FROM outbox_events WHERE event_type IN ('RiskProfileConfirmed','RiskHoldingsCheckRequested') ORDER BY id"); }

  test('AC04 versioned ten-question preview scores all six matrix boundaries and rejects missing, duplicate, forged or client-scored answers', async () => {
    const registered = await register();
    const value = await questionnaire();
    expect(value.version).toEqual(expect.any(String));
    expect(value.version.length).toBeGreaterThan(0);
    expect(value.questions).toHaveLength(10);
    expect(new Set(value.questions.map(question => question.id)).size).toBe(10);
    for (const question of value.questions) {
      expect(question.text.length).toBeGreaterThan(0);
      expect(question.options).toHaveLength(5);
      expect(new Set(question.options.map(option => option.id)).size).toBe(5);
      for (const option of question.options) {
        expect(option.text.length).toBeGreaterThan(0);
        expect(option).not.toHaveProperty('points');
        expect(option).not.toHaveProperty('score');
      }
    }
    for (const [score, category] of [[10, 'CONSERVATIVE'], [20, 'CONSERVATIVE'], [21, 'BALANCED'], [35, 'BALANCED'], [36, 'GROWTH'], [50, 'GROWTH']] as const) {
      const preview = await draft(value, score);
      expect(preview).toMatchObject({ id: expect.any(String), questionnaireVersion: value.version, answers: answersFor(value, score),
        score, category, ...matrix[category], expectedCurrentProfileVersion: 0, payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(preview.expiresAt).toBe(new Date(api.state.now.getTime() + 24 * HOUR).toISOString());
    }
    const originalDraft = await draft(value, 10, 'draft-10');
    expect(await draft(value, 10, 'draft-10')).toEqual(originalDraft);
    expectApiError(await api.request('/me/risk-assessments', { method: 'POST', token: await api.tokenFor(actors.customer.actorId), key: 'draft-10',
      body: { questionnaireVersion: value.version, answers: answersFor(value, 50) } }), 409, 'IDEMPOTENCY_CONFLICT');
    const valid = answersFor(value, 20);
    const invalid = [valid.slice(0, 9), [...valid, valid[0]], [valid[0], valid[0], ...valid.slice(2)],
      [{ ...valid[0], optionId: 'forged-option' }, ...valid.slice(1)], [{ questionId: 'forged-question', optionId: valid[0].optionId }, ...valid.slice(1)]];
    for (let index = 0; index < invalid.length; index++) expectApiError(await api.request('/me/risk-assessments', {
      method: 'POST', token: await api.tokenFor(actors.customer.actorId), key: `invalid-${index}`, body: { questionnaireVersion: value.version, answers: invalid[index] },
    }), 400, 'VALIDATION_ERROR');
    for (const [index, forged] of [{ score: 9 }, { score: 51 }, { category: 'GROWTH' }, { maxProductRisk: 5 }, { allocation: matrix.GROWTH.allocation }, { answers: valid.map(answer => ({ ...answer, points: 5 })) }].entries()) {
      expectApiError(await api.request('/me/risk-assessments', { method: 'POST', token: await api.tokenFor(actors.customer.actorId), key: `forged-${index}`,
        body: { questionnaireVersion: value.version, answers: valid, ...forged } }), 400, 'VALIDATION_ERROR');
    }
    expectApiError(await api.request('/me/risk-assessments', { method: 'POST', token: await api.tokenFor(actors.customer.actorId), key: 'obsolete-version',
      body: { questionnaireVersion: 'unpublished-version', answers: valid } }), 409, 'QUESTIONNAIRE_VERSION_MISMATCH');
    expect((await profile()).current).toBeNull();
    expect((await history()).items).toEqual([]);
    expect(await confirmedRows(registered.customerId)).toEqual([]);
    expect(await service(registered.serviceId)).toMatchObject({ status: 'PENDING_RISK_ASSESSMENT', current_risk_profile_id: null });
  });

  test('AC04/AC08 only own immutable draft-bound OTP activates service; invalid, expired, edited, replay and audit-failed confirmations preserve state', async () => {
    const registered = await register();
    const value = await questionnaire();
    const preview = await draft(value, 35);
    const edited = await draft(value, 36, 'edited-answers-new-draft');
    expect(edited.id).not.toBe(preview.id);
    expect(edited.payloadHash).not.toBe(preview.payloadHash);
    const otp = await challenge(preview.id);
    const [binding] = await api.dataSource.query('SELECT * FROM otp_challenges WHERE id=$1', [otp.challengeId]);
    expect(binding).toMatchObject({ actor_id: actors.customer.actorId, purpose: 'RISK_PROFILE_CONFIRM', operation_id: preview.id, payload_hash: preview.payloadHash, consumed_at: null });
    expectApiError(await api.request('/otp/challenges', { method: 'POST', token: await api.tokenFor(actors.otherCustomer.actorId), body: { purpose: 'RISK_PROFILE_CONFIRM', operationId: preview.id } }), 403, 'FORBIDDEN');
    expectApiError(await api.request('/otp/challenges', { method: 'POST', token: await api.tokenFor(actors.customer.actorId), body: { purpose: 'SERVICE_CONSENT', operationId: preview.id } }), 400, 'OTP_PURPOSE_MISMATCH');
    expectApiError(await confirm(preview, otp, 'foreign-confirm', actors.otherCustomer.actorId), 403, 'FORBIDDEN');
    expectApiError(await confirm(preview, registered.consentOtp, 'wrong-purpose'), 409, 'OTP_BINDING_MISMATCH');
    expectApiError(await confirm(edited, otp, 'old-challenge-edited-answers'), 409, 'OTP_BINDING_MISMATCH');
    expectApiError(await confirm(preview, otp, 'forged-base-version', actors.customer.actorId, { expectedCurrentProfileVersion: 99 }), 409, 'RISK_PROFILE_STALE');
    expectApiError(await confirm(preview, { ...otp, code: otp.code === '000000' ? '000001' : '000000' }, 'invalid-code'), 400, 'OTP_INVALID');
    expectApiError(await confirm(preview, otp, 'forged-confirm', actors.customer.actorId, { score: 50 }), 400, 'VALIDATION_ERROR');
    api.state.now = new Date(otp.expiresAt);
    expectApiError(await confirm(preview, otp, 'expired-code'), 410, 'OTP_EXPIRED');
    expect((await profile()).current).toBeNull();
    expect(await service(registered.serviceId)).toMatchObject({ status: 'PENDING_RISK_ASSESSMENT', current_risk_profile_id: null });
    const fresh = await challenge(preview.id);
    const beforeEvents = await riskEvents();
    const beforeDraft = (await api.dataSource.query('SELECT * FROM risk_assessment_drafts WHERE id=$1', [preview.id]))[0];
    await api.dataSource.query('ALTER TABLE audit_events ADD CONSTRAINT s2_audit_failure CHECK (false) NOT VALID');
    try {
      expectApiError(await confirm(preview, fresh, 'atomic-risk'), 500, 'INTERNAL_ERROR');
      expect(await confirmedRows(registered.customerId)).toEqual([]);
      expect(await service(registered.serviceId)).toMatchObject({ status: 'PENDING_RISK_ASSESSMENT', current_risk_profile_id: null });
      expect(await riskEvents()).toEqual(beforeEvents);
      expect((await api.dataSource.query('SELECT * FROM risk_assessment_drafts WHERE id=$1', [preview.id]))[0]).toEqual(beforeDraft);
      expect(await api.dataSource.query('SELECT * FROM idempotency_records WHERE key=$1', ['atomic-risk'])).toEqual([]);
      expect((await api.dataSource.query('SELECT consumed_at,receipt_ref FROM otp_challenges WHERE id=$1', [fresh.challengeId]))[0]).toEqual({ consumed_at: null, receipt_ref: null });
      expect((await api.dataSource.query("SELECT * FROM audit_events WHERE action='RISK_PROFILE_CONFIRMED' AND outcome='SUCCESS'")).length).toBe(0);
    } finally { await api.dataSource.query('ALTER TABLE audit_events DROP CONSTRAINT s2_audit_failure'); }
    const accepted = await confirm(preview, fresh, 'atomic-risk');
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ id: expect.any(String), draftId: preview.id, customerId: registered.customerId, version: 1, questionnaireVersion: value.version,
      answers: preview.answers, score: 35, category: 'BALANCED', ...matrix.BALANCED, confirmedAt: api.state.now.toISOString(), valid: true });
    const replay = await confirm(preview, fresh, 'atomic-risk');
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(accepted.body);
    expectApiError(await confirm(preview, { ...fresh, code: fresh.code === '000000' ? '000001' : '000000' }, 'atomic-risk'), 409, 'IDEMPOTENCY_CONFLICT');
    expectApiError(await confirm(preview, fresh, 'fresh-replay'), 409, 'OTP_ALREADY_USED');
    expect(await service(registered.serviceId)).toMatchObject({ status: 'ACTIVE', current_risk_profile_id: accepted.body.id });
    const rows = await confirmedRows(registered.customerId);
    expect(rows).toHaveLength(1);
    const [receipt] = await api.dataSource.query('SELECT receipt_ref FROM otp_challenges WHERE id=$1', [fresh.challengeId]);
    expect(rows[0]).toMatchObject({ draft_id: preview.id, otp_receipt_ref: receipt.receipt_ref, payload_hash: preview.payloadHash });
    expect(receipt.receipt_ref).toEqual(expect.any(String));
    const audits = await api.dataSource.query("SELECT * FROM audit_events WHERE action='RISK_PROFILE_CONFIRMED' AND outcome='SUCCESS'");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_id: actors.customer.actorId, resource_id: accepted.body.id });
    expect(new Date(audits[0].created_at).toISOString()).toBe(api.state.now.toISOString());
    expect(audits[0].metadata).toMatchObject({ requestId: 's2-risk-confirm', ip: '127.0.0.1', device: 'Synthetic risk device', before: { currentProfileId: null, version: 0 }, after: { currentProfileId: accepted.body.id, version: 1 } });
    expect((await riskEvents()).filter((event: any) => event.event_type === 'RiskProfileConfirmed')).toHaveLength(1);
    expect(JSON.stringify([accepted.body, audits, api.logs])).not.toContain(fresh.code);
    const beforeImmutable = structuredClone(rows[0]);
    await expect(api.dataSource.query('UPDATE risk_profiles SET score=50 WHERE id=$1', [accepted.body.id])).rejects.toThrow();
    await expect(api.dataSource.query('DELETE FROM risk_profiles WHERE id=$1', [accepted.body.id])).rejects.toThrow();
    await expect(api.dataSource.query('UPDATE risk_assessment_drafts SET score=50 WHERE id=$1', [preview.id])).rejects.toThrow();
    const [questionnaireBefore] = await api.dataSource.query('SELECT * FROM risk_questionnaire_versions WHERE version=$1', [value.version]);
    await expect(api.dataSource.query(`UPDATE risk_questionnaire_versions SET questions=jsonb_set(questions,'{0,text}','"tampered used question"'::jsonb) WHERE version=$1`, [value.version])).rejects.toThrow();
    await expect(api.dataSource.query('DELETE FROM risk_questionnaire_versions WHERE version=$1', [value.version])).rejects.toThrow();
    expect((await api.dataSource.query('SELECT * FROM risk_questionnaire_versions WHERE version=$1', [value.version]))[0]).toEqual(questionnaireBefore);
    expect(await questionnaire()).toEqual(value);
    const [consentBefore] = await api.dataSource.query('SELECT * FROM service_consents WHERE customer_id=$1', [registered.customerId]);
    await expect(api.dataSource.query("UPDATE service_consents SET terms_hash=repeat('a',64) WHERE customer_id=$1", [registered.customerId])).rejects.toThrow();
    await expect(api.dataSource.query('DELETE FROM service_consents WHERE customer_id=$1', [registered.customerId])).rejects.toThrow();
    expect((await api.dataSource.query('SELECT * FROM service_consents WHERE customer_id=$1', [registered.customerId]))[0]).toEqual(consentBefore);
    expect((await confirmedRows(registered.customerId))[0]).toEqual(beforeImmutable);
    expect((await history()).items.map((item: any) => item.id)).toEqual([accepted.body.id]);
    api.state.now = new Date(edited.expiresAt);
    expectApiError(await api.request('/otp/challenges', { method: 'POST', token: await api.tokenFor(actors.customer.actorId), body: { purpose: 'RISK_PROFILE_CONFIRM', operationId: edited.id } }), 410, 'RISK_DRAFT_EXPIRED');
    expect((await profile()).current.id).toBe(accepted.body.id);
  });

  test('AC04/AC08 concurrent independent drafts at one base version commit exactly one profile and preserve confirmed history', async () => {
    const registered = await register();
    const value = await questionnaire();
    const first = await draft(value, 20, 'race-draft-one');
    const second = await draft(value, 50, 'race-draft-two');
    expect([first.expectedCurrentProfileVersion, second.expectedCurrentProfileVersion]).toEqual([0, 0]);
    expect((await history()).total).toBe(0);
    const firstOtp = await challenge(first.id);
    const secondOtp = await challenge(second.id);
    const results = await Promise.all([confirm(first, firstOtp, 'shared-operation-key'), confirm(second, secondOtp, 'shared-operation-key')]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    expect(results.find(result => result.status === 409)!.body.code).toBe('RISK_PROFILE_STALE');
    const winner = results.find(result => result.status === 200)!.body;
    expect((await confirmedRows(registered.customerId)).map((row: any) => row.id)).toEqual([winner.id]);
    expect((await profile()).current).toMatchObject({ id: winner.id, version: 1 });
    const next = await draft(value, 35, 'next-version');
    expect(next.expectedCurrentProfileVersion).toBe(1);
    const accepted = await confirm(next, await challenge(next.id));
    expect(accepted.status).toBe(200);
    expect(accepted.body.version).toBe(2);
    const page1 = await history('/me/risk-profile/history', actors.customer.actorId, 1, 1);
    const page2 = await history('/me/risk-profile/history', actors.customer.actorId, 2, 1);
    expect(page1.total).toBe(2);
    expect(page2.total).toBe(2);
    expect(page1.items[0]).toMatchObject({ id: accepted.body.id, version: 2 });
    expect(page2.items[0]).toMatchObject({ id: winner.id, version: 1, score: winner.score, answers: winner.answers });
    expect((await history('/me/risk-profile/history', actors.customer.actorId, 3, 1)).items).toEqual([]);
    expect((await confirmedRows(registered.customerId)).map((row: any) => row.version)).toEqual([1, 2]);
    expect((await profile()).current.id).toBe(accepted.body.id);
  });

  test('AC04 profiles expire at twelve calendar months with leap-day clamp and month-end preservation, while history and service persist', async () => {
    const registered = await register();
    const value = await questionnaire();
    for (const [confirmedAt, expiresAt] of [['2028-02-29T05:00:00.000Z', '2029-02-28T05:00:00.000Z'], ['2030-01-31T05:00:00.000Z', '2031-01-31T05:00:00.000Z']] as const) {
      api.state.now = new Date(confirmedAt);
      const preview = await draft(value, 35, `calendar-${confirmedAt}`);
      const accepted = await confirm(preview, await challenge(preview.id));
      expect(accepted.status).toBe(200);
      expect(accepted.body).toMatchObject({ confirmedAt, expiresAt, valid: true });
      api.state.now = new Date(new Date(expiresAt).getTime() - 1);
      expect((await profile()).current).toMatchObject({ id: accepted.body.id, expiresAt, valid: true });
      api.state.now = new Date(expiresAt);
      expect((await profile()).current).toMatchObject({ id: accepted.body.id, expiresAt, valid: false });
      expect((await history()).items).toContainEqual(expect.objectContaining({ id: accepted.body.id, score: 35, expiresAt }));
      expect(await service(registered.serviceId)).toMatchObject({ status: 'ACTIVE', current_risk_profile_id: accepted.body.id });
    }
  });

  test('AC04/AC08 downgrade queues holdings/drift checking without sale or balance change, and profile/history follow current RM, team and CIF scope', async () => {
    const registered = await register();
    const value = await questionnaire();
    const growth = await draft(value, 50);
    const initial = await confirm(growth, await challenge(growth.id));
    expect(initial.status).toBe(200);
    const asOf = '2026-01-15T04:59:00.000Z';
    const provenance = 'SYNTHETIC_P3_READ_BRIDGE';
    for (const [productId, risk, assetClass, quantity, marketValue] of [['fund-risk-5', 5, 'FUND', '10', '1000000'], ['deposit-risk-1', 1, 'DEPOSIT', '1', '500000']] as const) {
      await api.dataSource.query(`INSERT INTO holdings_read_snapshots(id,customer_id,product_id,product_risk,asset_class,quantity,market_value,as_of,provenance)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [randomUUID(), registered.customerId, productId, risk, assetClass, quantity, marketValue, asOf, provenance]);
    }
    const holdingsBefore = await api.dataSource.query('SELECT * FROM holdings_read_snapshots WHERE customer_id=$1 ORDER BY product_id', [registered.customerId]);
    const accountBefore = (await api.dataSource.query('SELECT * FROM investment_accounts WHERE id=$1', [registered.accountId]))[0];
    const conservative = await draft(value, 10);
    const accepted = await confirm(conservative, await challenge(conservative.id));
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ category: 'CONSERVATIVE', ...matrix.CONSERVATIVE });
    const checking = (await profile()).holdingsCheck;
    expect(checking).toMatchObject({ profileId: accepted.body.id, status: 'PENDING', asOf, provenance,
      incompatibleHoldings: [{ productId: 'fund-risk-5', productRisk: 5, maxProductRisk: 2 }] });
    const tasks = (await riskEvents()).filter((event: any) => event.event_type === 'RiskHoldingsCheckRequested');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ aggregate_id: registered.customerId, published_at: null,
      payload: { customerId: registered.customerId, profileId: accepted.body.id, previousProfileId: initial.body.id, checkHoldings: true, triggerDrift: true } });
    expect(await api.dataSource.query('SELECT * FROM holdings_read_snapshots WHERE customer_id=$1 ORDER BY product_id', [registered.customerId])).toEqual(holdingsBefore);
    expect((await api.dataSource.query('SELECT * FROM investment_accounts WHERE id=$1', [registered.accountId]))[0]).toEqual(accountBefore);
    expect(await api.dataSource.query("SELECT * FROM outbox_events WHERE event_type ILIKE '%sell%' OR event_type ILIKE '%trade%' OR event_type ILIKE '%order%'")).toEqual([]);
    const other = await register(actors.otherCustomer.cifId, actors.otherCustomer.actorId);
    expect((await profile(actors.otherCustomer.actorId)).current).toBeNull();
    const otherDraftResponse = await api.request('/me/risk-assessments', { method: 'POST', token: await api.tokenFor(actors.otherCustomer.actorId), key: 'other-cif-draft', body: { questionnaireVersion: value.version, answers: answersFor(value, 35) } });
    expect(otherDraftResponse.status).toBe(201);
    const otherOtp = await challenge(otherDraftResponse.body.id, 'RISK_PROFILE_CONFIRM', actors.otherCustomer.actorId);
    const otherAccepted = await confirm(otherDraftResponse.body, otherOtp, 'shared-operation-key', actors.otherCustomer.actorId);
    expect(otherAccepted.status).toBe(200);
    expect(otherAccepted.body.customerId).toBe(other.customerId);
    expect(JSON.stringify(await history())).not.toContain(otherAccepted.body.id);
    const customerPath = `/customers/${registered.customerId}/risk-profile`;
    for (const actorId of [actors.rm.actorId, actors.leader.actorId]) {
      const read = await api.request(customerPath, { token: await api.tokenFor(actorId) });
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ current: { id: accepted.body.id }, holdingsCheck: checking });
      expect((await history(`${customerPath}/history`, actorId)).total).toBe(2);
    }
    expectApiError(await api.request(customerPath, { token: await api.tokenFor(actors.otherCustomer.actorId) }), 403, 'FORBIDDEN');
    expectApiError(await api.request(`${customerPath}/history`, { token: await api.tokenFor(actors.otherCustomer.actorId) }), 403, 'FORBIDDEN');
    const replacementRm = '22222222-2222-4222-8222-222222222222';
    const foreignTeam = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    for (const [actorId, role, rmId, teamId] of [['rm-replacement', 'RM', replacementRm, actors.rm.teamId], ['leader-foreign', 'LEADER', null, foreignTeam]] as const) {
      await api.dataSource.query('INSERT INTO mock_actors(actor_id,subject_id,role,rm_id,team_id,active) VALUES($1,$2,$3,$4,$5,true)', [actorId, `mock-${actorId}`, role, rmId, teamId]);
    }
    // Synthetic assignment seed exercises read authorization only; S3 owns transfer behavior.
    await api.dataSource.transaction(async manager => {
      await manager.query('UPDATE rm_assignment_history SET valid_to=$2 WHERE customer_id=$1 AND valid_to IS NULL', [registered.customerId, api.state.now]);
      await manager.query('INSERT INTO rm_assignment_history(id,customer_id,rm_id,team_id,valid_from,provisional) VALUES($1,$2,$3,$4,$5,false)', [randomUUID(), registered.customerId, replacementRm, actors.rm.teamId, api.state.now]);
    });
    for (const actorId of [actors.rm.actorId, 'leader-foreign']) {
      expectApiError(await api.request(customerPath, { token: await api.tokenFor(actorId) }), 403, 'FORBIDDEN');
      expectApiError(await api.request(`${customerPath}/history`, { token: await api.tokenFor(actorId) }), 403, 'FORBIDDEN');
    }
    expect((await api.request(customerPath, { token: await api.tokenFor('rm-replacement') })).status).toBe(200);
    expect((await history(`${customerPath}/history`, 'rm-replacement')).total).toBe(2);
    expect((await profile()).current.id).toBe(accepted.body.id);
  });
});

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { actors } from '../helpers/actors.js';
import { eligibleCustomer, expectApiError, startApiFixture } from '../helpers/application.js';
import type { OtpDelivery } from '../helpers/application.js';

type Fixture = Awaited<ReturnType<typeof startApiFixture>>;
type Questionnaire = { version: string; questions: Array<{ id: string; text: string; options: Array<{ id: string; text: string }> }> };

describe('S2a AC04/AC08 draft audit and trusted questionnaire publication', () => {
  let api: Fixture;
  beforeEach(async () => { api = await startApiFixture(); });
  afterEach(async () => { await api?.stop(); });

  async function challenge(operationId: string, purpose = 'RISK_PROFILE_CONFIRM'): Promise<OtpDelivery> {
    const response = await api.request('/otp/challenges', { method: 'POST', token: await api.tokenFor(actors.customer.actorId), body: { purpose, operationId } });
    expect(response.status).toBe(201);
    const delivery = api.deliveries.find(item => item.challengeId === response.body.challengeId);
    expect(delivery).toMatchObject({ actorId: actors.customer.actorId, purpose, operationId });
    return delivery!;
  }
  async function register() {
    const request = await api.request('/onboarding/requests', { method: 'POST', token: await api.tokenFor(), key: 's2a-registration',
      body: { cifRef: actors.customer.cifId, selectedAccountId: eligibleCustomer().accounts[0].id } });
    expect(request.status).toBe(201);
    const otp = await challenge(request.body.id, 'SERVICE_CONSENT');
    const response = await api.request(`/me/onboarding-requests/${request.body.id}/confirm`, { method: 'POST', token: await api.tokenFor(actors.customer.actorId),
      key: 's2a-consent', body: { challengeId: otp.challengeId, code: otp.code } });
    expect(response.status).toBe(200);
    return { ...response.body, otp };
  }
  async function questionnaire(): Promise<Questionnaire> {
    const response = await api.request('/risk-questionnaires/current', { token: await api.tokenFor(actors.customer.actorId) });
    expect(response.status).toBe(200);
    expect(response.body.questions).toHaveLength(10);
    return response.body;
  }
  function draftBody(value: Questionnaire) {
    return { questionnaireVersion: value.version, answers: value.questions.map(question => ({ questionId: question.id, optionId: question.options[0].id })) };
  }
  async function draft(value: Questionnaire, key: string, token?: string) {
    return api.request('/me/risk-assessments', { method: 'POST', token: token ?? await api.tokenFor(actors.customer.actorId), key,
      headers: { 'x-request-id': 's2a-draft-create', 'user-agent': 'Synthetic draft device' }, body: draftBody(value) });
  }
  async function draftAudits() {
    return api.dataSource.query("SELECT * FROM audit_events WHERE action='RISK_DRAFT_CREATED' AND outcome='SUCCESS' ORDER BY resource_id");
  }
  function assertAudit(audit: any, result: any) {
    expect(audit).toMatchObject({ actor_id: actors.customer.actorId, resource_id: result.id,
      metadata: { requestId: 's2a-draft-create', ip: '127.0.0.1', device: 'Synthetic draft device', before: null,
        after: { id: result.id, questionnaireVersion: result.questionnaireVersion, expectedCurrentProfileVersion: result.expectedCurrentProfileVersion,
          score: 10, category: 'CONSERVATIVE' } } });
    expect(new Date(audit.created_at).toISOString()).toBe(api.state.now.toISOString());
  }

  test('AC08 draft creation atomically audits safe metadata once on replay and rolls back draft/idempotency on real audit refusal before same-key retry', async () => {
    const registered = await register();
    const value = await questionnaire();
    const token = await api.tokenFor(actors.customer.actorId);
    const first = await draft(value, 's2a-draft-once', token);
    expect(first.status).toBe(201);
    const replay = await draft(value, 's2a-draft-once', token);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    const audits = await draftAudits();
    // Soft checks let the independent rollback boundary run even when the append is missing.
    expect.soft(audits, 'a newly created draft must have exactly one successful audit, including on replay').toHaveLength(1);
    if (audits[0]) assertAudit(audits[0], first.body);
    expect(await api.dataSource.query('SELECT id FROM risk_assessment_drafts WHERE id=$1', [first.body.id])).toEqual([{ id: first.body.id }]);
    const beforeDrafts = await api.dataSource.query('SELECT * FROM risk_assessment_drafts ORDER BY id');
    const beforeOutbox = await api.dataSource.query('SELECT * FROM outbox_events ORDER BY id');
    const [beforeService] = await api.dataSource.query('SELECT * FROM wealth_services WHERE id=$1', [registered.serviceId]);
    await api.dataSource.query('ALTER TABLE audit_events ADD CONSTRAINT s2a_draft_audit_failure CHECK (false) NOT VALID');
    try {
      const refused = await draft(value, 's2a-atomic-draft', token);
      expect.soft(refused.status, 'an actual PostgreSQL audit CHECK refusal must fail the whole draft request').toBe(500);
      expect.soft(refused.body).toMatchObject({ code: 'INTERNAL_ERROR', requestId: 's2a-draft-create' });
      expect.soft(await api.dataSource.query('SELECT * FROM risk_assessment_drafts ORDER BY id')).toEqual(beforeDrafts);
      expect.soft(await api.dataSource.query('SELECT * FROM idempotency_records WHERE key=$1', ['s2a-atomic-draft'])).toEqual([]);
      expect.soft(await draftAudits()).toEqual(audits);
      expect.soft(await api.dataSource.query('SELECT * FROM outbox_events ORDER BY id')).toEqual(beforeOutbox);
      expect.soft((await api.dataSource.query('SELECT * FROM wealth_services WHERE id=$1', [registered.serviceId]))[0]).toEqual(beforeService);
    } finally { await api.dataSource.query('ALTER TABLE audit_events DROP CONSTRAINT s2a_draft_audit_failure'); }
    const retried = await draft(value, 's2a-atomic-draft', token);
    expect(retried.status).toBe(201);
    expect((await draft(value, 's2a-atomic-draft', token)).body).toEqual(retried.body);
    expect(await api.dataSource.query('SELECT id FROM risk_assessment_drafts ORDER BY id')).toHaveLength(beforeDrafts.length + 1);
    expect(await api.dataSource.query('SELECT * FROM idempotency_records WHERE key=$1', ['s2a-atomic-draft'])).toHaveLength(1);
    const recoveredAudits = await draftAudits();
    expect.soft(recoveredAudits, 'each committed intent creates one audit and retry/replay creates no duplicates').toHaveLength(2);
    const recoveredAudit = recoveredAudits.find((audit: any) => audit.resource_id === retried.body.id);
    expect.soft(recoveredAudit).toBeDefined();
    if (recoveredAudit) assertAudit(recoveredAudit, retried.body);
    const observed = JSON.stringify([first.body, retried.body, recoveredAudits, api.logs]);
    expect(observed).not.toContain(token);
    expect(observed).not.toContain(registered.otp.code);
    const current = await api.request('/me/risk-profile', { token });
    expect(current.status).toBe(200);
    expect(current.body.current).toBeNull();
  });

  test('AC04 trusted publication retires a used version without changing its content/history and switches questionnaire/current draft version', async () => {
    const registered = await register();
    const original = await questionnaire();
    const preview = await draft(original, 's2a-original-draft');
    expect(preview.status).toBe(201);
    const otp = await challenge(preview.body.id);
    const confirmed = await api.request(`/me/risk-assessments/${preview.body.id}/confirm`, { method: 'POST', token: await api.tokenFor(actors.customer.actorId),
      key: 's2a-original-confirm', body: { challengeId: otp.challengeId, code: otp.code, expectedCurrentProfileVersion: preview.body.expectedCurrentProfileVersion } });
    expect(confirmed.status).toBe(200);
    const [originalRow] = await api.dataSource.query('SELECT * FROM risk_questionnaire_versions WHERE version=$1', [original.version]);
    const beforeProfiles = await api.dataSource.query('SELECT * FROM risk_profiles WHERE customer_id=$1 ORDER BY version', [registered.customerId]);
    const nextVersion = `${original.version}-successor`;
    const nextQuestions = structuredClone(originalRow.questions);
    nextQuestions[0].text = 'Synthetic successor investment objective';
    const publicationTime = new Date(api.state.now.getTime() + 1000);
    api.state.now = publicationTime;
    const transaction = api.dataSource.createQueryRunner();
    let publicationSucceeded = false;
    let publicationErrorCode: string | undefined;
    await transaction.connect();
    await transaction.startTransaction();
    try {
      await transaction.query("UPDATE risk_questionnaire_versions SET status='RETIRED' WHERE version=$1", [original.version]);
      await transaction.query("INSERT INTO risk_questionnaire_versions(version,questions,status,effective_from) VALUES($1,$2,'ACTIVE',$3)",
        [nextVersion, JSON.stringify(nextQuestions), publicationTime.toISOString()]);
      await transaction.commitTransaction();
      publicationSucceeded = true;
    } catch (error) {
      publicationErrorCode = (error as { code?: string }).code;
      await transaction.rollbackTransaction();
    } finally { await transaction.release(); }
    expect(publicationSucceeded, `trusted metadata-only retirement plus successor publication must succeed; PostgreSQL refusal code=${publicationErrorCode}`).toBe(true);
    const active = await questionnaire();
    expect(active.version).toBe(nextVersion);
    expect(active.questions[0].text).toBe(nextQuestions[0].text);
    expect(active.questions.slice(1)).toEqual(original.questions.slice(1));
    const [retired] = await api.dataSource.query('SELECT * FROM risk_questionnaire_versions WHERE version=$1', [original.version]);
    expect(retired).toEqual({ ...originalRow, status: 'RETIRED' });
    expect(await api.dataSource.query('SELECT version FROM risk_questionnaire_versions WHERE status=$1', ['ACTIVE'])).toEqual([{ version: nextVersion }]);
    await expect(api.dataSource.query(`UPDATE risk_questionnaire_versions SET questions=jsonb_set(questions,'{0,text}','"tampered retired question"'::jsonb) WHERE version=$1`, [original.version])).rejects.toThrow();
    await expect(api.dataSource.query('DELETE FROM risk_questionnaire_versions WHERE version=$1', [original.version])).rejects.toThrow();
    expect((await api.dataSource.query('SELECT * FROM risk_questionnaire_versions WHERE version=$1', [original.version]))[0]).toEqual(retired);
    expect(await api.dataSource.query('SELECT * FROM risk_profiles WHERE customer_id=$1 ORDER BY version', [registered.customerId])).toEqual(beforeProfiles);
    const token = await api.tokenFor(actors.customer.actorId);
    const current = await api.request('/me/risk-profile', { token });
    expect(current.status).toBe(200);
    expect(current.body.current).toEqual(confirmed.body);
    const history = await api.request('/me/risk-profile/history?page=1&pageSize=10', { token });
    expect(history.status).toBe(200);
    expect(history.body).toMatchObject({ total: 1, items: [confirmed.body] });
    expectApiError(await draft(original, 's2a-retired-version'), 409, 'QUESTIONNAIRE_VERSION_MISMATCH');
    const newPreview = await draft(active, 's2a-successor-draft');
    expect(newPreview.status).toBe(201);
    expect(newPreview.body).toMatchObject({ questionnaireVersion: nextVersion, answers: draftBody(active).answers,
      expectedCurrentProfileVersion: 1, score: 10, category: 'CONSERVATIVE' });
    expect(newPreview.body.id).not.toBe(preview.body.id);
    expect((await api.request('/me/risk-profile', { token })).body.current).toEqual(confirmed.body);
  });
});

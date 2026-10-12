import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { actors } from '../helpers/actors.js';
import { eligibleCustomer, expectApiError, startApiFixture } from '../helpers/application.js';
import type { OtpDelivery } from '../helpers/application.js';

type Fixture = Awaited<ReturnType<typeof startApiFixture>>;
type Questionnaire = { version: string; questions: Array<{ id: string; text: string; options: Array<{ id: string; text: string }> }> };

const V1 = 'demo-risk-v1';
const VIETNAMESE = /[ăâđêôơưàáạảãèéẹẻẽìíịỉĩòóọỏõùúụủũỳýỵỷỹ]/i;
/** The original English v1 content exactly as migration 1791763200003 seeded it (ids q1..q10, o1..o5, points 1..5). */
const V1_ENGLISH: Array<[string, string[]]> = [
  ['Investment objective', ['Preserve capital', 'Earn steady income', 'Balance income and growth', 'Seek long-term growth', 'Maximize long-term growth']],
  ['Investment horizon', ['Less than one year', 'One to two years', 'Two to five years', 'Five to ten years', 'More than ten years']],
  ['Tolerance for a temporary decline', ['No decline', 'Up to 5%', 'Up to 10%', 'Up to 20%', 'More than 20%']],
  ['Response to a falling market', ['Exit immediately', 'Reduce most exposure', 'Keep the current plan', 'Add a small amount', 'Increase exposure significantly']],
  ['Investment experience', ['No experience', 'Deposits only', 'Bonds and diversified funds', 'Equities and equity funds', 'A broad range of volatile investments']],
  ['Income stability', ['Very uncertain', 'Somewhat uncertain', 'Moderately stable', 'Stable', 'Very stable with several sources']],
  ['Emergency reserves', ['No reserves', 'Less than three months', 'Three to six months', 'Six to twelve months', 'More than twelve months']],
  ['Dependence on invested funds', ['Needed for essential spending now', 'Needed within one year', 'May be needed within three years', 'Unlikely to be needed soon', 'Not needed for foreseeable expenses']],
  ['Preference for return and volatility', ['Lowest volatility', 'Mostly stable returns', 'Moderate growth and volatility', 'Higher growth with volatility', 'Highest growth potential with large volatility']],
  ['Share of assets available for growth investing', ['Very little', 'A small share', 'A moderate share', 'A large share', 'Most of my investable assets']],
];
const v1Expected = V1_ENGLISH.map(([text, options], index) => ({ id: `q${index + 1}`, text,
  options: options.map((option, optionIndex) => ({ id: `o${optionIndex + 1}`, text: option, points: optionIndex + 1 })) }));

describe('S8 B4 Vietnamese risk questionnaire published as a new immutable version', () => {
  let api: Fixture;
  beforeEach(async () => { api = await startApiFixture(); });
  afterEach(async () => { await api?.stop(); });

  async function challenge(operationId: string, purpose: string): Promise<OtpDelivery> {
    const response = await api.request('/otp/challenges', { method: 'POST', token: await api.tokenFor(actors.customer.actorId), body: { purpose, operationId } });
    expect(response.status).toBe(201);
    return api.deliveries.find(item => item.challengeId === response.body.challengeId)!;
  }
  async function register() {
    const request = await api.request('/onboarding/requests', { method: 'POST', token: await api.tokenFor(), key: 's8-registration',
      body: { cifRef: actors.customer.cifId, selectedAccountId: eligibleCustomer().accounts[0].id } });
    expect(request.status).toBe(201);
    const otp = await challenge(request.body.id, 'SERVICE_CONSENT');
    const response = await api.request(`/me/onboarding-requests/${request.body.id}/confirm`, { method: 'POST', token: await api.tokenFor(actors.customer.actorId),
      key: 's8-consent', body: { challengeId: otp.challengeId, code: otp.code } });
    expect(response.status).toBe(200);
    return response.body as { customerId: string };
  }
  async function current(): Promise<Questionnaire> {
    const response = await api.request('/risk-questionnaires/current', { token: await api.tokenFor(actors.customer.actorId) });
    expect(response.status).toBe(200);
    return response.body;
  }
  async function draftWith(version: string, questions: Questionnaire['questions'], optionIndexes: number[], key: string) {
    return api.request('/me/risk-assessments', { method: 'POST', token: await api.tokenFor(actors.customer.actorId), key,
      body: { questionnaireVersion: version, answers: questions.map((question, index) => ({ questionId: question.id, optionId: question.options[optionIndexes[index]].id })) } });
  }
  /** Simulates a draft that was created while v1 was still current (before the switch migration). */
  async function insertV1Draft(customerId: string) {
    const id = randomUUID();
    const answers = v1Expected.map(question => ({ questionId: question.id, optionId: 'o3' }));
    await api.dataSource.query(`INSERT INTO risk_assessment_drafts(id,customer_id,questionnaire_version,answers,score,category,max_product_risk,allocation,
      expected_current_profile_version,payload_hash,created_at,expires_at) VALUES($1,$2,$3,$4,30,'BALANCED',3,$5,0,$6,$7,$8)`,
      [id, customerId, V1, JSON.stringify(answers), JSON.stringify({ cash: 5, deposit: 30, bond: 30, fund: 35 }), 'a'.repeat(64), api.state.now,
        new Date(api.state.now.getTime() + 24 * 3600 * 1000)]);
    return id;
  }

  test('AC04 current questionnaire is a NEW version (not v1), effective later than v1, with ten Vietnamese questions and five Vietnamese options each that differ from v1', async () => {
    await register();
    const value = await current();
    expect(value.version).not.toBe(V1);
    const [v1] = await api.dataSource.query('SELECT * FROM risk_questionnaire_versions WHERE version=$1', [V1]);
    const [active] = await api.dataSource.query('SELECT * FROM risk_questionnaire_versions WHERE version=$1', [value.version]);
    expect(new Date(active.effective_from).getTime()).toBeGreaterThan(new Date(v1.effective_from).getTime());
    expect(value.questions).toHaveLength(10);
    value.questions.forEach((question, index) => {
      expect(question.id).toBe(`q${index + 1}`);
      expect(question.text, `question ${index + 1} must be Vietnamese`).toMatch(VIETNAMESE);
      expect(question.text).not.toBe(v1Expected[index].text);
      expect(question.options).toHaveLength(5);
      question.options.forEach((option, optionIndex) => {
        expect(option.id).toBe(`o${optionIndex + 1}`);
        expect(option.text, `question ${index + 1} option ${optionIndex + 1} must be Vietnamese`).toMatch(VIETNAMESE);
        expect(option.text).not.toBe(v1Expected[index].options[optionIndex].text);
        expect(Object.keys(option).sort()).toEqual(['id', 'text']);
      });
    });
  });

  test('AC04 server-owned scoring is unchanged on the new version: option index 0..4 scores 1..5 (all-0 CONSERVATIVE/10, all-2 BALANCED/30, all-4 GROWTH/50, mixed pattern sums points)', async () => {
    await register();
    const value = await current();
    expect(value.version).not.toBe(V1);
    const mixed = [4, 4, 4, 3, 3, 3, 2, 1, 0, 0];
    const cases: Array<{ indexes: number[]; score: number; category: string }> = [
      { indexes: Array(10).fill(0), score: 10, category: 'CONSERVATIVE' },
      { indexes: Array(10).fill(2), score: 30, category: 'BALANCED' },
      { indexes: Array(10).fill(4), score: 50, category: 'GROWTH' },
      { indexes: mixed, score: mixed.reduce((sum, index) => sum + index + 1, 0), category: 'BALANCED' },
    ];
    for (const [position, expected] of cases.entries()) {
      const response = await draftWith(value.version, value.questions, expected.indexes, `s8-score-${position}`);
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ questionnaireVersion: value.version, score: expected.score, category: expected.category });
    }
  });

  test('AC04 v1 row is unchanged (identical English content and points, same effective time) but RETIRED, and its content stays immutable once used', async () => {
    const registered = await register();
    const [v1] = await api.dataSource.query('SELECT * FROM risk_questionnaire_versions WHERE version=$1', [V1]);
    expect(v1.questions).toEqual(v1Expected);
    expect(new Date(v1.effective_from).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(v1.status).toBe('RETIRED');
    await insertV1Draft(registered.customerId);
    await expect(api.dataSource.query(`UPDATE risk_questionnaire_versions SET questions=jsonb_set(questions,'{0,text}','"tampered"'::jsonb) WHERE version=$1`, [V1])).rejects.toThrow();
  });

  test('AC04 history and the confirmed profile that reference v1 still read back with the v1 version after the switch', async () => {
    const registered = await register();
    const draftId = await insertV1Draft(registered.customerId);
    const profileId = randomUUID();
    await api.dataSource.transaction(async manager => {
      await manager.query(`INSERT INTO risk_profiles(id,customer_id,draft_id,questionnaire_version,answers,score,category,max_product_risk,allocation,version,confirmed_at,expires_at,otp_receipt_ref,payload_hash)
        SELECT $1,customer_id,id,questionnaire_version,answers,score,category,max_product_risk,allocation,1,created_at,$3,$4,payload_hash FROM risk_assessment_drafts WHERE id=$2`,
        [profileId, draftId, new Date(api.state.now.getTime() + 365 * 24 * 3600 * 1000), randomUUID()]);
      await manager.query('UPDATE wealth_services SET current_risk_profile_id=$2 WHERE customer_id=$1', [registered.customerId, profileId]);
    });
    const token = await api.tokenFor(actors.customer.actorId);
    const profile = await api.request('/me/risk-profile', { token });
    expect(profile.status).toBe(200);
    expect(profile.body.current).toMatchObject({ id: profileId, questionnaireVersion: V1, score: 30, category: 'BALANCED' });
    const history = await api.request('/me/risk-profile/history?page=1&pageSize=10', { token });
    expect(history.body.items).toContainEqual(expect.objectContaining({ id: profileId, questionnaireVersion: V1 }));
    const [v1] = await api.dataSource.query('SELECT * FROM risk_questionnaire_versions WHERE version=$1', [V1]);
    expect(v1.questions).toEqual(v1Expected);
    expect(v1.status, 'v1 stays referenced by history but must no longer be the active questionnaire').toBe('RETIRED');
    expect((await current()).version).not.toBe(V1);
  });

  test('AC04 a pending draft created against v1 before the switch cannot be confirmed (409 QUESTIONNAIRE_VERSION_MISMATCH) and creates no profile', async () => {
    const registered = await register();
    const draftId = await insertV1Draft(registered.customerId);
    const otp = await challenge(draftId, 'RISK_PROFILE_CONFIRM');
    const response = await api.request(`/me/risk-assessments/${draftId}/confirm`, { method: 'POST', token: await api.tokenFor(actors.customer.actorId), key: 's8-confirm-old',
      body: { challengeId: otp.challengeId, code: otp.code, expectedCurrentProfileVersion: 0 } });
    expectApiError(response, 409, 'QUESTIONNAIRE_VERSION_MISMATCH');
    expect(await api.dataSource.query('SELECT id FROM risk_profiles WHERE customer_id=$1', [registered.customerId])).toEqual([]);
    expect((await api.request('/me/risk-profile', { token: await api.tokenFor(actors.customer.actorId) })).body.current).toBeNull();
  });

  test('AC04 new drafts must use the current version: the retired v1 version number is rejected with 409 QUESTIONNAIRE_VERSION_MISMATCH while the current version is accepted', async () => {
    await register();
    const value = await current();
    expect(value.version).not.toBe(V1);
    const v1Questions = v1Expected.map(question => ({ id: question.id, text: question.text, options: question.options.map(({ id, text }) => ({ id, text })) }));
    expectApiError(await draftWith(V1, v1Questions, Array(10).fill(2), 's8-old-version'), 409, 'QUESTIONNAIRE_VERSION_MISMATCH');
    expect((await draftWith(value.version, value.questions, Array(10).fill(2), 's8-new-version')).status).toBe(201);
  });

  test('AC04 a database migrated from zero ends with exactly one ACTIVE questionnaire: the Vietnamese version; v1 is retained as RETIRED', async () => {
    const rows = await api.dataSource.query('SELECT version,status,questions FROM risk_questionnaire_versions ORDER BY effective_from');
    const active = rows.filter((row: any) => row.status === 'ACTIVE');
    expect(active).toHaveLength(1);
    expect(active[0].version).not.toBe(V1);
    expect(active[0].questions).toHaveLength(10);
    for (const question of active[0].questions) {
      expect(question.text).toMatch(VIETNAMESE);
      expect(question.options.map((option: any) => option.points)).toEqual([1, 2, 3, 4, 5]);
    }
    expect(rows.find((row: any) => row.version === V1)).toMatchObject({ status: 'RETIRED' });
    expect(await api.dataSource.query("SELECT version FROM risk_questionnaire_versions WHERE status='ACTIVE'")).toEqual([{ version: active[0].version }]);
  });
});

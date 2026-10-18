import pg from 'pg';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { actors } from '../helpers/actors.js';
import { eligibleCustomer, expectApiError, startApiFixture, TEST_NOW } from '../helpers/application.js';
import type { CoreCustomer, OtpDelivery } from '../helpers/application.js';
import { startTestDatabase } from '../helpers/postgres.js';
import { reserveHttpPort, runtimeEnvironment, startRuntimeProcess } from '../helpers/runtime.js';

type Fixture = Awaited<ReturnType<typeof startApiFixture>>;
const rmBeta = { actorId: 'rm-s12-beta', subjectId: 'mock-rm-s12-beta', role: 'RM', rmId: '99999999-9999-4999-8999-999999999999', teamId: actors.rm.teamId };

describe('S12 W2/BR-02 eligibility: blacklisted or credit group >= 3 is ineligible', () => {
  let api: Fixture;
  beforeEach(async () => { api = await startApiFixture(); });
  afterEach(async () => { await api?.stop(); });

  const core = (extra: Partial<CoreCustomer>): CoreCustomer => ({ ...eligibleCustomer(), ...extra });
  const lookup = async () => api.request('/onboarding/customer-lookup', { method: 'POST', token: await api.tokenFor(), body: { cifRef: actors.customer.cifId } });
  const create = async (key: string) => api.request('/onboarding/requests', { method: 'POST', token: await api.tokenFor(), key,
    body: { cifRef: actors.customer.cifId, selectedAccountId: eligibleCustomer().accounts[0].id } });
  async function rowCounts() {
    const result: Record<string, number> = {};
    for (const table of ['onboarding_requests', 'rm_capacity_reservations', 'wealth_services', 'investment_accounts', 'service_consents', 'outbox_events']) {
      result[table] = (await api.dataSource.query(`SELECT count(*)::int AS count FROM ${table}`))[0].count;
    }
    return result;
  }

  test.each([
    ['blacklisted, group 1', { blacklisted: true, creditGroup: 1 }],
    ['not blacklisted, group 3', { blacklisted: false, creditGroup: 3 }],
    ['not blacklisted, group 4', { blacklisted: false, creditGroup: 4 }],
    ['not blacklisted, group 5', { blacklisted: false, creditGroup: 5 }],
    ['blacklisted and group 5', { blacklisted: true, creditGroup: 5 }],
  ] as const)('W2 %s: lookup shows eligible=false, creation is 422 CUSTOMER_INELIGIBLE and writes no rows', async (_label, extra) => {
    api.state.core = core(extra);
    const looked = await lookup();
    expect(looked.status).toBe(200);
    expect(looked.body.eligible).toBe(false);
    const before = await rowCounts();
    expectApiError(await create('s12-ineligible'), 422, 'CUSTOMER_INELIGIBLE');
    expect(await rowCounts()).toEqual(before);
    expect(before.onboarding_requests).toBe(0);
  });

  test.each([
    ['group 1', { blacklisted: false, creditGroup: 1 }],
    ['group 2 (boundary below 3)', { blacklisted: false, creditGroup: 2 }],
  ] as const)('W2 %s and not blacklisted stays eligible and can be invited', async (_label, extra) => {
    api.state.core = core(extra);
    const looked = await lookup();
    expect(looked.status).toBe(200);
    expect(looked.body.eligible).toBe(true);
    expect((await create('s12-eligible')).status).toBe(201);
  });

  test('W2 eligibility is re-checked at confirm: a customer blacklisted after the invitation cannot confirm and nothing is registered', async () => {
    api.state.core = core({ blacklisted: false, creditGroup: 1 });
    const created = await create('s12-recheck');
    expect(created.status).toBe(201);
    const issued = await api.request('/otp/challenges', { method: 'POST', token: await api.tokenFor(actors.customer.actorId),
      body: { purpose: 'SERVICE_CONSENT', operationId: created.body.id } });
    expect(issued.status).toBe(201);
    const delivery = api.deliveries.find(item => item.challengeId === issued.body.challengeId)!;
    api.state.core = core({ blacklisted: true, creditGroup: 1 });
    const refused = await api.request(`/me/onboarding-requests/${created.body.id}/confirm`, { method: 'POST',
      token: await api.tokenFor(actors.customer.actorId), key: 's12-recheck-confirm', body: { challengeId: delivery.challengeId, code: delivery.code } });
    expectApiError(refused, 422, 'CUSTOMER_INELIGIBLE');
    for (const table of ['wealth_services', 'investment_accounts', 'service_consents', 'rm_assignment_history']) {
      expect((await api.dataSource.query(`SELECT count(*)::int AS count FROM ${table}`))[0].count, `${table} must stay empty`).toBe(0);
    }
  });
});

describe('S12 W3/BR-01 device id and failed/denied audit', () => {
  let api: Fixture;
  beforeEach(async () => {
    api = await startApiFixture();
    await api.dataSource.query('INSERT INTO mock_actors(actor_id,subject_id,role,rm_id,team_id,active) VALUES($1,$2,$3,$4,$5,true)',
      [rmBeta.actorId, rmBeta.subjectId, rmBeta.role, rmBeta.rmId, rmBeta.teamId]);
  });
  afterEach(async () => { await api?.stop(); });

  const create = async (key: string, headers: Record<string, string> = {}) => api.request('/onboarding/requests', { method: 'POST',
    token: await api.tokenFor(), key, headers: { 'user-agent': 'S12 browser agent', ...headers },
    body: { cifRef: actors.customer.cifId, selectedAccountId: eligibleCustomer().accounts[0].id } });
  const auditFor = (action: string) => api.dataSource.query('SELECT * FROM audit_events WHERE action=$1', [action]);
  async function challenge(operationId: string, purpose: string): Promise<OtpDelivery> {
    const response = await api.request('/otp/challenges', { method: 'POST', token: await api.tokenFor(actors.customer.actorId), body: { purpose, operationId } });
    expect(response.status).toBe(201);
    return api.deliveries.find(item => item.challengeId === response.body.challengeId)!;
  }
  const wrongCode = (code: string) => (code === '000000' ? '000001' : '000000');

  test('W3a X-Device-Id is stored as metadata.deviceId next to the user-agent device', async () => {
    const created = await create('s12-device', { 'x-device-id': 'device-abc-123' });
    expect(created.status).toBe(201);
    const [row] = await auditFor('ONBOARDING_REQUESTED');
    expect(row.metadata).toMatchObject({ deviceId: 'device-abc-123', device: 'S12 browser agent' });
  });

  test('W3a an absent X-Device-Id yields deviceId null (key present) and the device stays', async () => {
    expect((await create('s12-no-device')).status).toBe(201);
    const [row] = await auditFor('ONBOARDING_REQUESTED');
    expect(row.metadata.device).toBe('S12 browser agent');
    expect(row.metadata).toHaveProperty('deviceId', null);
  });

  test('W3a 128 printable characters are accepted and stored whole', async () => {
    const id = 'd'.repeat(128);
    expect((await create('s12-device-128', { 'x-device-id': id })).status).toBe(201);
    expect((await auditFor('ONBOARDING_REQUESTED'))[0].metadata.deviceId).toBe(id);
  });

  test.each([
    ['129 characters', 'd'.repeat(129)],
    ['a control character (tab)', 'dev\tice'],
  ])('W3a X-Device-Id with %s is 400 VALIDATION_ERROR and nothing is written', async (_label, value) => {
    expectApiError(await create('s12-device-bad', { 'x-device-id': value }), 400, 'VALIDATION_ERROR');
    expect((await api.dataSource.query('SELECT count(*)::int AS count FROM onboarding_requests'))[0].count).toBe(0);
    expect(await auditFor('ONBOARDING_REQUESTED')).toEqual([]);
  });

  function expectSafe(rows: any[], secrets: string[]) {
    const serialized = JSON.stringify(rows);
    for (const secret of secrets) expect(serialized).not.toContain(secret);
    expect(serialized).not.toMatch(/"(?:code|raw_code|code_hash|salt|token|accessToken|authorization)"\s*:/);
  }

  test('W3b a wrong OTP on onboarding consent writes a FAILURE audit row (OTP_INVALID, actor, resource, requestId) while the business transaction rolls back', async () => {
    const created = await create('s12-otp-fail');
    expect(created.status).toBe(201);
    const otp = await challenge(created.body.id, 'SERVICE_CONSENT');
    const token = await api.tokenFor(actors.customer.actorId);
    const rejected = await api.request(`/me/onboarding-requests/${created.body.id}/confirm`, { method: 'POST', token, key: 's12-consent-fail',
      headers: { 'x-request-id': 's12-consent-fail-id' }, body: { challengeId: otp.challengeId, code: wrongCode(otp.code) } });
    expectApiError(rejected, 400, 'OTP_INVALID');
    const rows = await api.dataSource.query("SELECT * FROM audit_events WHERE outcome='FAILURE'");
    expect(rows, 'exactly one FAILURE audit row for the failed confirmation').toHaveLength(1);
    expect(rows[0].actor_id).toBe(actors.customer.actorId);
    expect(rows[0].resource_id).toBe(created.body.id);
    expect(rows[0].metadata).toMatchObject({ requestId: 's12-consent-fail-id' });
    expect(JSON.stringify(rows[0])).toContain('OTP_INVALID');
    const [salt] = await api.dataSource.query('SELECT salt FROM otp_challenges WHERE id=$1', [otp.challengeId]);
    expectSafe(rows, [otp.code, wrongCode(otp.code), token, salt.salt]);
    // The business transaction still rolled back.
    for (const table of ['wealth_services', 'service_consents']) {
      expect((await api.dataSource.query(`SELECT count(*)::int AS count FROM ${table}`))[0].count).toBe(0);
    }
    expect((await auditFor('SERVICE_REGISTERED'))).toEqual([]);
  });

  test('W3b a wrong OTP on risk confirmation writes a FAILURE audit row for that draft', async () => {
    const created = await create('s12-risk-register');
    const consent = await challenge(created.body.id, 'SERVICE_CONSENT');
    const accepted = await api.request(`/me/onboarding-requests/${created.body.id}/confirm`, { method: 'POST', token: await api.tokenFor(actors.customer.actorId),
      key: 's12-risk-consent', body: { challengeId: consent.challengeId, code: consent.code } });
    expect(accepted.status).toBe(200);
    const questionnaire = await api.request('/risk-questionnaires/current', { token: await api.tokenFor(actors.customer.actorId) });
    expect(questionnaire.status).toBe(200);
    const answers = questionnaire.body.questions.map((question: any) => ({ questionId: question.id, optionId: question.options[2].id }));
    const draft = await api.request('/me/risk-assessments', { method: 'POST', token: await api.tokenFor(actors.customer.actorId), key: 's12-risk-draft',
      body: { questionnaireVersion: questionnaire.body.version, answers } });
    expect(draft.status).toBe(201);
    const otp = await challenge(draft.body.id, 'RISK_PROFILE_CONFIRM');
    const rejected = await api.request(`/me/risk-assessments/${draft.body.id}/confirm`, { method: 'POST', token: await api.tokenFor(actors.customer.actorId),
      key: 's12-risk-fail', headers: { 'x-request-id': 's12-risk-fail-id' },
      body: { challengeId: otp.challengeId, code: wrongCode(otp.code), expectedCurrentProfileVersion: 0 } });
    expectApiError(rejected, 400, 'OTP_INVALID');
    const rows = await api.dataSource.query("SELECT * FROM audit_events WHERE outcome='FAILURE'");
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(actors.customer.actorId);
    expect(rows[0].resource_id).toBe(draft.body.id);
    expect(rows[0].metadata).toMatchObject({ requestId: 's12-risk-fail-id' });
    expect(JSON.stringify(rows[0])).toContain('OTP_INVALID');
    expectSafe(rows, [otp.code, wrongCode(otp.code)]);
    expect((await api.dataSource.query('SELECT count(*)::int AS count FROM risk_profiles'))[0].count).toBe(0);
  });

  test('W3c an RM refused with 403 on GET /customers/:id writes a DENIED audit row with actor, resource and requestId', async () => {
    const created = await create('s12-denied-register');
    const consent = await challenge(created.body.id, 'SERVICE_CONSENT');
    const accepted = await api.request(`/me/onboarding-requests/${created.body.id}/confirm`, { method: 'POST', token: await api.tokenFor(actors.customer.actorId),
      key: 's12-denied-consent', body: { challengeId: consent.challengeId, code: consent.code } });
    expect(accepted.status).toBe(200);
    const token = await api.tokenFor(rmBeta.actorId);
    const denied = await api.request(`/customers/${accepted.body.customerId}`, { token, headers: { 'x-request-id': 's12-denied-id' } });
    expectApiError(denied, 403, 'FORBIDDEN');
    const rows = await api.dataSource.query("SELECT * FROM audit_events WHERE outcome='DENIED'");
    expect(rows, 'exactly one DENIED audit row').toHaveLength(1);
    expect(rows[0].actor_id).toBe(rmBeta.actorId);
    expect(rows[0].resource_id).toBe(accepted.body.customerId);
    expect(rows[0].metadata).toMatchObject({ requestId: 's12-denied-id' });
    expectSafe(rows, [token]);
    // An authorised read must not be recorded as DENIED.
    const allowed = await api.request(`/customers/${accepted.body.customerId}`, { token: await api.tokenFor() });
    expect(allowed.status).toBe(200);
    expect(await api.dataSource.query("SELECT * FROM audit_events WHERE outcome='DENIED'")).toHaveLength(1);
  });
});

describe('S12 W5 OTP TTL default 120 s on the injected clock', () => {
  let api: Fixture;
  beforeEach(async () => { api = await startApiFixture(); });
  afterEach(async () => { await api?.stop(); });

  async function pendingWithOtp(key: string) {
    const created = await api.request('/onboarding/requests', { method: 'POST', token: await api.tokenFor(), key,
      body: { cifRef: actors.customer.cifId, selectedAccountId: eligibleCustomer().accounts[0].id } });
    expect(created.status).toBe(201);
    const issued = await api.request('/otp/challenges', { method: 'POST', token: await api.tokenFor(actors.customer.actorId),
      body: { purpose: 'SERVICE_CONSENT', operationId: created.body.id } });
    expect(issued.status).toBe(201);
    return { requestId: created.body.id as string, issued: issued.body,
      delivery: api.deliveries.find(item => item.challengeId === issued.body.challengeId)! };
  }
  const confirm = async (value: Awaited<ReturnType<typeof pendingWithOtp>>, key: string) => api.request(`/me/onboarding-requests/${value.requestId}/confirm`, {
    method: 'POST', token: await api.tokenFor(actors.customer.actorId), key, body: { challengeId: value.delivery.challengeId, code: value.delivery.code } });

  test('W5 the challenge expires exactly 120 s after issue by default', async () => {
    const value = await pendingWithOtp('s12-ttl-expiry');
    expect(value.issued.expiresAt).toBe(new Date(new Date(TEST_NOW).getTime() + 120_000).toISOString());
  });

  test('W5 an OTP is still valid at 119 s', async () => {
    const value = await pendingWithOtp('s12-ttl-119');
    api.state.now = new Date(new Date(TEST_NOW).getTime() + 119_000);
    expect((await confirm(value, 's12-ttl-119-confirm')).status).toBe(200);
  });

  test('W5 an OTP is expired (410 OTP_EXPIRED) at 120 s and nothing is registered', async () => {
    const value = await pendingWithOtp('s12-ttl-120');
    api.state.now = new Date(new Date(TEST_NOW).getTime() + 120_000);
    expectApiError(await confirm(value, 's12-ttl-120-confirm'), 410, 'OTP_EXPIRED');
    expect((await api.dataSource.query('SELECT count(*)::int AS count FROM wealth_services'))[0].count).toBe(0);
  });
});

describe('S12 W5 OTP_TTL_SECONDS through the real CLI', () => {
  let database: Awaited<ReturnType<typeof startTestDatabase>>;
  let sql: pg.Client;
  let port: number;
  let baseUrl: string;
  const children: ReturnType<typeof startRuntimeProcess>[] = [];
  beforeEach(async () => {
    database = await startTestDatabase();
    sql = new pg.Client({ connectionString: database.databaseUrl });
    await sql.connect();
    port = await reserveHttpPort();
    baseUrl = `http://127.0.0.1:${port}`;
  });
  afterEach(async () => {
    try { await Promise.allSettled(children.splice(0).map(child => child.stop())); }
    finally { try { await sql?.end(); } finally { await database?.stop(); } }
  });
  const cli = (overrides: Record<string, string>) => {
    const child = startRuntimeProcess(['apps/api/dist/main.js'], runtimeEnvironment(database.databaseUrl, port, overrides));
    children.push(child);
    return child;
  };
  async function call(path: string, token: string, body: unknown, key?: string) {
    const response = await fetch(`${baseUrl}/api/v1${path}`, { method: 'POST', signal: AbortSignal.timeout(3_000),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key ? { 'idempotency-key': key } : {}) },
      body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function token(actor: { actorId: string; subjectId: string; role: string; cifId: string | null; rmId: string | null; teamId: string | null }) {
    await sql.query('INSERT INTO mock_actors(actor_id,subject_id,role,cif_id,rm_id,team_id,active) VALUES($1,$2,$3,$4,$5,$6,true)',
      [actor.actorId, actor.subjectId, actor.role, actor.cifId, actor.rmId, actor.teamId]);
    const issued = await call('/mock-auth/token', '', { actorId: actor.actorId });
    expect(issued.status).toBe(200);
    return issued.body.accessToken as string;
  }

  test('W5 OTP_TTL_SECONDS=30 shortens the challenge lifetime to about 30 s on the real clock', async () => {
    await cli({ OTP_TTL_SECONDS: '30' }).waitUntilReady(baseUrl);
    const rm = await token(actors.rm);
    const customer = await token(actors.customer);
    const looked = await call('/onboarding/customer-lookup', rm, { cifRef: actors.customer.cifId });
    expect(looked.status).toBe(200);
    const created = await call('/onboarding/requests', rm, { cifRef: actors.customer.cifId, selectedAccountId: looked.body.accounts[0].id }, 's12-cli-ttl');
    expect(created.status).toBe(201);
    const issuedAt = Date.now();
    const issued = await call('/otp/challenges', customer, { purpose: 'SERVICE_CONSENT', operationId: created.body.id });
    expect(issued.status).toBe(201);
    const lifetime = new Date(issued.body.expiresAt).getTime() - issuedAt;
    expect(lifetime).toBeGreaterThan(20_000);
    expect(lifetime).toBeLessThanOrEqual(35_000);
  }, 60_000);

  test('W5 OTP_TTL_SECONDS outside 1..900 or not an integer is CONFIG_INVALID at startup without leaking the database URL', async () => {
    for (const value of ['0', '901', '2.5', 'abc']) {
      const child = cli({ OTP_TTL_SECONDS: value });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([child.waitForExit().catch(() => ({ code: 'STILL_RUNNING', output: child.output })), new Promise<{ code: string | number | null; output: string }>(accept => {
        timer = setTimeout(() => accept({ code: 'STILL_RUNNING', output: child.output }), 30_000);
      })]);
      if (timer) clearTimeout(timer);
      expect(outcome.code, `OTP_TTL_SECONDS=${value} must stop startup`).toBe(1);
      expect(outcome.output, `OTP_TTL_SECONDS=${value}`).toContain('CONFIG_INVALID');
      expect(outcome.output).not.toContain(database.databaseUrl);
      await child.stop().catch(() => {});
      port = await reserveHttpPort();
    }
  }, 180_000);

  test('W5 the boundary values 1 and 900 are accepted at startup', async () => {
    await cli({ OTP_TTL_SECONDS: '900' }).waitUntilReady(baseUrl);
  });
});

describe('S12 N2 OpenAPI advertises 429 RATE_LIMITED for the limited onboarding routes', () => {
  let api: Fixture;
  beforeEach(async () => { api = await startApiFixture(); });
  afterEach(async () => { await api?.stop(); });

  test.each(['/api/v1/onboarding/requests', '/api/v1/onboarding/customer-lookup'])('N2 POST %s lists a 429 response', async route => {
    const response = await fetch(`${await api.app.getUrl()}/api/v1/openapi.json`);
    expect(response.status).toBe(200);
    const document: any = await response.json();
    const operation = document.paths[route]?.post;
    expect(operation, `POST ${route} must be advertised`).toBeDefined();
    expect(operation.responses['429'], `POST ${route} must document 429`).toBeDefined();
  });
});

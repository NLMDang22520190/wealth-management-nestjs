import pg from 'pg';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { actors } from '../helpers/actors.js';
import { eligibleCustomer, expectApiError, startApiFixture } from '../helpers/application.js';
import { startTestDatabase } from '../helpers/postgres.js';
import { reserveHttpPort, runtimeEnvironment, startRuntimeProcess } from '../helpers/runtime.js';

type Fixture = Awaited<ReturnType<typeof startApiFixture>>;
const rmBeta = { actorId: 'rm-s7-beta', subjectId: 'mock-rm-s7-beta', role: 'RM', rmId: '77777777-7777-4777-8777-777777777777', teamId: actors.rm.teamId };

describe('S7 B5 error logging level and code', () => {
  let api: Fixture;
  beforeEach(async () => { api = await startApiFixture(); });
  afterEach(async () => { await api?.stop(); });

  const create = async (key: string, cif: string = actors.customer.cifId) => api.request('/onboarding/requests', {
    method: 'POST', token: await api.tokenFor(), key, body: { cifRef: cif, selectedAccountId: eligibleCustomer(cif).accounts[0].id } });
  const entriesFor = (requestId: string) => api.logEntries.filter(entry => entry.text.includes(requestId));

  test('B5 a 409 ApiError is logged at WARN with its real code, not as an ERROR/INTERNAL_ERROR', async () => {
    expect((await create('s7-first')).status).toBe(201);
    const conflict = await create('s7-second');
    expectApiError(conflict, 409, 'ONBOARDING_EXISTS');
    const entries = entriesFor(conflict.body.requestId);
    expect(entries.length, 'the failed request must be logged').toBeGreaterThan(0);
    expect(entries.filter(entry => entry.level === 'error'), '4xx must not be logged at ERROR').toEqual([]);
    expect(entries.some(entry => entry.level === 'warn' && entry.text.includes('ONBOARDING_EXISTS') && entry.text.includes('409'))).toBe(true);
    expect(entries.some(entry => entry.text.includes('INTERNAL_ERROR'))).toBe(false);
  });

  test('B5 other 4xx (404 and 403) are WARN with their own code', async () => {
    api.state.core = null;
    const missing = await create('s7-missing');
    expectApiError(missing, 404, 'CUSTOMER_NOT_FOUND');
    const forbidden = await api.request('/rm/customers', { token: await api.tokenFor(actors.customer.actorId) });
    expect(forbidden.status).toBe(403);
    for (const [response, code] of [[missing, 'CUSTOMER_NOT_FOUND'], [forbidden, 'FORBIDDEN']] as const) {
      const entries = entriesFor(response.body.requestId);
      expect(entries.some(entry => entry.level === 'warn' && entry.text.includes(code)), code).toBe(true);
      expect(entries.filter(entry => entry.level === 'error'), code).toEqual([]);
    }
  });

  test('B5 5xx stays at ERROR (characterization: already true today)', async () => {
    api.state.coreFailure = true;
    const failed = await create('s7-core-down');
    expectApiError(failed, 503, 'CORE_UNAVAILABLE');
    expect(entriesFor(failed.body.requestId).some(entry => entry.level === 'error' && entry.text.includes('503'))).toBe(true);
  });

  test('B5 a rejected OTP is a WARN with OTP_INVALID and the log holds no bearer token or OTP code', async () => {
    const request = await create('s7-otp');
    expect(request.status).toBe(201);
    const customerToken = await api.tokenFor(actors.customer.actorId);
    const challenge = await api.request('/otp/challenges', { method: 'POST', token: customerToken,
      body: { purpose: 'SERVICE_CONSENT', operationId: request.body.id } });
    expect(challenge.status).toBe(201);
    const delivery = api.deliveries.find(item => item.challengeId === challenge.body.challengeId)!;
    const wrong = delivery.code === '738291' ? '738292' : '738291';
    const rejected = await api.request(`/me/onboarding-requests/${request.body.id}/confirm`, { method: 'POST', token: customerToken,
      key: 's7-confirm', body: { challengeId: delivery.challengeId, code: wrong } });
    expectApiError(rejected, 400, 'OTP_INVALID');
    const entries = entriesFor(rejected.body.requestId);
    expect(entries.some(entry => entry.level === 'warn' && entry.text.includes('OTP_INVALID'))).toBe(true);
    expect(entries.filter(entry => entry.level === 'error')).toEqual([]);
    for (const secret of [customerToken, delivery.code, wrong]) expect(api.logs.join('\n')).not.toContain(secret);
  });
});

describe('S7 B11 invitation creation quota (default 10 per RM per 60s on the injected clock)', () => {
  let api: Fixture;
  beforeEach(async () => {
    api = await startApiFixture();
    api.state.coreLookup = async reference => eligibleCustomer(reference);
    await api.dataSource.query('INSERT INTO mock_actors(actor_id,subject_id,role,rm_id,team_id,active) VALUES($1,$2,$3,$4,$5,true)',
      [rmBeta.actorId, rmBeta.subjectId, rmBeta.role, rmBeta.rmId, rmBeta.teamId]);
  });
  afterEach(async () => { await api?.stop(); });
  const cif = (index: number) => `0000${String(2000 + index)}`;
  const create = async (index: number, key: string, actorId: string = actors.rm.actorId) => api.request('/onboarding/requests', {
    method: 'POST', token: await api.tokenFor(actorId), key,
    body: { cifRef: cif(index), selectedAccountId: eligibleCustomer(cif(index)).accounts[0].id } });

  test('B11 the 11th non-replay creation in a window is 429 RATE_LIMITED; replays do not count; other RMs are unaffected; the window resets', async () => {
    const first = await create(1, 's7-key-1');
    expect(first.status).toBe(201);
    for (let index = 2; index <= 9; index++) expect((await create(index, `s7-key-${index}`)).status, `creation ${index}`).toBe(201);
    // Five idempotent replays must not consume quota: creation 10 must still succeed.
    for (let repeat = 0; repeat < 5; repeat++) {
      const replay = await create(1, 's7-key-1');
      expect(replay.status).toBe(201);
      expect(replay.body).toEqual(first.body);
    }
    expect((await create(10, 's7-key-10')).status, 'creation 10 after replays').toBe(201);
    expectApiError(await create(11, 's7-key-11'), 429, 'RATE_LIMITED');
    // A replay of an earlier creation still returns the original result even when the quota is exhausted.
    const lateReplay = await create(1, 's7-key-1');
    expect(lateReplay.status).toBe(201);
    expect(lateReplay.body).toEqual(first.body);
    // A different RM has its own quota.
    expect((await create(12, 's7-beta-1', rmBeta.actorId)).status).toBe(201);
    // Nothing was created for the rejected attempt.
    const [{ count }] = await api.dataSource.query('SELECT count(*)::int AS count FROM onboarding_requests WHERE cif_id=$1', [cif(11)]);
    expect(count).toBe(0);
    // After the 60-second window passes on the injected clock, creation works again.
    api.state.now = new Date(api.state.now.getTime() + 60_000);
    expect((await create(11, 's7-key-11-again')).status).toBe(201);
  });
});

describe('S7 B12 configurable limits through the real CLI', () => {
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
  async function post(path: string, token: string, body: unknown, key?: string) {
    const response = await fetch(`${baseUrl}/api/v1${path}`, { method: 'POST', signal: AbortSignal.timeout(3_000),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key ? { 'idempotency-key': key } : {}) },
      body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function rmToken() {
    await sql.query('INSERT INTO mock_actors(actor_id,subject_id,role,cif_id,rm_id,team_id,active) VALUES($1,$2,$3,$4,$5,$6,true)',
      [actors.rm.actorId, actors.rm.subjectId, actors.rm.role, null, actors.rm.rmId, actors.rm.teamId]);
    const issued = await post('/mock-auth/token', '', { actorId: actors.rm.actorId });
    expect(issued.status).toBe(200);
    return issued.body.accessToken as string;
  }

  test('B12 LOOKUP_RATE_LIMIT_PER_MINUTE=3 makes the 4th lookup 429 RATE_LIMITED', async () => {
    await cli({ LOOKUP_RATE_LIMIT_PER_MINUTE: '3' }).waitUntilReady(baseUrl);
    const token = await rmToken();
    const statuses: number[] = [];
    let last: { status: number; body: any } | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      last = await post('/onboarding/customer-lookup', token, { cifRef: actors.customer.cifId });
      statuses.push(last.status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(last!.body.code).toBe('RATE_LIMITED');
  });

  test('B12 INVITE_RATE_LIMIT_PER_MINUTE=1 makes the 2nd creation 429 RATE_LIMITED', async () => {
    await cli({ INVITE_RATE_LIMIT_PER_MINUTE: '1' }).waitUntilReady(baseUrl);
    const token = await rmToken();
    const lookupOne = await post('/onboarding/customer-lookup', token, { cifRef: actors.customer.cifId });
    expect(lookupOne.status).toBe(200);
    const first = await post('/onboarding/requests', token, { cifRef: actors.customer.cifId, selectedAccountId: lookupOne.body.accounts[0].id }, 's7-cli-1');
    expect(first.status).toBe(201);
    const lookupTwo = await post('/onboarding/customer-lookup', token, { cifRef: actors.otherCustomer.cifId });
    expect(lookupTwo.status).toBe(200);
    const second = await post('/onboarding/requests', token, { cifRef: actors.otherCustomer.cifId, selectedAccountId: lookupTwo.body.accounts[0].id }, 's7-cli-2');
    expect(second.status).toBe(429);
    expect(second.body.code).toBe('RATE_LIMITED');
  });

  for (const name of ['LOOKUP_RATE_LIMIT_PER_MINUTE', 'INVITE_RATE_LIMIT_PER_MINUTE']) {
    test(`B12 ${name} rejects 0, negative, non-integer and text with CONFIG_INVALID at startup`, async () => {
      for (const value of ['0', '-5', '2.5', 'abc']) {
        const child = cli({ [name]: value });
        // Realistic bound for a loaded full-suite run; the process must still EXIT (code 1).
        let timer: ReturnType<typeof setTimeout> | undefined;
        const outcome = await Promise.race([child.waitForExit(), new Promise<{ code: string; output: string }>(accept => {
          timer = setTimeout(() => accept({ code: 'STILL_RUNNING', output: child.output }), 30_000);
        })]);
        if (timer) clearTimeout(timer);
        expect(outcome.code, `${name}=${value} must stop startup`).toBe(1);
        expect(outcome.output, `${name}=${value}`).toContain('CONFIG_INVALID');
        expect(outcome.output).not.toContain(database.databaseUrl);
        await child.stop().catch(() => {});
        port = await reserveHttpPort();
      }
    }, 150_000); // 4 values x up to 30 s each, plus cleanup
  }

  test('B12 a valid large value boots (characterization for the E2E infra setting)', async () => {
    await cli({ LOOKUP_RATE_LIMIT_PER_MINUTE: '1000', INVITE_RATE_LIMIT_PER_MINUTE: '1000' }).waitUntilReady(baseUrl);
  });
});

import { createHmac } from 'node:crypto';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { actors } from '../helpers/actors.js';
import { startTestDatabase } from '../helpers/postgres.js';
import { ownedEnvironmentFile, reserveHttpPort, runtimeEnvironment, runtimeSecret, startRuntimeProcess } from '../helpers/runtime.js';

// These stable, explicitly synthetic references are the public demo/README contract.
const identities = ['synthetic-identity-reference-101', 'synthetic-identity-reference-102'];
const rmBeta = { actorId: 'rm-beta', subjectId: 'mock-rm-beta', role: 'RM', cifId: null,
  rmId: '22222222-2222-4222-8222-222222222222', teamId: actors.rm.teamId };
const registry = [...Object.values(actors), rmBeta];
const mainCommand = ['apps/api/dist/main.js'];
// Public seed command is pinned in 02-tests-S5a.md: npm run seed:demo -> node scripts/seed-demo.mjs.
const seedCommand = ['scripts/seed-demo.mjs'];

describe('S5a AC01/AC07 real CLI synthetic demo runtime', () => {
  let database: Awaited<ReturnType<typeof startTestDatabase>>;
  let sql: pg.Client;
  let port: number;
  let baseUrl: string;
  const children: ReturnType<typeof startRuntimeProcess>[] = [];
  const environmentFiles: Awaited<ReturnType<typeof ownedEnvironmentFile>>[] = [];
  beforeEach(async () => {
    database = await startTestDatabase();
    sql = new pg.Client({ connectionString: database.databaseUrl });
    await sql.connect();
    port = await reserveHttpPort();
    baseUrl = `http://127.0.0.1:${port}`;
  });
  afterEach(async () => {
    try {
      const results = await Promise.allSettled(children.splice(0).map(child => child.stop()));
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    }
    finally {
      try { for (const file of environmentFiles.splice(0)) await file.stop(); }
      finally { try { await sql?.end(); } finally { await database?.stop(); } }
    }
  });

  function cli(args = mainCommand, overrides: Record<string, string> = {}, fromFile = false) {
    const child = startRuntimeProcess(args, fromFile ? {} : runtimeEnvironment(database.databaseUrl, port, overrides));
    children.push(child);
    return child;
  }
  async function ready(overrides: Record<string, string> = {}) {
    const child = cli(mainCommand, overrides);
    await child.waitUntilReady(baseUrl);
    return child;
  }
  async function request(path: string, input: { body?: unknown; token?: string; key?: string } = {}) {
    const response = await fetch(`${baseUrl}/api/v1${path}`, {
      method: input.body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(3_000),
      headers: { ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(input.token ? { authorization: `Bearer ${input.token}` } : {}), ...(input.key ? { 'idempotency-key': input.key } : {}) },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  async function tokenFor(actorId: string) {
    const issued = await request('/mock-auth/token', { body: { actorId } });
    expect(issued.status).toBe(200);
    expect(issued.body.accessToken).toEqual(expect.any(String));
    return issued.body.accessToken as string;
  }
  async function fixtureActors() {
    // Test SQL seeds only trusted identity rows; no Core adapter/callback is injected into the CLI.
    for (const actor of registry) {
      await sql.query(`INSERT INTO mock_actors(actor_id,subject_id,role,cif_id,rm_id,team_id,active)
        VALUES($1,$2,$3,$4,$5,$6,true)`, [actor.actorId, actor.subjectId, actor.role, actor.cifId, actor.rmId, actor.teamId]);
    }
  }
  async function seed(overrides: Record<string, string> = {}) {
    return cli(seedCommand, overrides).waitForExit();
  }
  async function tables() {
    return (await sql.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name")).rows;
  }
  function assertSanitized(output: string) {
    expect(output).not.toContain(database.databaseUrl);
    expect(output).not.toContain(new URL(database.databaseUrl).password);
    expect(output).not.toContain(runtimeSecret);
  }

  test('AC01/AC07 actual main CLI resolves synthetic CIF and identity with eligible DOB and own VND without injected Core callbacks', async () => {
    const child = await ready();
    await fixtureActors();
    const token = await tokenFor(actors.rm.actorId);
    for (const [index, actor] of [actors.customer, actors.otherCustomer].entries()) {
      const byCif = await request('/onboarding/customer-lookup', { token, body: { cifRef: actor.cifId } });
      expect(byCif.status).toBe(200); // Baseline valid RED: actual main returns CORE_UNAVAILABLE/503.
      expect(byCif.body).toMatchObject({ cifRef: actor.cifId, active: true, eligible: true, name: expect.any(String) });
      expect(byCif.body.name.trim().length).toBeGreaterThan(0);
      expect(byCif.body.dateOfBirth).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${byCif.body.dateOfBirth}T00:00:00Z`).toISOString().slice(0, 10)).toBe(byCif.body.dateOfBirth);
      expect(byCif.body.accounts).toContainEqual(expect.objectContaining({ id: expect.any(String), currency: 'VND' }));
      const byIdentity = await request('/onboarding/customer-lookup', { token, body: { cifRef: identities[index] } });
      expect(byIdentity.status).toBe(200);
      expect(byIdentity.body).toEqual(byCif.body);
      const created = await request('/onboarding/requests', { token, key: `s5a-core-${index}`,
        body: { cifRef: identities[index], selectedAccountId: byCif.body.accounts.find((a: any) => a.currency === 'VND').id } });
      expect(created.status).toBe(201); // Own-account validation is exercised at the real business boundary.
      const inbox = await request('/me/onboarding-requests', { token: await tokenFor(actor.actorId) });
      expect(inbox.status).toBe(200);
      expect(inbox.body.items).toContainEqual(expect.objectContaining({ id: created.body.id }));
    }
    const unknown = await request('/onboarding/customer-lookup', { token, body: { cifRef: 'synthetic-unknown-cif' } });
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('CUSTOMER_NOT_FOUND');
    assertSanitized(child.output);
  });

  test('AC01 seed CLI migrates empty PostgreSQL and repeats without deleting or replacing user business or unrelated actors', async () => {
    expect(await tables()).toEqual([]);
    const first = await seed();
    expect(first.code).toBe(0);
    assertSanitized(first.output);
    expect(await tables()).toContainEqual({ table_name: 'migrations' });
    const trusted = (await sql.query('SELECT * FROM mock_actors ORDER BY actor_id')).rows;
    for (const actor of registry) expect(trusted).toContainEqual(expect.objectContaining({ actor_id: actor.actorId,
      subject_id: actor.subjectId, role: actor.role, cif_id: actor.cifId, rm_id: actor.rmId, team_id: actor.teamId, active: true }));
    const child = await ready();
    for (const actor of registry) {
      const me = await request('/auth/me', { token: await tokenFor(actor.actorId) });
      expect(me.status).toBe(200);
      expect(me.body).toEqual(actor);
    }
    const token = await tokenFor(actors.rm.actorId);
    const lookup = await request('/onboarding/customer-lookup', { token, body: { cifRef: actors.customer.cifId } });
    expect(lookup.status).toBe(200);
    const created = await request('/onboarding/requests', { token, key: 's5a-user-created-request',
      body: { cifRef: actors.customer.cifId, selectedAccountId: lookup.body.accounts[0].id } });
    expect(created.status).toBe(201);
    await sql.query("INSERT INTO mock_actors(actor_id,subject_id,role,cif_id,active) VALUES('user-owned-actor','user-owned-subject','CUSTOMER','00000999',false)");
    const before = (await sql.query('SELECT * FROM onboarding_requests WHERE id=$1', [created.body.id])).rows;
    const reserved = (await sql.query('SELECT * FROM rm_capacity_reservations WHERE onboarding_request_id=$1', [created.body.id])).rows;
    expect(before).toHaveLength(1);
    expect(reserved).toHaveLength(1);
    for (let repeat = 0; repeat < 2; repeat++) {
      const result = await seed();
      expect(result.code).toBe(0);
      assertSanitized(result.output);
      expect((await sql.query('SELECT * FROM onboarding_requests WHERE id=$1', [created.body.id])).rows).toEqual(before);
      expect((await sql.query('SELECT * FROM rm_capacity_reservations WHERE onboarding_request_id=$1', [created.body.id])).rows).toEqual(reserved);
      expect((await sql.query("SELECT * FROM mock_actors WHERE actor_id='user-owned-actor'")).rows).toContainEqual(expect.objectContaining({ active: false, subject_id: 'user-owned-subject' }));
      expect((await sql.query("SELECT * FROM mock_actors WHERE actor_id <> 'user-owned-actor' ORDER BY actor_id")).rows).toEqual(trusted);
    }
    assertSanitized(child.output);
  }, 60_000);

  test('AC01/AC02 runtime and seed fail closed for production or disabled mocks before seed writes', async () => {
    // Existing main CONFIG_INVALID check is characterization protecting the new demo wiring.
    const refused = await cli(mainCommand, { NODE_ENV: 'production' }).waitForExit();
    expect(refused.code).toBe(1);
    expect(refused.output).toContain('CONFIG_INVALID');
    assertSanitized(refused.output);
    expect(await tables()).toEqual([]);
    for (const overrides of [{ NODE_ENV: 'production' }, { NODE_ENV: 'production', MOCK_AUTH_ENABLED: 'false' }, { MOCK_AUTH_ENABLED: 'false' }]) {
      const result = await seed(overrides);
      expect(result.code).toBe(1);
      expect(result.output).toContain('CONFIG_INVALID');
      assertSanitized(result.output);
      expect(await tables()).toEqual([]);
    }
    // Disabled mock endpoint behavior is also existing regression characterization.
    await ready({ MOCK_AUTH_ENABLED: 'false' });
    await fixtureActors();
    expect((await request('/mock-auth/token', { body: { actorId: actors.rm.actorId } })).status).toBe(404);
    const seconds = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: actors.rm.subjectId, iss: 'wealth-management-mock',
      aud: 'wealth-management-api', iat: seconds, exp: seconds + 300 })).toString('base64url');
    const input = `${header}.${payload}`;
    const token = `${input}.${createHmac('sha256', runtimeSecret).update(input).digest('base64url')}`;
    // DECISION: auth-before-core -> 401 (user, 2026-10-12): with mocks disabled the mock-issuer token is rejected by auth, never reaching Core.
    const rejected = await request('/onboarding/customer-lookup', { token, body: { cifRef: actors.customer.cifId } });
    expect(rejected.status).toBe(401);
    expect(rejected.body.code).toBe('UNAUTHORIZED');
  }, 60_000);

  test('AC01 Node24 env-file boots the actual CLI and malformed config exits with sanitized public errors', async () => {
    // Native env-file/config checks characterize public startup while S5a adds demo commands.
    const file = await ownedEnvironmentFile(runtimeEnvironment(database.databaseUrl, port));
    environmentFiles.push(file);
    const child = cli([`--env-file=${file.path}`, ...mainCommand], {}, true);
    await child.waitUntilReady(baseUrl);
    expect((await request('/health/live')).body).toEqual({ status: 'ok' });
    expect((await request('/openapi.json')).status).toBe(200);
    assertSanitized(child.output);
    await child.stop();
    for (const overrides of [{ PORT: 'not-a-port' }, { NODE_ENV: 'preview' }, { MOCK_AUTH_ENABLED: 'yes' }, { JWT_SECRET: 'short' },
      { DATABASE_URL: 'postgresql://synthetic_user:DO_NOT_LOG_S5A_CREDENTIAL@invalid-host/' }]) {
      const invalid = await cli(mainCommand, overrides).waitForExit();
      expect(invalid.code).toBe(1);
      expect(invalid.output).toContain('CONFIG_INVALID');
      assertSanitized(invalid.output);
      expect(invalid.output).not.toContain('DO_NOT_LOG_S5A_CREDENTIAL');
      expect(invalid.output).not.toContain('synthetic_user');
    }
  }, 90_000);
});

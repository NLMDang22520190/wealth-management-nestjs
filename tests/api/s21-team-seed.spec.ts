import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { actors, insertStaff, viaPg } from '../helpers/actors.js';
import { startTestDatabase } from '../helpers/postgres.js';
import { reserveHttpPort, runtimeEnvironment, runtimeRoot, runtimeSecret, startRuntimeProcess } from '../helpers/runtime.js';

/**
 * R9 S2 (AC3 seed part, AC4 demo login, AC6 Core mock). Real CLIs only: `scripts/seed-demo.mjs` (npm run seed:demo) and
 * `apps/api/dist/main.js`; the Core mock is the one wired by main (no injected callback).
 * Data from outside: names, DOB, CASA numbers, UUIDs and codes below are copied from the team's wms_seed.sql
 * (sha256 b72cb689...), so tester and implementer cannot agree on a wrong mapping by accident.
 */
const SEED_SHA256 = 'b72cb689a0324d20ed890c136a4b2216cae2e87187d90905d8bcbc2ede77a89f';
const SEED_PATH = 'scripts/team-seed/wms_seed.sql';
const TEAM_ID = 'a0000000-0000-0000-0000-000000000001';
const staffId = (n: number) => `b0000000-0000-0000-0000-00000000000${n}`;
const seedCommand = ['scripts/seed-demo.mjs'];
const mainCommand = ['apps/api/dist/main.js'];

describe('S21 R9-S2 vendored team seed, demo login and Core mock', () => {
  let database: Awaited<ReturnType<typeof startTestDatabase>>;
  let sql: pg.Client;
  let port: number;
  let baseUrl: string;
  const children: ReturnType<typeof startRuntimeProcess>[] = [];
  const extraDatabases: Array<Awaited<ReturnType<typeof startTestDatabase>>> = [];

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
    } finally {
      try { for (const extra of extraDatabases.splice(0)) await extra.stop(); }
      finally { try { await sql?.end(); } finally { await database?.stop(); } }
    }
  });

  function cli(args: string[], target = database.databaseUrl, overrides: Record<string, string> = {}) {
    const child = startRuntimeProcess(args, runtimeEnvironment(target, port, overrides));
    children.push(child);
    return child;
  }
  const seed = (target = database.databaseUrl) => cli(seedCommand, target).waitForExit();
  async function ready() {
    const child = cli(mainCommand);
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
    expect(issued.status, `mock token for ${actorId}`).toBe(200);
    return issued.body.accessToken as string;
  }
  const rows = async (text: string, params: unknown[] = []) => (await sql.query(text, params)).rows;
  async function wmsTables(client: pg.Client) {
    return (await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='wms' AND table_type='BASE TABLE' ORDER BY table_name"))
      .rows.map(row => row.table_name as string);
  }
  async function counts(client: pg.Client) {
    const result: Record<string, number> = {};
    for (const table of await wmsTables(client)) result[table] = Number((await client.query(`SELECT count(*) AS n FROM wms."${table}"`)).rows[0].n);
    return result;
  }

  test('AC3 the vendored team seed file is in the repo, byte-identical (sha256 pinned)', async () => {
    const bytes = await readFile(join(runtimeRoot, SEED_PATH));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(SEED_SHA256);
    expect(bytes.length).toBeGreaterThan(10_000); // the real 356-line file, not a stub
  });

  test('AC3 seed:demo on a migrated DB loads the team data: staff, customers, pending invitation, assets, accounts', async () => {
    const first = await seed();
    expect(first.code, first.output).toBe(0);
    expect(first.output).not.toContain(database.databaseUrl);
    expect(first.output).not.toContain(new URL(database.databaseUrl).password);

    const staff = await rows('SELECT employee_code, role, iam_subject, full_name, is_active, team_id, staff_id FROM wms.staff_users ORDER BY employee_code');
    expect(staff.map(row => [row.employee_code, row.role, row.iam_subject, row.full_name, row.is_active])).toEqual([
      ['NV0001', 'LEADER', 'iam.lan.tt', 'Trần Thị Lan', true],
      ['NV0002', 'RM', 'iam.an.nv', 'Nguyễn Văn An', true],
      ['NV0003', 'RM', 'iam.bao.lm', 'Lê Minh Bảo', true],
      ['NV0004', 'BACK_OFFICE', 'iam.ha.pt', 'Phạm Thu Hà', true],
      ['NV0005', 'BACK_OFFICE_MANAGER', 'iam.minh.hd', 'Hoàng Đức Minh', true],
    ]);
    expect(staff.filter(row => row.employee_code <= 'NV0003').every(row => row.team_id === TEAM_ID && row.staff_id === staffId(Number(row.employee_code.slice(-1))))).toBe(true);
    expect((await rows("SELECT leader_id FROM wms.teams WHERE team_code='HN-WM-01'"))[0].leader_id).toBe(staffId(1));

    const customers = await rows('SELECT cif_id, iam_subject, full_name, to_char(date_of_birth,\'YYYY-MM-DD\') AS dob FROM wms.customers ORDER BY cif_id');
    expect(customers).toEqual([
      { cif_id: 'CIF100001', iam_subject: 'cust.cif100001', full_name: 'Nguyễn Thị Mai', dob: '1968-03-12' },
      { cif_id: 'CIF100002', iam_subject: 'cust.cif100002', full_name: 'Trần Quốc Huy', dob: '1985-07-25' },
      { cif_id: 'CIF100003', iam_subject: 'cust.cif100003', full_name: 'Võ Thanh Tâm', dob: '1990-11-02' },
      { cif_id: 'CIF100004', iam_subject: 'cust.cif100004', full_name: 'Đặng Hải Yến', dob: '1979-01-30' },
    ]);
    // CIF100005: invitation still waiting for the customer, with an active capacity reservation of RM An (NV0002).
    expect(await rows("SELECT customer_name, selected_casa_no, status, rm_id FROM wms.onboarding_requests WHERE cif_id='CIF100005'"))
      .toEqual([{ customer_name: 'Bùi Gia Khánh', selected_casa_no: '0011000123455', status: 'PENDING_CONSENT', rm_id: staffId(2) }]);
    expect(await rows("SELECT r.status FROM wms.rm_capacity_reservations r JOIN wms.onboarding_requests o USING (request_id) WHERE o.cif_id='CIF100005'"))
      .toEqual([{ status: 'ACTIVE' }]);
    // Huy was transferred from RM An to RM Bao (assignment version 2 is current); Yen belongs to An.
    expect(await rows(`SELECT c.cif_id, s.employee_code, a.version FROM wms.rm_assignments a JOIN wms.customers c USING (customer_id)
      JOIN wms.staff_users s ON s.staff_id=a.rm_id WHERE a.valid_to IS NULL ORDER BY c.cif_id`)).toEqual([
      { cif_id: 'CIF100001', employee_code: 'NV0002', version: 1 }, { cif_id: 'CIF100002', employee_code: 'NV0003', version: 2 },
      { cif_id: 'CIF100003', employee_code: 'NV0003', version: 1 }, { cif_id: 'CIF100004', employee_code: 'NV0002', version: 1 }]);
    expect((await rows('SELECT count(*)::int AS n FROM wms.assets'))[0].n).toBe(8);
    expect(await rows('SELECT account_no, cif_id FROM wms.investment_accounts ORDER BY account_no')).toEqual([
      { account_no: 'WM0000000001', cif_id: 'CIF100001' }, { account_no: 'WM0000000002', cif_id: 'CIF100002' },
      { account_no: 'WM0000000003', cif_id: 'CIF100003' }, { account_no: 'WM0000000004', cif_id: 'CIF100004' }]);
    expect((await rows("SELECT code FROM wms.ledger_accounts WHERE type='CUSTOMER_INVESTMENT' ORDER BY code")).map(row => row.code))
      .toEqual(['CI-WM0000000001', 'CI-WM0000000002', 'CI-WM0000000003', 'CI-WM0000000004']);
    expect((await rows("SELECT status FROM wms.wealth_services s JOIN wms.customers c USING (customer_id) WHERE c.cif_id='CIF100004'"))[0].status).toBe('PENDING_RISK_ASSESSMENT');
    expect((await rows("SELECT kind FROM wms.customer_notifications n JOIN wms.customers c USING (customer_id) WHERE c.cif_id='CIF100004'")).map(row => row.kind)).toEqual(['RISK_SURVEY_REMINDER']);
  }, 90_000);

  test('AC3 exactly one transformation: demo-risk-v1-vi is RETIRED, demo-risk-v2-vi stays the only ACTIVE version, every other row equals the raw team seed', async () => {
    const first = await seed();
    expect(first.code, first.output).toBe(0);
    expect(await rows('SELECT version, status FROM wms.risk_questionnaire_versions ORDER BY version')).toEqual([
      { version: 'demo-risk-v1', status: 'RETIRED' }, { version: 'demo-risk-v1-vi', status: 'RETIRED' }, { version: 'demo-risk-v2-vi', status: 'ACTIVE' }]);

    // Reference: a second migrated DB (no seed) loaded with the raw vendored file, changing only the status literal of demo-risk-v1-vi.
    const reference = await startTestDatabase();
    extraDatabases.push(reference);
    const { createApplication } = await import(/* @vite-ignore */ new URL('../../apps/api/dist/application.js', import.meta.url).href);
    const migrated = await createApplication({ databaseUrl: reference.databaseUrl, environment: 'test', mockEnabled: true, jwtSecret: runtimeSecret,
      clock: { now: () => new Date() }, logger: { log() {}, error() {}, warn() {}, debug() {}, verbose() {} } });
    await migrated.app.close();
    if (migrated.dataSource.isInitialized) await migrated.dataSource.destroy();
    const raw = await readFile(join(runtimeRoot, SEED_PATH), 'utf8');
    const edited = raw.replace("'::jsonb, 'ACTIVE', '2025-01-01 00:00+07');", "'::jsonb, 'RETIRED', '2025-01-01 00:00+07');");
    expect(edited, 'the only edit is the status literal of the demo-risk-v1-vi row').not.toBe(raw);
    expect(raw.split("'::jsonb, 'ACTIVE', '2025-01-01 00:00+07');")).toHaveLength(2);
    const referenceClient = new pg.Client({ connectionString: reference.databaseUrl });
    await referenceClient.connect();
    try {
      await referenceClient.query(edited);
      // Every table has the same number of rows as the raw seed produces.
      expect(await counts(sql)).toEqual(await counts(referenceClient));
      // Deterministic tables are identical column by column (time-relative CIF100005 rows, generated keys and `now()` default timestamps are excluded).
      const same = async (name: string, query: string) => expect((await sql.query(query)).rows, name).toEqual((await referenceClient.query(query)).rows);
      await same('teams', `SELECT (to_jsonb(t) - 'created_at' - 'updated_at')::text AS r FROM wms.teams t ORDER BY team_id`);
      await same('staff_users', `SELECT (to_jsonb(t) - 'created_at' - 'updated_at')::text AS r FROM wms.staff_users t ORDER BY staff_id`);
      await same('customers', 'SELECT to_jsonb(t)::text AS r FROM wms.customers t ORDER BY customer_id');
      await same('service_terms', `SELECT (to_jsonb(t) - 'created_at' - 'updated_at')::text AS r FROM wms.service_terms t ORDER BY terms_version`);
      await same('questionnaires', `SELECT (to_jsonb(t) - 'created_at' - 'updated_at')::text AS r FROM wms.risk_questionnaire_versions t ORDER BY version`);
      await same('assets', `SELECT (to_jsonb(t) - 'created_at' - 'updated_at')::text AS r FROM wms.assets t ORDER BY asset_id`);
      await same('investment_accounts', `SELECT (to_jsonb(t) - 'created_at' - 'updated_at')::text AS r FROM wms.investment_accounts t ORDER BY account_id`);
      await same('risk_profiles', `SELECT (to_jsonb(t) - 'created_at' - 'updated_at')::text AS r FROM wms.risk_profiles t ORDER BY risk_profile_id`);
      await same('wealth_services', `SELECT (to_jsonb(t) - 'created_at' - 'updated_at')::text AS r FROM wms.wealth_services t ORDER BY service_id`);
      await same('confirmed onboarding requests', "SELECT (to_jsonb(t) - 'created_at' - 'updated_at')::text AS r FROM wms.onboarding_requests t WHERE status='CONFIRMED' ORDER BY request_id");
      // snapshot_kind comes from migration 009, on top of the team DDL; seed rows take its default.
      await same('portfolio_snapshots', `SELECT (to_jsonb(t) - 'created_at' - 'updated_at' - 'snapshot_kind')::text AS r FROM wms.portfolio_snapshots t ORDER BY snapshot_id`);
    } finally { await referenceClient.end(); }
  }, 120_000);

  test('AC3 a second seed:demo run exits 0, adds no duplicate rows and keeps user changes', async () => {
    expect((await seed()).code).toBe(0);
    const before = await counts(sql);
    expect(before.staff_users).toBe(5);
    expect(before.customers).toBe(4);
    await sql.query("UPDATE wms.customers SET full_name='Tên do người dùng sửa' WHERE cif_id='CIF100001'");
    await sql.query("INSERT INTO wms.customers(cif_id,full_name) VALUES('USER-OWNED-1','Khách do người dùng tạo')");
    for (let repeat = 0; repeat < 2; repeat++) {
      const again = await seed();
      expect(again.code, again.output).toBe(0);
      expect(again.output).not.toContain(database.databaseUrl);
    }
    const after = await counts(sql);
    expect(after).toEqual({ ...before, customers: 5 });
    expect((await rows("SELECT full_name FROM wms.customers WHERE cif_id='CIF100001'"))[0].full_name).toBe('Tên do người dùng sửa');
    expect((await rows("SELECT count(*)::int AS n FROM wms.customers WHERE cif_id='USER-OWNED-1'"))[0].n).toBe(1);
    expect(await rows('SELECT version, status FROM wms.risk_questionnaire_versions WHERE status=\'ACTIVE\'')).toEqual([{ version: 'demo-risk-v2-vi', status: 'ACTIVE' }]);
  }, 120_000);

  test('AC3 the seed is not loaded by the application itself: a migrated DB without seed:demo has no team staff', async () => {
    await ready();
    expect((await rows('SELECT count(*)::int AS n FROM wms.staff_users'))[0].n).toBe(0);
    expect((await rows("SELECT version FROM wms.risk_questionnaire_versions WHERE status='ACTIVE'")).map(row => row.version)).toEqual(['demo-risk-v2-vi']);
  }, 60_000);

  test('AC4 after seeding, mock login works for NV0001 (LEADER), NV0002 (RM) and CIF100001 (customer) with identity from the seed rows', async () => {
    expect((await seed()).code).toBe(0);
    await ready();
    const identity = async (actorId: string) => (await request('/auth/me', { token: await tokenFor(actorId) })).body;
    expect(await identity('NV0001')).toEqual({ actorId: 'NV0001', subjectId: 'iam.lan.tt', role: 'LEADER', cifId: null, rmId: null, teamId: TEAM_ID });
    expect(await identity('NV0002')).toEqual({ actorId: 'NV0002', subjectId: 'iam.an.nv', role: 'RM', cifId: null, rmId: staffId(2), teamId: TEAM_ID });
    expect(await identity('NV0003')).toMatchObject({ actorId: 'NV0003', role: 'RM', rmId: staffId(3) });
    expect(await identity('CIF100001')).toEqual({ actorId: 'CIF100001', subjectId: 'cust.cif100001', role: 'CUSTOMER', cifId: 'CIF100001', rmId: null, teamId: null });
    // CIF100005 has only an invitation: it may log in to consent (AC4).
    expect(await identity('CIF100005')).toMatchObject({ actorId: 'CIF100005', role: 'CUSTOMER', cifId: 'CIF100005', subjectId: 'cust.cif100005' });
  }, 90_000);

  test('AC4 after seeding, NV0004 and NV0005 log in with their roles; the old demo ids and unknown ids are 401 UNAUTHORIZED', async () => {
    expect((await seed()).code).toBe(0);
    // Guard: both back-office staff exist and are active in the seeded DB.
    expect((await rows("SELECT employee_code, role, is_active FROM wms.staff_users WHERE employee_code IN ('NV0004','NV0005') ORDER BY employee_code")))
      .toEqual([{ employee_code: 'NV0004', role: 'BACK_OFFICE', is_active: true }, { employee_code: 'NV0005', role: 'BACK_OFFICE_MANAGER', is_active: true }]);
    await ready();
    expect((await request('/mock-auth/token', { body: { actorId: 'NV0004' } })).status, 'NV0004 logs in for P2').toBe(200);
    expect((await request('/mock-auth/token', { body: { actorId: 'NV0005' } })).status, 'NV0005 approves prices for P3').toBe(200);
    for (const actorId of ['rm-alpha','customer-alpha', 'leader-alpha', 'NV0099', 'CIF100099', 'cif100001']) {
      const refused = await request('/mock-auth/token', { body: { actorId } });
      expect(refused.status, `${actorId} must not log in`).toBe(401);
      expect(refused.body.code).toBe('UNAUTHORIZED');
    }
  }, 90_000);

  test('AC4 a seeded RM sees only the customers assigned to them (An: Mai and Yen; Bao: Huy and Tam), by CIF', async () => {
    expect((await seed()).code).toBe(0);
    await ready();
    const cifsOf = async (actorId: string) => {
      const list = await request('/rm/customers?page=1&pageSize=50', { token: await tokenFor(actorId) });
      expect(list.status).toBe(200);
      return (list.body.items as Array<{ customerId: string }>).map(item => item.customerId).sort();
    };
    const idOf = async (cif: string) => (await rows('SELECT customer_id FROM wms.customers WHERE cif_id=$1', [cif]))[0].customer_id as string;
    expect(await cifsOf('NV0002')).toEqual([await idOf('CIF100001'), await idOf('CIF100004')].sort());
    expect(await cifsOf('NV0003')).toEqual([await idOf('CIF100002'), await idOf('CIF100003')].sort());
  }, 90_000);

  describe('AC6 Core mock (the one wired by the real main entry)', () => {
    async function rmToken() {
      await insertStaff(viaPg(sql), actors.rm);
      return tokenFor(actors.rm.actorId);
    }
    const lookup = async (token: string, cifRef: string) => request('/onboarding/customer-lookup', { token, body: { cifRef } });
    const ageOn = (dateOfBirth: string, now = new Date()) => {
      const born = new Date(`${dateOfBirth}T00:00:00Z`);
      let age = now.getUTCFullYear() - born.getUTCFullYear();
      if (now.getUTCMonth() < born.getUTCMonth() || (now.getUTCMonth() === born.getUTCMonth() && now.getUTCDate() < born.getUTCDate())) age -= 1;
      return age;
    };

    test('AC6 CIF100001-CIF100005 resolve with the team seed names, DOB and CASA number as the own VND account', async () => {
      await ready();
      const token = await rmToken();
      const expected = [
        ['CIF100001', 'Nguyễn Thị Mai', '1968-03-12', '0011000123451'], ['CIF100002', 'Trần Quốc Huy', '1985-07-25', '0011000123452'],
        ['CIF100003', 'Võ Thanh Tâm', '1990-11-02', '0011000123453'], ['CIF100004', 'Đặng Hải Yến', '1979-01-30', '0011000123454'],
        ['CIF100005', 'Bùi Gia Khánh', null, '0011000123455'],
      ] as const;
      for (const [cif, name, dateOfBirth, casa] of expected) {
        const found = await lookup(token, cif);
        expect(found.status, cif).toBe(200);
        expect(found.body, cif).toMatchObject({ cifRef: cif, fullName: name, active: true, eligible: true });
        if (dateOfBirth) expect(found.body.dateOfBirth, cif).toBe(dateOfBirth);
        else expect(found.body.dateOfBirth, `${cif} DOB is not in the team seed`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(found.body.accounts, cif).toContainEqual(expect.objectContaining({ casaNo: casa, currency: 'VND' }));
      }
    }, 60_000);

    test('AC6 CIF100006 is an eligible synthetic customer with its own VND account and can be invited', async () => {
      await ready();
      const token = await rmToken();
      const found = await lookup(token, 'CIF100006');
      expect(found.status).toBe(200);
      expect(found.body).toMatchObject({ cifRef: 'CIF100006', active: true, eligible: true, fullName: expect.stringMatching(/\S/) });
      expect(ageOn(found.body.dateOfBirth)).toBeGreaterThanOrEqual(18);
      const account = (found.body.accounts as Array<{ casaNo: string; currency: string }>).find(item => item.currency === 'VND');
      expect(account, 'a VND account').toBeDefined();
      const created = await request('/onboarding/requests', { token, key: 's21-core-100006', body: { cifRef: 'CIF100006', selectedCasaNo: account!.casaNo } });
      expect(created.status).toBe(201);
    }, 60_000);

    test.each([
      ['CIF100007', 'blacklisted'], ['CIF100008', 'credit group 3'], ['CIF100009', 'under 18'],
    ] as const)('AC6 %s (%s) is found but ineligible: lookup eligible=false, invitation 422 CUSTOMER_INELIGIBLE, no rows written', async (cif, reason) => {
      await ready();
      const token = await rmToken();
      const found = await lookup(token, cif);
      expect(found.status).toBe(200);
      expect(found.body).toMatchObject({ cifRef: cif, active: true, eligible: false });
      if (reason === 'under 18') expect(ageOn(found.body.dateOfBirth), 'DOB makes the customer a minor').toBeLessThan(18);
      else expect(ageOn(found.body.dateOfBirth), 'adult, so the other rule is what blocks').toBeGreaterThanOrEqual(18);
      const refused = await request('/onboarding/requests', { token, key: `s21-core-${cif}`,
        body: { cifRef: cif, selectedCasaNo: found.body.accounts[0]?.casaNo ?? 'unused' } });
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe('CUSTOMER_INELIGIBLE');
      expect((await rows('SELECT count(*)::int AS n FROM wms.onboarding_requests'))[0].n).toBe(0);
    }, 60_000);

    test('AC6 the old demo CIFs 00000101-00000104 and an unlisted CIF are unknown (404 CUSTOMER_NOT_FOUND)', async () => {
      await ready();
      const token = await rmToken();
      for (const cif of ['00000101', '00000102', '00000103', '00000104', 'CIF100010']) {
        const unknown = await lookup(token, cif);
        expect(unknown.status, cif).toBe(404);
        expect(unknown.body.code).toBe('CUSTOMER_NOT_FOUND');
      }
    }, 60_000);
  });
});

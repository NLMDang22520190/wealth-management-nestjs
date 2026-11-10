import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { actors, viaDataSource, viaPg } from '../helpers/actors.js';
import type { Sql } from '../helpers/actors.js';
import { startApiFixture } from '../helpers/application.js';
import { confirmRisk, createDraft, registerCustomer } from '../helpers/flows.js';
import { startTestDatabase } from '../helpers/postgres.js';
import { HOUR } from '../helpers/wms.js';

/** R9 S1 (AC1, AC2, AC3 migration part): the team schema `wms` built by migration 008 plus four additive patches. */
const root = new URL('../../', import.meta.url);
const DDL = new URL('apps/api/src/database/team/wms_schema.sql', root);
// Fallback so the comparison still runs before the vendored copy exists (its sha256 is asserted separately).
const TEAM_ORIGINAL = new URL('.agents/handoff/r9-team/wms_schema.sql', root);
const DDL_SHA256 = '6aac39fb067aa28d7f89c3fb3d4a6ee31fea2ced59663078d30d68795f2bde5f';
const MIGRATIONS_SRC = new URL('apps/api/src/database/migrations/', root);
const MIGRATIONS_DIST = new URL('apps/api/dist/database/migrations/', root);
const OLD_MIGRATION_SHA256: Record<string, string> = {
  '1791763200000-mock-actors.ts': '3d77f2ebfefc36f446768fe7d9b79f2251187adf36ac85a19da92c77cd25b6f8',
  '1791763200001-onboarding.ts': '19473f8604a9b5cf48ffffb4800c7f24235b5bc786c438a6e2e491f30b92ed4c',
  '1791763200002-audit-metadata.ts': 'd04a636199d52a63257045c631a795e22481f5e27b54afe1c06f911e72c9e3a2',
  '1791763200003-risk-profiles.ts': '7fbc18bbb40858d676cbebc9fd851c2de688fbe14b00aaec223d85014c6db221',
  '1791763200004-questionnaire-retirement.ts': 'aca02bcbfb27c92aa5b605d85b6005c0a75938d6231263f73a0573bdd15523cb',
  '1791763200005-rm-assignment.ts': '3dfe5615b1c38927d10c26fa407b72c11f93c28b46f1ba2697f07d14a3576a63',
  '1791763200006-vietnamese-questionnaire.ts': 'dc58b7c886d389333c05d1a478089df7d560ded3c245d87eb7db7096c23118c6',
  '1791763200007-customer-notifications.ts': '3989728e057d7920cfcd7cc1f2753272849b86a6afc929b5a8c7649756543b55',
};
/** Migration 009 (P3): the one declared change to the team DDL. A daily snapshot stays unique per customer through a partial index; event snapshots are not limited. */
const SNAPSHOT_KIND_COLUMN = 'portfolio_snapshots.snapshot_kind';
const SNAPSHOT_DAILY_UNIQUE = 'portfolio_snapshots.portfolio_snapshots_customer_id_snapshot_date_key';
const JWT_SECRET = 'wms-test-only-secret-at-least-32-characters';

async function pgCode(work: Promise<unknown>): Promise<string | undefined> {
  try { await work; return undefined; } catch (error) { return (error as { code?: string }).code ?? 'NO_CODE'; }
}

/** Everything the AC1 comparison needs, read through the catalogs of one connection. */
async function snapshot(sql: Sql) {
  const by = (rows: any[], key: string, value: string) => Object.fromEntries(rows.map(row => [row[key], row[value]]));
  const columns = await sql(`SELECT cl.relname||'.'||a.attname AS key,
      format_type(a.atttypid,a.atttypmod)||' notnull='||a.attnotnull::text||' default='||COALESCE(pg_get_expr(d.adbin,d.adrelid),'')||' identity='||a.attidentity::text||' generated='||a.attgenerated::text AS def
    FROM pg_attribute a JOIN pg_class cl ON cl.oid=a.attrelid JOIN pg_namespace n ON n.oid=cl.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE n.nspname='wms' AND cl.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped`);
  const constraints = await sql(`SELECT cl.relname||'.'||co.conname AS key, pg_get_constraintdef(co.oid) AS def
    FROM pg_constraint co JOIN pg_class cl ON cl.oid=co.conrelid JOIN pg_namespace n ON n.oid=cl.relnamespace WHERE n.nspname='wms'`);
  const indexes = await sql("SELECT tablename||'.'||indexname AS key, indexdef AS def FROM pg_indexes WHERE schemaname='wms'");
  const triggers = await sql(`SELECT cl.relname||'.'||t.tgname AS key, pg_get_triggerdef(t.oid) AS def
    FROM pg_trigger t JOIN pg_class cl ON cl.oid=t.tgrelid JOIN pg_namespace n ON n.oid=cl.relnamespace WHERE n.nspname='wms' AND NOT t.tgisinternal`);
  const views = await sql("SELECT viewname AS key, definition AS def FROM pg_views WHERE schemaname='wms'");
  const functions = await sql(`SELECT p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' AS key, md5(p.prosrc) AS def
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='wms'`);
  const enums = await sql(`SELECT t.typname AS key, array_to_string(array_agg(e.enumlabel ORDER BY e.enumsortorder),',') AS def
    FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='wms' GROUP BY t.typname`);
  const domains = await sql(`SELECT t.typname AS key, format_type(t.typbasetype,t.typtypmod) AS def
    FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='wms' AND t.typtype='d'`);
  // A missing table must show up as missing data in the comparison, not as a crash.
  const lenient = (text: string) => sql(text).catch(() => [] as any[]);
  const rows = {
    risk_categories: await lenient('SELECT * FROM wms.risk_categories ORDER BY category'),
    target_allocations: await lenient('SELECT * FROM wms.target_allocations ORDER BY category, allocation_class'),
    system_ledger_accounts: await lenient('SELECT code,name,type FROM wms.ledger_accounts WHERE investment_account_id IS NULL ORDER BY code'),
  };
  return { columns: by(columns, 'key', 'def'), constraints: by(constraints, 'key', 'def'), indexes: by(indexes, 'key', 'def'),
    triggers: by(triggers, 'key', 'def'), views: by(views, 'key', 'def'), functions: by(functions, 'key', 'def'),
    enums: by(enums, 'key', 'def'), domains: by(domains, 'key', 'def'), rows };
}

/** A migrated database without fixture staff: the schema checks must run (and fail on missing objects) even before any wms table exists. */
async function startBare() {
  const database = await startTestDatabase();
  const compiled = new URL('apps/api/dist/application.js', root).href;
  const { createApplication } = await import(/* @vite-ignore */ compiled);
  const quiet = { log() {}, error() {}, warn() {}, debug() {}, verbose() {} };
  try {
    const application = await createApplication({ databaseUrl: database.databaseUrl, environment: 'test', mockEnabled: true, jwtSecret: JWT_SECRET,
      clock: { now: () => new Date('2026-01-15T05:00:00.000Z') }, logger: quiet });
    return { dataSource: application.dataSource as DataSource, async stop() { try { await application.app.close(); } finally { await database.stop(); } } };
  } catch (error) { await database.stop(); throw error; }
}

describe('S19 AC1 migration 008 builds the vendored team DDL in schema wms', () => {
  let migrated: Awaited<ReturnType<typeof startBare>>;
  let referenceDb: Awaited<ReturnType<typeof startTestDatabase>>;
  let migratedSnap: Awaited<ReturnType<typeof snapshot>>;
  let referenceSnap: Awaited<ReturnType<typeof snapshot>>;

  beforeAll(async () => {
    migrated = await startBare();
    migratedSnap = await snapshot(viaDataSource(migrated.dataSource));
    referenceDb = await startTestDatabase();
    const setup = new pg.Client({ connectionString: referenceDb.databaseUrl });
    await setup.connect();
    try { await setup.query(readFileSync(existsSync(DDL) ? DDL : TEAM_ORIGINAL, 'utf8')); } finally { await setup.end(); }
    const reader = new pg.Client({ connectionString: referenceDb.databaseUrl });
    await reader.connect();
    try { referenceSnap = await snapshot(viaPg(reader)); } finally { await reader.end(); }
  }, 180_000);
  afterAll(async () => { try { await migrated?.stop(); } finally { await referenceDb?.stop(); } });

  test('AC1 the vendored DDL is byte-identical to the team file (sha256 pinned)', () => {
    expect(existsSync(DDL), 'the team DDL must be vendored at apps/api/src/database/team/wms_schema.sql').toBe(true);
    expect(createHash('sha256').update(readFileSync(DDL)).digest('hex')).toBe(DDL_SHA256);
  });

  test('AC1 migration 008 exists and migrations 000-007 are unchanged', () => {
    const names = readdirSync(MIGRATIONS_SRC);
    expect(names.filter(name => name.startsWith('1791763200008-')), 'new migration 1791763200008-*.ts').toHaveLength(1);
    // Hash the committed (LF) content: a Windows checkout may convert these files to CRLF.
    for (const [name, sha] of Object.entries(OLD_MIGRATION_SHA256)) {
      const committed = readFileSync(new URL(name, MIGRATIONS_SRC), 'utf8').split(String.fromCharCode(13)).join('');
      expect(createHash('sha256').update(committed).digest('hex'), name).toBe(sha);
    }
  });

  test('AC1 every column of the DDL exists in wms with the same type, nullability, default, identity and generation', () => {
    expect(Object.keys(referenceSnap.columns).length, 'reference DDL must have built tables').toBeGreaterThan(100);
    const { [SNAPSHOT_KIND_COLUMN]: snapshotKind, ...teamColumns } = migratedSnap.columns;
    expect(snapshotKind, 'migration 009 adds this column').toContain('notnull=true');
    expect(teamColumns).toEqual(referenceSnap.columns);
  });

  test.each(['enums', 'domains', 'constraints', 'indexes', 'views', 'triggers', 'functions'] as const)('AC1 every %s object of the DDL exists in wms', kind => {
    const expected = referenceSnap[kind] as Record<string, string>;
    const actual = migratedSnap[kind] as Record<string, string>;
    expect(Object.keys(expected).length, `reference ${kind}`).toBeGreaterThan(0);
    // Patches may only ADD objects; the questionnaire guard (patch d) may be redefined, but it must still exist.
    const redefinable = ['risk_questionnaire_versions.trg_questionnaire_guard', 'fn_questionnaire_guard()'];
    const wrong = Object.keys(expected).filter(key => key !== SNAPSHOT_DAILY_UNIQUE && (!(key in actual) || (actual[key] !== expected[key] && !redefinable.includes(key))));
    expect(wrong.slice(0, 15), `${wrong.length} ${kind} missing or different`).toEqual([]);
  });

  test('AC1 the reference rows of section 8 exist (risk categories, target allocations, system ledger accounts)', () => {
    expect(referenceSnap.rows.risk_categories).toHaveLength(3);
    expect(referenceSnap.rows.target_allocations).toHaveLength(12);
    expect(referenceSnap.rows.system_ledger_accounts).toHaveLength(5);
    expect(migratedSnap.rows).toEqual(referenceSnap.rows);
  });

  test('AC1 old P1 tables are gone from public; only the TypeORM bookkeeping table stays there', async () => {
    const sql = viaDataSource(migrated.dataSource);
    expect((await sql("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name")).map(row => row.table_name)).toEqual(['migrations']);
    const names = (await sql("SELECT name FROM public.migrations ORDER BY id")).map(row => row.name as string);
    expect(names.length).toBeGreaterThanOrEqual(9);
    expect(names.some(name => name.endsWith('1791763200008'))).toBe(true);
  });

  test('AC3 a migrated database without seed carries exactly demo-risk-v1 (RETIRED) and demo-risk-v2-vi (ACTIVE)', async () => {
    const rows = await viaDataSource(migrated.dataSource)('SELECT version,status FROM wms.risk_questionnaire_versions ORDER BY version');
    expect(rows).toEqual([{ version: 'demo-risk-v1', status: 'RETIRED' }, { version: 'demo-risk-v2-vi', status: 'ACTIVE' }]);
  });
});

describe('S19 AC2 additive patches on real PostgreSQL', () => {
  let api: Awaited<ReturnType<typeof startApiFixture>>;
  let sql: Sql;
  beforeAll(async () => { api = await startApiFixture(); sql = viaDataSource(api.dataSource); }, 120_000);
  afterAll(async () => { await api?.stop(); });

  async function newCustomer(cif: string) {
    const [row] = await sql("INSERT INTO wms.customers(cif_id,full_name) VALUES($1,'Synthetic patch customer') RETURNING customer_id", [cif]);
    return row.customer_id as string;
  }

  test('AC2a rm_assignments.version is assigned per customer when omitted and honored when given', async () => {
    const first = await newCustomer('PATCH-A1');
    const second = await newCustomer('PATCH-A2');
    const insert = (customer: string, version?: number) => sql(
      `INSERT INTO wms.rm_assignments(customer_id,rm_id,team_id,valid_from${version ? ',version' : ''}) VALUES($1,$2,$3,$4${version ? ',$5' : ''}) RETURNING version`,
      [customer, actors.rm.rmId, actors.rm.teamId, api.state.now, ...(version ? [version] : [])]);
    const close = (customer: string) => sql('UPDATE wms.rm_assignments SET valid_to=$2 WHERE customer_id=$1 AND valid_to IS NULL', [customer, new Date(api.state.now.getTime() + HOUR)]);
    expect((await insert(first))[0].version).toBe(1);
    await close(first);
    expect((await insert(first))[0].version).toBe(2);
    expect((await insert(second))[0].version, 'a different customer starts at 1').toBe(1);
    await close(first);
    expect((await insert(first, 7))[0].version, 'an explicit version is kept').toBe(7);
    await close(first);
    expect((await insert(first))[0].version).toBe(8);
  });

  test('AC2b composite FKs reject a risk profile or draft that belongs to another customer', async () => {
    const alpha = await registerCustomer(api);
    const beta = await registerCustomer(api, { cifId: actors.otherCustomer.cifId, actorId: actors.otherCustomer.actorId });
    const profile = await confirmRisk(api, actors.customer.actorId, 2, 0, 'patch-b');
    expect(await pgCode(sql('UPDATE wms.wealth_services SET current_risk_profile_id=$2 WHERE customer_id=$1', [beta.customerId, profile.riskProfileId])),
      'wealth_services(current_risk_profile_id, customer_id) -> risk_profiles').toBe('23503');
    const spare = await createDraft(api, actors.customer.actorId, 3, 'patch-b-spare');
    expect(await pgCode(sql(`INSERT INTO wms.risk_profiles(risk_profile_id,customer_id,version,draft_id,questionnaire_version,answers,score,category,max_product_risk,
        allocation,payload_hash,otp_receipt_ref,confirmed_at,expires_at)
      SELECT gen_random_uuid(),$1,1,$3,questionnaire_version,answers,score,category,max_product_risk,allocation,payload_hash,gen_random_uuid(),confirmed_at,expires_at
      FROM wms.risk_profiles WHERE risk_profile_id=$2`, [beta.customerId, profile.riskProfileId, spare.draftId])), 'risk_profiles(draft_id, customer_id) -> drafts').toBe('23503');
    expect(alpha.customerId).not.toBe(beta.customerId);
  });

  test('AC2c a customer can have only one service consent', async () => {
    const existing = await sql('SELECT 1 FROM wms.service_consents LIMIT 1');
    if (existing.length === 0) await registerCustomer(api);
    const [consent] = await sql(`SELECT c.*, r.cif_id AS cif, r.rm_id, r.team_id FROM wms.service_consents c JOIN wms.onboarding_requests r ON r.request_id=c.request_id LIMIT 1`);
    expect(consent, 'a registered customer exists').toBeDefined();
    const requestId = (await sql(`INSERT INTO wms.onboarding_requests(cif_id,customer_name,selected_casa_no,rm_id,team_id,status,terms_version,terms_hash,created_at,expires_at)
      VALUES($1,'Synthetic','casa',$2,$3,'CONFIRMED',$4,$5,$6,$7) RETURNING request_id`,
    [consent.cif, consent.rm_id, consent.team_id, consent.terms_version, consent.terms_hash, api.state.now, new Date(api.state.now.getTime() + 72 * HOUR)]))[0].request_id;
    expect(await pgCode(sql(`INSERT INTO wms.service_consents(customer_id,request_id,terms_version,terms_hash,otp_receipt_ref) VALUES($1,$2,$3,$4,gen_random_uuid())`,
      [consent.customer_id, requestId, consent.terms_version, consent.terms_hash]))).toBe('23505');
  });

  test('AC2d a questionnaire version may only change ACTIVE to RETIRED; nothing else changes and nothing is deleted', async () => {
    const version = 'demo-risk-v2-vi';
    expect(await pgCode(sql("UPDATE wms.risk_questionnaire_versions SET effective_from=effective_from + interval '1 day' WHERE version=$1", [version])), 'effective_from on ACTIVE').toBeDefined();
    expect(await pgCode(sql("UPDATE wms.risk_questionnaire_versions SET status='RETIRED', effective_from=effective_from + interval '1 day' WHERE version=$1", [version])), 'retire + other column').toBeDefined();
    expect(await pgCode(sql('DELETE FROM wms.risk_questionnaire_versions WHERE version=$1', [version])), 'delete ACTIVE').toBeDefined();
    expect((await sql('SELECT status FROM wms.risk_questionnaire_versions WHERE version=$1', [version]))[0].status).toBe('ACTIVE');
    expect(await pgCode(sql("UPDATE wms.risk_questionnaire_versions SET status='RETIRED' WHERE version=$1", [version])), 'ACTIVE -> RETIRED is allowed').toBeUndefined();
    expect(await pgCode(sql("UPDATE wms.risk_questionnaire_versions SET status='ACTIVE' WHERE version=$1", [version])), 'RETIRED -> ACTIVE').toBeDefined();
    expect(await pgCode(sql("UPDATE wms.risk_questionnaire_versions SET effective_from=effective_from + interval '1 day' WHERE version=$1", [version])), 'effective_from on RETIRED').toBeDefined();
    expect(await pgCode(sql('DELETE FROM wms.risk_questionnaire_versions WHERE version=$1', [version])), 'delete RETIRED').toBeDefined();
    expect((await sql('SELECT status FROM wms.risk_questionnaire_versions WHERE version=$1', [version]))[0].status).toBe('RETIRED');
  });
});

describe('S19 AC1 upgrade of an existing pre-008 database', () => {
  const migrationClasses = async (include: (name: string) => boolean) => {
    const files = readdirSync(MIGRATIONS_DIST).filter(name => name.endsWith('.js') && include(name)).sort();
    const classes: any[] = [];
    for (const file of files) classes.push(Object.values(await import(/* @vite-ignore */ new URL(file, MIGRATIONS_DIST).href))[0]);
    return classes;
  };

  test('AC1 a database migrated to 007 (with legacy rows) upgrades by running only 008+', async () => {
    const database = await startTestDatabase();
    try {
      const legacy = new DataSource({ type: 'postgres', url: database.databaseUrl, migrations: await migrationClasses(name => name < '1791763200008'), migrationsTableName: 'migrations' });
      await legacy.initialize();
      await legacy.runMigrations({ transaction: 'all' });
      await legacy.query("INSERT INTO mock_actors(actor_id,subject_id,role,active) VALUES('legacy-actor','legacy-subject','LEADER',true)");
      const before = await legacy.query('SELECT id,timestamp,name FROM migrations ORDER BY id');
      expect(before).toHaveLength(8);
      await legacy.destroy();

      const compiled = new URL('apps/api/dist/application.js', root).href;
      const { createApplication } = await import(/* @vite-ignore */ compiled);
      const application = await createApplication({ databaseUrl: database.databaseUrl, environment: 'test', mockEnabled: true, jwtSecret: JWT_SECRET,
        clock: { now: () => new Date('2026-01-15T05:00:00.000Z') }, logger: { log() {}, error() {}, warn() {}, debug() {}, verbose() {} } });
      try {
        const sql = viaDataSource(application.dataSource);
        const after = await sql('SELECT id,timestamp,name FROM public.migrations ORDER BY id');
        expect(after.slice(0, 8), 'migrations 000-007 are not re-run or rewritten').toEqual(before);
        expect(after.length, '008+ ran once').toBeGreaterThan(8);
        expect((await sql("SELECT to_regclass('public.mock_actors') AS t"))[0].t, 'legacy table dropped').toBeNull();
        expect((await sql("SELECT to_regclass('wms.staff_users') AS t"))[0].t, 'team table created').not.toBeNull();
        expect((await sql("SELECT version FROM wms.risk_questionnaire_versions WHERE status='ACTIVE'"))).toEqual([{ version: 'demo-risk-v2-vi' }]);
      } finally { await application.app.close(); }
    } finally { await database.stop(); }
  }, 120_000);

  test('AC1 migration 008 has a working down() and can be applied again', async () => {
    const database = await startTestDatabase();
    try {
      const classes = await migrationClasses(name => name <= '1791763200008-zzz');
      const dataSource = new DataSource({ type: 'postgres', url: database.databaseUrl, migrations: classes, migrationsTableName: 'migrations' });
      await dataSource.initialize();
      try {
        await dataSource.runMigrations({ transaction: 'all' });
        expect((await dataSource.query("SELECT to_regclass('wms.staff_users') AS t"))[0].t).not.toBeNull();
        await dataSource.undoLastMigration({ transaction: 'all' });
        expect((await dataSource.query("SELECT to_regclass('wms.staff_users') AS t"))[0].t, 'wms dropped by down()').toBeNull();
        expect((await dataSource.query("SELECT to_regclass('public.mock_actors') AS t"))[0].t, 'pre-008 tables recreated by down()').not.toBeNull();
        expect(await dataSource.query('SELECT 1 FROM public.migrations')).toHaveLength(8);
        await dataSource.runMigrations({ transaction: 'all' });
        expect((await dataSource.query("SELECT to_regclass('wms.staff_users') AS t"))[0].t).not.toBeNull();
      } finally { await dataSource.destroy(); }
    } finally { await database.stop(); }
  }, 120_000);
});

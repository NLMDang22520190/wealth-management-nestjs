import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { startTestDatabase } from '../helpers/postgres.js';
import { reserveHttpPort, runtimeEnvironment, startRuntimeProcess } from '../helpers/runtime.js';
// @ts-expect-error The guard is a plain ES module shared by the CLI; it ships no type declarations.
import { planReset } from '../../scripts/lib/reset-demo-guard.mjs';

/**
 * `npm run reset:demo` (scripts/reset-demo.mjs) drops and rebuilds a local demo database, so the guard is the product:
 * production, a remote host, a database name outside wms_demo* and a missing confirmation must all refuse before any SQL runs.
 */
const PASSWORD = 'secret-pw-0123';
const local = `postgresql://postgres:${PASSWORD}@127.0.0.1:55432/wms_other`;
const plan = (env: Record<string, string | undefined>, args: string[] = []) => planReset({ env, args });
const refusal = (env: Record<string, string | undefined>, args: string[] = []) => {
  try { plan(env, args); } catch (error) { return (error as Error).message; }
  return null;
};

describe('S35 reset:demo guard', () => {
  test('defaults to wms_demo on the same loopback server; admin connection uses the postgres database', () => {
    const result = plan({ DATABASE_URL: local, NODE_ENV: 'development' });
    expect(result.targetName).toBe('wms_demo');
    expect(new URL(result.targetUrl).pathname).toBe('/wms_demo');
    expect(new URL(result.adminUrl).pathname).toBe('/postgres');
    expect(new URL(result.targetUrl).password).toBe(PASSWORD);
    expect(new URL(result.targetUrl).port).toBe('55432');
  });

  test('--db picks another wms_demo* database', () => {
    expect(plan({ DATABASE_URL: local }, ['--db=wms_demo_two']).targetName).toBe('wms_demo_two');
  });

  test('production is refused', () => {
    expect(refusal({ DATABASE_URL: local, NODE_ENV: 'production' })).toMatch(/production/i);
  });

  test.each(['db.example.neon.tech', '10.0.0.5', 'localhost.evil.com'])('remote host %s is refused', host => {
    expect(refusal({ DATABASE_URL: `postgresql://u:${PASSWORD}@${host}:5432/x?sslmode=require` })).toMatch(/localhost|127\.0\.0\.1|máy/i);
  });

  test.each(['localhost', '127.0.0.1', '[::1]'])('loopback host %s is accepted', host => {
    expect(refusal({ DATABASE_URL: `postgresql://u:p@${host}:5432/x` })).toBeNull();
  });

  test.each(['postgres', 'wms_test_abc', 'wms', 'wms_demo;drop', 'WMS_DEMO', 'wealth_management_demo', ''])('database name %j is refused', name => {
    expect(refusal({ DATABASE_URL: local }, [`--db=${name}`])).toMatch(/wms_demo/);
  });

  test('missing or malformed DATABASE_URL and unknown flags are refused', () => {
    expect(refusal({})).toMatch(/DATABASE_URL/);
    expect(refusal({ DATABASE_URL: 'not a url' })).toMatch(/DATABASE_URL/);
    expect(refusal({ DATABASE_URL: local }, ['--force'])).toMatch(/--force/);
  });

  test('no refusal message repeats the password', () => {
    const messages = [refusal({ DATABASE_URL: `postgresql://u:${PASSWORD}@db.neon.tech/x` }), refusal({ DATABASE_URL: local, NODE_ENV: 'production' }), refusal({ DATABASE_URL: local }, ['--db=postgres'])];
    for (const message of messages) expect(message).not.toBeNull();
    for (const message of messages) expect(message).not.toContain(PASSWORD);
  });
});

describe('S35 reset:demo CLI', () => {
  let database: Awaited<ReturnType<typeof startTestDatabase>>;
  let admin: pg.Client;
  let scratch: string;
  let scratchUrl: string;
  let adminUrl: string;
  const children: ReturnType<typeof startRuntimeProcess>[] = [];

  beforeEach(async () => {
    database = await startTestDatabase();
    const serverUrl = new URL(database.databaseUrl);
    serverUrl.pathname = '/postgres';
    adminUrl = serverUrl.toString();
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    scratch = `wms_demo_reset_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await admin.query(`CREATE DATABASE "${scratch}"`);
    const target = new URL(adminUrl);
    target.pathname = `/${scratch}`;
    scratchUrl = target.toString();
    const stale = new pg.Client({ connectionString: scratchUrl });
    await stale.connect();
    await stale.query('CREATE TABLE public.stale_marker(id int)');
    await stale.end();
  });
  afterEach(async () => {
    try { for (const child of children.splice(0)) await child.stop(); } finally {
      try { await admin.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`); } finally { try { await admin.end(); } finally { await database.stop(); } }
    }
  });

  async function reset(args: string[], url = adminUrl, overrides: Record<string, string> = {}) {
    const child = startRuntimeProcess(['scripts/reset-demo.mjs', ...args], runtimeEnvironment(url, await reserveHttpPort(), overrides));
    children.push(child);
    return child.waitForExit();
  }
  async function inScratch<T>(query: string): Promise<T[]> {
    const client = new pg.Client({ connectionString: scratchUrl });
    await client.connect();
    try { return (await client.query(query)).rows as T[]; } finally { await client.end(); }
  }

  test('a remote DATABASE_URL exits non-zero, runs no SQL and does not print the password', async () => {
    const result = await reset(['--yes', `--db=${scratch}`], `postgresql://u:${PASSWORD}@203.0.113.7:5432/x`);
    expect(result.code).not.toBe(0);
    expect(result.output).not.toContain(PASSWORD);
  });

  test('without --yes and without a terminal it refuses and leaves the database alone', async () => {
    const result = await reset([`--db=${scratch}`]);
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/--yes/);
    expect(await inScratch('SELECT 1 FROM public.stale_marker')).toEqual([]);
  });

  test('--yes drops the old data and seeds the team demo data again', async () => {
    const result = await reset(['--yes', `--db=${scratch}`]);
    expect(result.code, result.output).toBe(0);
    expect(result.output).not.toContain(PASSWORD);
    expect(await inScratch("SELECT to_regclass('public.stale_marker') AS t")).toEqual([{ t: null }]);
    const staff = await inScratch<{ n: number }>('SELECT count(*)::int AS n FROM wms.staff_users');
    expect(staff[0]!.n).toBeGreaterThan(0);
  }, 120_000);

  test('running it twice gives the same seeded state (it resets, it does not accumulate)', async () => {
    expect((await reset(['--yes', `--db=${scratch}`])).code).toBe(0);
    const before = (await inScratch<{ n: number }>('SELECT count(*)::int AS n FROM wms.staff_users'))[0]!.n;
    await inScratch('CREATE TABLE wms.extra_marker(id int)');
    expect((await reset(['--yes', `--db=${scratch}`])).code).toBe(0);
    expect(await inScratch("SELECT to_regclass('wms.extra_marker') AS t")).toEqual([{ t: null }]);
    expect((await inScratch<{ n: number }>('SELECT count(*)::int AS n FROM wms.staff_users'))[0]!.n).toBe(before);
  }, 180_000);
});

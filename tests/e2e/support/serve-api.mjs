// Playwright webServer entry #1: owns a fresh database, runs the real seed CLI, then runs the real API main entry.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ensureStateDirectory, statePath } from './state.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const adminUrl = process.env.WMS_TEST_POSTGRES_ADMIN_URL;
if (!adminUrl) { console.error('WMS_TEST_POSTGRES_ADMIN_URL is required for e2e'); process.exit(1); }

const databaseName = `wms_e2e_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`CREATE DATABASE "${databaseName}"`);
await admin.end();
const url = new URL(adminUrl);
url.pathname = `/${databaseName}`;
const databaseUrl = url.toString();

ensureStateDirectory();
writeFileSync(statePath, JSON.stringify({ databaseName, databaseUrl }), { mode: 0o600 });

Object.assign(process.env, {
  DATABASE_URL: databaseUrl, NODE_ENV: 'test', MOCK_AUTH_ENABLED: 'true', PORT: '3000',
  JWT_SECRET: 'e2e-synthetic-only-signing-key-at-least-32-characters',
});
// Public seed command: builds the API, migrates the empty database and seeds the synthetic demo actors.
const seeded = spawnSync('npm run seed:demo', { cwd: root, shell: true, stdio: 'inherit', env: process.env });
if (seeded.status !== 0) { console.error('seed:demo failed'); process.exit(1); }
await import(new URL('../../../apps/api/dist/main.js', import.meta.url).href);

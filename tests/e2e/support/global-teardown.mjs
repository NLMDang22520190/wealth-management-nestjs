import { existsSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { statePath } from './state.mjs';

export default async function globalTeardown() {
  const adminUrl = process.env.WMS_TEST_POSTGRES_ADMIN_URL;
  if (!adminUrl || !existsSync(statePath)) return;
  const { databaseName } = JSON.parse(readFileSync(statePath, 'utf8'));
  // Only ever drop the database this run generated.
  if (!/^wms_e2e_[a-f0-9]{32}$/.test(databaseName)) throw new Error('Unsafe e2e database name');
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try { await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); }
  finally { await admin.end(); }
}

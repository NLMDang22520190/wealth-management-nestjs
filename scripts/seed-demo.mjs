import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { Logger } from '@nestjs/common';
import { createApplication } from '../apps/api/dist/application.js';
import { ConfigurationError } from '../apps/api/dist/platform/configuration.js';

const logger = new Logger('DemoSeed');

// R9: the team schema `wms` is built by the migrations that createApplication runs. This command then loads the vendored
// team demo data (staff NV0001.., customers CIF100001..) once: it is skipped when wms.staff_users already has rows.
const seedFile = new URL('./team-seed/wms_seed.sql', import.meta.url);
// The only transformation of the team file (D-R9-13): migration 008 already made demo-risk-v2-vi the ACTIVE questionnaire
// (one ACTIVE row allowed), so the team's demo-risk-v1-vi row is inserted as RETIRED.
const activeV1 = "'::jsonb, 'ACTIVE', '2025-01-01 00:00+07');";
const retiredV1 = "'::jsonb, 'RETIRED', '2025-01-01 00:00+07');";

async function loadTeamSeed(databaseUrl) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT count(*)::int AS n FROM wms.staff_users');
    if (rows[0].n > 0) return false;
    const raw = await readFile(seedFile, 'utf8');
    if (raw.split(activeV1).length !== 2) throw new Error('Unexpected team seed content');
    // The file carries its own BEGIN/COMMIT and `SET search_path`; this connection is private and closed right after.
    await client.query(raw.replace(activeV1, retiredV1));
    return true;
  } finally {
    await client.end();
  }
}
async function seed() {
  const environment = process.env.NODE_ENV ?? 'development';
  const mockSetting = process.env.MOCK_AUTH_ENABLED ?? 'false';
  // Refuse before invoking the application factory, which initializes the database and migrates.
  if (!['development', 'test'].includes(environment) || mockSetting !== 'true') throw new ConfigurationError();
  const { app, dataSource } = await createApplication({
    databaseUrl: process.env.DATABASE_URL ?? '', environment, mockEnabled: true,
    jwtSecret: process.env.JWT_SECRET ?? '', clock: { now: () => new Date() }, logger,
  });
  try {
    logger.log('Database migrated to the wms schema');
    logger.log((await loadTeamSeed(process.env.DATABASE_URL ?? '')) ? 'Team demo data loaded' : 'Team demo data already present');
  } finally {
    // Ensure the standalone CLI releases the TypeORM pool even when Nest shutdown hooks
    // are unavailable during an initialization or transaction failure.
    await app.close();
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

seed().catch(error => {
  // Never expose driver errors, connection strings, signing keys, or stack traces.
  logger.error(error instanceof ConfigurationError ? 'CONFIG_INVALID' : 'Demo seed failed');
  process.exitCode = 1;
});

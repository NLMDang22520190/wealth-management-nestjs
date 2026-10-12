import { Logger } from '@nestjs/common';
import { createApplication } from '../apps/api/dist/application.js';
import { ConfigurationError } from '../apps/api/dist/platform/configuration.js';

const logger = new Logger('DemoSeed');
// Public synthetic demo registry. Preserve all existing actor and business rows on repeat runs.
const teamId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const actors = [
  ['rm-alpha', 'mock-rm-alpha', 'RM', null, '11111111-1111-4111-8111-111111111111', teamId],
  ['rm-beta', 'mock-rm-beta', 'RM', null, '22222222-2222-4222-8222-222222222222', teamId],
  ['leader-alpha', 'mock-leader-alpha', 'LEADER', null, null, teamId],
  ['customer-alpha', 'mock-customer-alpha', 'CUSTOMER', '00000101', null, null],
  ['customer-beta', 'mock-customer-beta', 'CUSTOMER', '00000102', null, null],
];

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
    await dataSource.transaction(async manager => {
      for (const actor of actors) {
        await manager.query(`INSERT INTO mock_actors(actor_id,subject_id,role,cif_id,rm_id,team_id,active)
          VALUES($1,$2,$3,$4,$5,$6,true) ON CONFLICT DO NOTHING`, actor);
      }
    });
    logger.log('Synthetic demo actors seeded');
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

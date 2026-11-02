import { Logger } from '@nestjs/common';
import { createApplication } from '../apps/api/dist/application.js';
import { ConfigurationError } from '../apps/api/dist/platform/configuration.js';

const logger = new Logger('DemoSeed');

// R9 S1: the team schema `wms` is built by the migrations that createApplication runs; this command only migrates and is idempotent.
// The vendored team demo data (staff NV0001.., customers CIF100001..) is loaded here in S2.
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

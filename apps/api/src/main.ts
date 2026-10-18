import { Logger } from '@nestjs/common';
import { createApplication } from './application.js';
import type { ApplicationOptions } from './application.js';
import { ConfigurationError } from './platform/configuration.js';
import { demoCoreBanking } from './platform/demo-core.js';

const logger = new Logger('Bootstrap');
async function bootstrap(): Promise<void> {
  const environment = process.env.NODE_ENV ?? 'development';
  const mockSetting = process.env.MOCK_AUTH_ENABLED ?? 'false';
  const port = Number(process.env.PORT ?? '3000');
  if (!['development', 'test', 'production'].includes(environment)
    || !['true', 'false'].includes(mockSetting)
    || !Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigurationError();
  const limit = (name: string): number | undefined => {
    const raw = process.env[name];
    if (raw === undefined) return undefined;
    if (!/^[1-9]\d{0,8}$/.test(raw)) throw new ConfigurationError();
    return Number(raw);
  };
  const lookupRateLimitPerMinute = limit('LOOKUP_RATE_LIMIT_PER_MINUTE');
  const inviteRateLimitPerMinute = limit('INVITE_RATE_LIMIT_PER_MINUTE');
  const otpTtlSeconds = limit('OTP_TTL_SECONDS');
  const { app } = await createApplication({
    databaseUrl: process.env.DATABASE_URL ?? '',
    environment: environment as ApplicationOptions['environment'],
    mockEnabled: mockSetting === 'true',
    jwtSecret: process.env.JWT_SECRET ?? '',
    clock: { now: () => new Date() }, logger,
    ...(lookupRateLimitPerMinute !== undefined ? { lookupRateLimitPerMinute } : {}),
    ...(otpTtlSeconds !== undefined ? { otpTtlSeconds } : {}),
    ...(inviteRateLimitPerMinute !== undefined ? { inviteRateLimitPerMinute } : {}),
    ...(environment !== 'production' && mockSetting === 'true' ? { coreBanking: demoCoreBanking } : {}),
  });
  app.enableShutdownHooks();
  try { await app.listen(port, '127.0.0.1'); }
  catch { await app.close(); throw new Error('Application listener failed'); }
}

bootstrap().catch(error => {
  // Never print raw configuration, connection errors or credential-bearing stack traces.
  logger.error(error instanceof ConfigurationError ? 'CONFIG_INVALID' : 'Application startup failed');
  process.exitCode = 1;
});

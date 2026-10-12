import type { ApplicationOptions } from '../application.js';

export class ConfigurationError extends Error {
  readonly code = 'CONFIG_INVALID';
  constructor() { super('Invalid application configuration'); }
}

export function validateConfiguration(options: ApplicationOptions): void {
  let validUrl = false;
  try {
    const url = new URL(options.databaseUrl);
    validUrl = ['postgres:', 'postgresql:'].includes(url.protocol) && Boolean(url.hostname && url.pathname.length > 1);
  } catch { /* Invalid input is represented by the configuration error below. */ }
  if (!validUrl || !['development', 'test', 'production'].includes(options.environment)
    || typeof options.mockEnabled !== 'boolean'
    || (options.environment === 'production' && options.mockEnabled)
    || typeof options.jwtSecret !== 'string' || options.jwtSecret.trim().length < 32
    || /^(change[-_ ]?me|default|secret|password)/i.test(options.jwtSecret)
    || [options.lookupRateLimitPerMinute, options.inviteRateLimitPerMinute]
      .some(limit => limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
    || typeof options.clock?.now !== 'function' || typeof options.logger?.error !== 'function') {
    throw new ConfigurationError();
  }
}

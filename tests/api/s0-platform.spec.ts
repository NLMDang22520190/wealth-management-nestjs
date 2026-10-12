import { createHmac } from 'node:crypto';
import { inspect } from 'node:util';
import type { INestApplication, LoggerService } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { actors, seedTestActors } from '../helpers/actors.js';
import { startTestDatabase } from '../helpers/postgres.js';

const NOW = new Date('2026-01-15T00:00:00.000Z');
const JWT_SECRET = 'wms-test-only-secret-at-least-32-characters';
const ISSUER = 'wealth-management-mock';
const AUDIENCE = 'wealth-management-api';

type ApplicationOptions = {
  databaseUrl: string;
  environment: 'test' | 'production';
  mockEnabled: boolean;
  jwtSecret: string;
  clock: { now(): Date };
  logger: LoggerService;
};
type Application = { app: INestApplication; dataSource: DataSource };
type CreateApplication = (options: ApplicationOptions) => Promise<Application>;
type JsonResponse = { status: number; headers: Headers; body: any };

function signedToken(overrides: Record<string, unknown> = {}, secret = JWT_SECRET) {
  const seconds = Math.floor(NOW.getTime() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: actors.rm.subjectId, iss: ISSUER, aud: AUDIENCE, iat: seconds, exp: seconds + 3600,
    ...overrides,
  })).toString('base64url');
  const input = `${header}.${payload}`;
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}

describe('S0 platform public boundary', () => {
  let database: Awaited<ReturnType<typeof startTestDatabase>>;
  let application: Application | undefined;
  let createApplication: CreateApplication;
  let baseUrl: string;
  const logEntries: string[] = [];
  const capture = (...values: unknown[]) => logEntries.push(inspect(values, { depth: 8 }));
  const logger: LoggerService = {
    log: capture, error: capture, warn: capture, debug: capture, verbose: capture,
  };
  const options = (): ApplicationOptions => ({
    databaseUrl: database.databaseUrl, environment: 'test', mockEnabled: true,
    jwtSecret: JWT_SECRET, clock: { now: () => new Date(NOW) }, logger,
  });

  async function request(path: string, input: { method?: string; token?: string; body?: unknown } = {}, url = baseUrl): Promise<JsonResponse> {
    const response = await fetch(`${url}${path}`, {
      method: input.method ?? 'GET',
      headers: {
        ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }

  async function tokenFor(actorId: string) {
    const response = await request('/api/v1/mock-auth/token', { method: 'POST', body: { actorId } });
    expect(response.status).toBe(200);
    expect(response.body.accessToken).toEqual(expect.any(String));
    expect(response.body.expiresIn).toBeGreaterThan(0);
    return response.body.accessToken as string;
  }

  function expectError(response: JsonResponse, status: number, code: string) {
    expect(response.status).toBe(status);
    expect(response.body).toEqual(expect.objectContaining({
      code, message: expect.any(String), details: expect.anything(), requestId: expect.any(String),
    }));
    expect(response.body.requestId).not.toBe('');
    expect(response.headers.get('x-request-id')).toBe(response.body.requestId);
  }

  beforeAll(async () => {
    database = await startTestDatabase();
    // Compiled JS is deliberate: Nest decorators must retain the tsc-emitted DI metadata.
    const compiled = new URL('../../apps/api/dist/application.js', import.meta.url).href;
    ({ createApplication } = await import(/* @vite-ignore */ compiled));
    application = await createApplication(options());
    await seedTestActors(application.dataSource);
    await application.app.listen(0, '127.0.0.1');
    baseUrl = await application.app.getUrl();
  });

  beforeEach(() => { logEntries.length = 0; });
  afterAll(async () => {
    try { await application?.app.close(); }
    finally { await database?.stop(); }
  });

  test('AC01 bootstraps real Nest/PostgreSQL with migrations, readiness and advertised OpenAPI routes', async () => {
    expect(application!.dataSource.isInitialized).toBe(true);
    expect(application!.dataSource.options.type).toBe('postgres');
    expect(application!.dataSource.options.synchronize).toBe(false);
    const [postgres] = await application!.dataSource.query('SELECT version() AS version, current_database() AS database');
    expect(postgres.version).toContain('PostgreSQL');
    expect(postgres.database).toBe(database.databaseName);
    const [migrationCount] = await application!.dataSource.query('SELECT count(*)::integer AS count FROM migrations');
    expect(migrationCount.count).toBeGreaterThan(0);
    const live = await request('/api/v1/health/live');
    expect(live.status).toBe(200);
    expect(live.body).toEqual({ status: 'ok' });
    const ready = await request('/api/v1/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: 'ok', database: 'up' });

    const document = await request('/api/v1/openapi.json');
    expect(document.status).toBe(200);
    expect(document.body.openapi).toMatch(/^3\./);
    const protectedRoutes = [
      ['post', '/onboarding/customer-lookup'], ['post', '/onboarding/requests'],
      ['get', '/me/onboarding-requests/{id}'], ['post', '/me/onboarding-requests/{id}/confirm'],
      ['get', '/risk-questionnaires/current'], ['post', '/me/risk-assessments'],
      ['post', '/me/risk-assessments/{id}/confirm'], ['get', '/me/risk-profile'],
      ['get', '/customers/{id}/risk-profile'], ['get', '/team/rms'],
      ['post', '/customers/{id}/rm-assignment'], ['get', '/rm/customers'],
      ['get', '/customers/{id}'], ['post', '/otp/challenges'],
    ];
    expect(document.body.components.securitySchemes.bearer).toEqual(expect.objectContaining({
      type: 'http', scheme: 'bearer',
    }));
    for (const [method, route] of protectedRoutes) {
      const operation = document.body.paths[`/api/v1${route}`]?.[method];
      expect(operation, `${method} ${route} must be advertised`).toBeDefined();
      expect(operation.security, `${method} ${route} must advertise bearer auth`).toContainEqual({ bearer: [] });
    }
  });

  test('AC02 accepts issuer-signed tokens and rejects tampering, wrong issuer/audience, expiry and missing authentication', async () => {
    const issued = await tokenFor(actors.rm.actorId);
    const allowed = await request('/api/v1/auth/me', { token: issued });
    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual(actors.rm);
    const [header, payload, signature] = issued.split('.');
    const changed = Buffer.from(JSON.stringify({
      ...JSON.parse(Buffer.from(payload, 'base64url').toString()), sub: actors.leader.subjectId,
    })).toString('base64url');
    const boundarySeconds = Math.floor(NOW.getTime() / 1000);
    const invalid = [
      undefined, `${header}.${changed}.${signature}`, signedToken({}, 'different-signing-secret'),
      signedToken({ iss: 'untrusted-issuer' }), signedToken({ aud: 'other-api' }),
      signedToken({ exp: boundarySeconds - 1 }), signedToken({ exp: boundarySeconds }),
      signedToken({ sub: 'nonexistent-actor' }),
    ];
    for (const token of invalid) {
      expectError(await request('/api/v1/auth/me', { token }), 401, 'UNAUTHORIZED');
    }
    const beforeExpiry = await request('/api/v1/auth/me', { token: signedToken({ exp: boundarySeconds + 1 }) });
    expect(beforeExpiry.status).toBe(200);
  });

  test('AC02 trusted IAM identity ignores forged JWT role/CIF/team and rejects body-supplied identity escalation', async () => {
    const forged = signedToken({ role: 'LEADER', cifId: actors.otherCustomer.cifId, teamId: 'other-team', rmId: 'other-rm' });
    const me = await request('/api/v1/auth/me', { token: forged });
    expect(me.status).toBe(200);
    expect(me.body).toEqual(actors.rm);
    expectError(await request('/api/v1/team/rms', { token: forged }), 403, 'FORBIDDEN');
    expectError(await request('/api/v1/mock-auth/token', {
      method: 'POST', body: { actorId: actors.rm.actorId, role: 'LEADER', cifId: actors.otherCustomer.cifId, teamId: 'other-team' },
    }), 400, 'VALIDATION_ERROR');
    const customerToken = await tokenFor(actors.customer.actorId);
    expect((await request('/api/v1/auth/me', { token: customerToken })).body).toEqual(actors.customer);
    expectError(await request('/api/v1/team/rms', { token: customerToken }), 403, 'FORBIDDEN');
  });

  test('AC02 fails closed for production mock auth and weak signing configuration', async () => {
    for (const override of [
      { environment: 'production' as const, mockEnabled: true },
      { jwtSecret: '' }, { jwtSecret: 'change-me' },
    ]) {
      await expect(createApplication({ ...options(), ...override })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    }
    let production: Application | undefined;
    try {
      production = await createApplication({ ...options(), environment: 'production', mockEnabled: false });
      await production.app.listen(0, '127.0.0.1');
      const url = await production.app.getUrl();
      const disabled = await request('/api/v1/mock-auth/token', { method: 'POST', body: { actorId: actors.rm.actorId } }, url);
      expect(disabled.status).toBe(404);
      expect(disabled.body.accessToken).toBeUndefined();
      expectError(await request('/api/v1/auth/me', { token: signedToken() }, url), 401, 'UNAUTHORIZED');
    } finally { await production?.app.close(); }
  });

  test('AC01/AC02 validation errors carry request IDs and responses/logs exclude authentication and sensitive input values', async () => {
    const token = await tokenFor(actors.customer.actorId);
    const secrets = {
      code: '976521', documentId: 'PII-DOCUMENT-928472', accountNumber: '000987654321654987',
    };
    const response = await request('/api/v1/otp/challenges', {
      method: 'POST', token,
      body: { purpose: 'ONBOARDING_CONSENT', operationId: 'not-a-uuid', ...secrets },
    });
    expectError(response, 400, 'VALIDATION_ERROR');
    const output = `${JSON.stringify(response.body)}\n${logEntries.join('\n')}`;
    for (const secret of [token, JWT_SECRET, 'wms-isolated-test-password', ...Object.values(secrets)]) {
      expect(output).not.toContain(secret);
    }
    const unrelated = await request('/api/v1/auth/me');
    expectError(unrelated, 401, 'UNAUTHORIZED');
    expect(unrelated.body.requestId).not.toBe(response.body.requestId);
  });
});

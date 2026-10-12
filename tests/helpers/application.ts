import { inspect } from 'node:util';
import type { INestApplication, LoggerService } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { expect } from 'vitest';
import { actors, seedTestActors } from './actors.js';
import { startTestDatabase } from './postgres.js';

export const TEST_NOW = '2026-01-15T05:00:00.000Z';
export type CoreCustomer = {
  cifId: string; name: string; dateOfBirth: string; active: boolean; kycVerified: boolean;
  accounts: Array<{ id: string; ownerCifId: string; currency: string; active: boolean }>;
};
export type OtpDelivery = { challengeId: string; actorId: string; purpose: string; operationId: string; code: string; expiresAt: string };
export type HttpResponse = { status: number; body: any; headers: Headers };

export function eligibleCustomer(cifId: string = actors.customer.cifId): CoreCustomer {
  return { cifId, name: 'Synthetic Customer', dateOfBirth: '2008-01-15', active: true, kycVerified: true,
    accounts: [{ id: `account-${cifId}`, ownerCifId: cifId, currency: 'VND', active: true }] };
}

/** Network and time are boundaries; Nest, PostgreSQL and transaction collaborators are real. */
export async function startApiFixture(configuration: { environment?: 'test' | 'production'; mockEnabled?: boolean } = {}) {
  const database = await startTestDatabase();
  const state = { now: new Date(TEST_NOW), core: eligibleCustomer() as CoreCustomer | null, coreFailure: false };
  const deliveries: OtpDelivery[] = [];
  const logs: string[] = [];
  const capture = (...values: unknown[]) => logs.push(inspect(values, { depth: 8 }));
  const logger: LoggerService = { log: capture, error: capture, warn: capture, debug: capture, verbose: capture };
  let application: { app: INestApplication; dataSource: DataSource } | undefined;
  try {
    const compiled = new URL('../../apps/api/dist/application.js', import.meta.url).href;
    const { createApplication } = await import(/* @vite-ignore */ compiled);
    application = await createApplication({
      databaseUrl: database.databaseUrl, environment: configuration.environment ?? 'test', mockEnabled: configuration.mockEnabled ?? true,
      jwtSecret: 'wms-test-only-secret-at-least-32-characters', logger,
      clock: { now: () => new Date(state.now) },
      coreBanking: { lookup: async (reference: string) => {
        if (state.coreFailure) throw Object.assign(new Error('Synthetic Core timeout'), { code: 'CORE_TIMEOUT' });
        if (reference === actors.otherCustomer.cifId) return eligibleCustomer(actors.otherCustomer.cifId);
        return state.core ? structuredClone(state.core) : null;
      } },
      otpDelivery: async (delivery: OtpDelivery) => { deliveries.push({ ...delivery }); },
    });
    await seedTestActors(application!.dataSource);
    await application!.app.listen(0, '127.0.0.1');
    const baseUrl = await application!.app.getUrl();
    const request = async (path: string, input: { method?: string; token?: string; body?: unknown; key?: string } = {}): Promise<HttpResponse> => {
      const response = await fetch(`${baseUrl}/api/v1${path}`, {
        method: input.method ?? 'GET',
        headers: { ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
          ...(input.key ? { 'idempotency-key': input.key } : {}) },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      });
      return { status: response.status, body: await response.json(), headers: response.headers };
    };
    const tokenFor = async (actorId = actors.rm.actorId as string): Promise<string> => {
      const response = await request('/mock-auth/token', { method: 'POST', body: { actorId } });
      expect(response.status).toBe(200);
      return response.body.accessToken;
    };
    return { ...application!, state, deliveries, logs, request, tokenFor,
      async stop() { try { await application?.app.close(); } finally { await database.stop(); } } };
  } catch (error) {
    try { await application?.app.close(); } finally { await database.stop(); }
    throw error;
  }
}

export function expectApiError(response: HttpResponse, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.body).toEqual(expect.objectContaining({ code, message: expect.any(String), requestId: expect.any(String) }));
  expect(response.headers.get('x-request-id')).toBe(response.body.requestId);
}

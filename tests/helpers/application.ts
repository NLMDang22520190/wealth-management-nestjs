import { inspect } from 'node:util';
import type { INestApplication, LoggerService } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { expect } from 'vitest';
import { actors, seedTestActors } from './actors.js';
import { startTestDatabase } from './postgres.js';

export const TEST_NOW = '2026-01-15T05:00:00.000Z';
export type CoreCustomer = {
  cifId: string; name: string; dateOfBirth: string; active: boolean; kycVerified: boolean;
  /** S12 W2: BR-02 inputs. Optional so earlier slices keep compiling; absent means not blacklisted, group 1. */
  blacklisted?: boolean; creditGroup?: number;
  accounts: Array<{ id: string; ownerCifId: string; currency: string; active: boolean }>;
};
export type OtpDelivery = { challengeId: string; actorId: string; purpose: string; operationId: string; code: string; expiresAt: string };
export type CoreLedgerRequest = { refNo: string; casaNo: string; amount: string };
export type CorePosting = { outcome: 'POSTED'; coreRef: string } | { outcome: 'REJECTED'; reason: string };
export type CoreStatus = { outcome: 'POSTED'; coreRef: string } | { outcome: 'NOT_POSTED' };
export type HttpResponse ={ status: number; body: any; headers: Headers };

export function eligibleCustomer(cifId: string = actors.customer.cifId): CoreCustomer {
  return { cifId, name: 'Synthetic Customer', dateOfBirth: '2008-01-15', active: true, kycVerified: true,
    accounts: [{ id: `account-${cifId}`, ownerCifId: cifId, currency: 'VND', active: true }] };
}

/** Network and time are boundaries; Nest, PostgreSQL and transaction collaborators are real. */
export async function startApiFixture(configuration: { environment?: 'test' | 'production'; mockEnabled?: boolean } = {}) {
  const database = await startTestDatabase();
  const state = { now: new Date(TEST_NOW), core: eligibleCustomer() as CoreCustomer | null, coreFailure: false,
    coreLookup: undefined as ((reference: string) => Promise<CoreCustomer | null>) | undefined,
    otpDelivery: undefined as ((delivery: OtpDelivery) => Promise<void>) | undefined,
    corePosting: undefined as ((kind: 'DEBIT' | 'CREDIT', request: CoreLedgerRequest) => Promise<CorePosting>) | undefined,
    coreStatus: undefined as ((request: CoreLedgerRequest) => Promise<CoreStatus>) | undefined,
    coreCalls: [] as Array<{ kind: 'DEBIT' | 'CREDIT' | 'STATUS'; request: CoreLedgerRequest }> };
  const posted = (request: CoreLedgerRequest) => ({ outcome: 'POSTED' as const, coreRef: `CORE-${request.refNo}` });
  const deliveries: OtpDelivery[] = [];
  const logs: string[] = [];
  const logEntries: Array<{ level: string; text: string }> = [];
  const capturing = (level: string) => (...values: unknown[]) => {
    const text = inspect(values, { depth: 8 });
    logs.push(text);
    logEntries.push({ level, text });
  };
  const logger: LoggerService = { log: capturing('log'), error: capturing('error'), warn: capturing('warn'),
    debug: capturing('debug'), verbose: capturing('verbose') };
  let application: { app: INestApplication; dataSource: DataSource } | undefined;
  try {
    const compiled = new URL('../../apps/api/dist/application.js', import.meta.url).href;
    const { createApplication } = await import(/* @vite-ignore */ compiled);
    application = await createApplication({
      databaseUrl: database.databaseUrl, environment: configuration.environment ?? 'test', mockEnabled: configuration.mockEnabled ?? true,
      jwtSecret: 'wms-test-only-secret-at-least-32-characters', logger,
      clock: { now: () => new Date(state.now) },
      coreBanking: { lookup: async (reference: string) => {
        if (state.coreLookup) return state.coreLookup(reference);
        if (state.coreFailure) throw Object.assign(new Error('Synthetic Core timeout'), { code: 'CORE_TIMEOUT' });
        if (reference === actors.otherCustomer.cifId) return eligibleCustomer(actors.otherCustomer.cifId);
        return state.core ? structuredClone(state.core) : null;
      } },
      otpDelivery: async (delivery: OtpDelivery) => { await state.otpDelivery?.(delivery); deliveries.push({ ...delivery }); },
      coreLedger: {
        debit: async (request: CoreLedgerRequest) => { state.coreCalls.push({ kind: 'DEBIT', request }); return state.corePosting ? state.corePosting('DEBIT', request) : posted(request); },
        credit: async (request: CoreLedgerRequest) => { state.coreCalls.push({ kind: 'CREDIT', request }); return state.corePosting ? state.corePosting('CREDIT', request) : posted(request); },
        status: async (request: CoreLedgerRequest) => { state.coreCalls.push({ kind: 'STATUS', request }); return state.coreStatus ? state.coreStatus(request) : posted(request); },
        casaBalance: async () => '10000000000.00',
      },
    });
    await seedTestActors(application!.dataSource);
    await application!.app.listen(0, '127.0.0.1');
    const baseUrl = await application!.app.getUrl();
    const request = async (path: string, input: { method?: string; token?: string; body?: unknown; key?: string; headers?: Record<string, string> } = {}): Promise<HttpResponse> => {
      const response = await fetch(`${baseUrl}/api/v1${path}`, {
        method: input.method ?? 'GET',
        headers: { ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
          ...(input.key ? { 'idempotency-key': input.key } : {}), ...input.headers },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      });
      return { status: response.status, body: await response.json(), headers: response.headers };
    };
    const tokenFor = async (actorId = actors.rm.actorId as string): Promise<string> => {
      const response = await request('/mock-auth/token', { method: 'POST', body: { actorId } });
      expect(response.status).toBe(200);
      return response.body.accessToken;
    };
    /** Moves the injected clock forward. R9 category 4: `chk_rma_period` needs valid_to > valid_from, so a transfer must not happen at the instant of onboarding. */
    const tick = (milliseconds = 1000) => { state.now = new Date(state.now.getTime() + milliseconds); };
    return { ...application!, state, deliveries, logs, logEntries, request, tokenFor, tick,
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

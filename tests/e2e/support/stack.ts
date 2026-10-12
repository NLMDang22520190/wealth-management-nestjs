import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import pg from 'pg';
// @ts-expect-error plain ESM helper shared with the .mjs servers
import { statePath } from './state.mjs';

const apiBase = 'http://127.0.0.1:3000/api/v1';
export const ids = {
  rmAlpha: '11111111-1111-4111-8111-111111111111',
  rmBeta: '22222222-2222-4222-8222-222222222222',
};
const keepTables = new Set(['migrations', 'mock_actors', 'service_terms', 'risk_questionnaire_versions']);

export function databaseUrl(): string {
  return JSON.parse(readFileSync(statePath, 'utf8')).databaseUrl as string;
}

export async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();
  try { return (await client.query(text, params)).rows as T[]; } finally { await client.end(); }
}

/** Clears business rows of the e2e-owned database only; trusted actors, terms and questionnaire stay. */
export async function resetBusinessState() {
  const tables = (await sql<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'"))
    .map(row => row.table_name).filter(name => !keepTables.has(name));
  if (tables.length) await sql(`TRUNCATE ${tables.map(name => `"${name}"`).join(',')} CASCADE`);
  const actors = await sql('SELECT actor_id FROM mock_actors');
  expect(actors.length, 'seed:demo must have created trusted demo actors').toBeGreaterThanOrEqual(5);
}

export async function api(path: string, init: { method?: string; token?: string; body?: unknown; key?: string } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.key ? { 'idempotency-key': init.key } : {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

export async function tokenFor(actorId: string): Promise<string> {
  const issued = await api('/mock-auth/token', { body: { actorId } });
  expect(issued.status).toBe(200);
  return issued.body.accessToken as string;
}

export async function demoOtp(actorId: string, challengeId: string): Promise<string> {
  const inbox = await api(`/me/otp-challenges/${challengeId}/demo-code`, { token: await tokenFor(actorId) });
  expect(inbox.status).toBe(200);
  return inbox.body.code as string;
}

/** Registers a synthetic customer through the real public API (RM invitation, customer OTP consent). */
export async function registerCustomer(cifRef: string, customerActorId: string, rmActorId = 'rm-alpha') {
  const lookup = await api('/onboarding/customer-lookup', { token: await tokenFor(rmActorId), body: { cifRef } });
  expect(lookup.status).toBe(200);
  const created = await api('/onboarding/requests', { token: await tokenFor(rmActorId), key: `e2e-invite-${cifRef}-${randomUUID()}`,
    body: { cifRef, selectedAccountId: lookup.body.accounts[0].id } });
  expect(created.status).toBe(201);
  const customerToken = await tokenFor(customerActorId);
  const challenge = await api('/otp/challenges', { token: customerToken, body: { purpose: 'SERVICE_CONSENT', operationId: created.body.id } });
  expect(challenge.status).toBe(201);
  const code = await demoOtp(customerActorId, challenge.body.challengeId);
  const confirmed = await api(`/me/onboarding-requests/${created.body.id}/confirm`, { token: customerToken,
    key: `e2e-consent-${randomUUID()}`, body: { challengeId: challenge.body.challengeId, code } });
  expect(confirmed.status).toBe(200);
  return { customerId: confirmed.body.customerId as string, requestId: created.body.id as string };
}

/** Confirms a risk profile through the public API; optionIndex 0..4 is applied to every question. */
export async function activateRisk(customerActorId: string, optionIndex: number, expectedVersion = 0) {
  const token = await tokenFor(customerActorId);
  const questionnaire = await api('/risk-questionnaires/current', { token });
  expect(questionnaire.status).toBe(200);
  const answers = questionnaire.body.questions.map((q: any) => ({ questionId: q.id, optionId: q.options[optionIndex].id }));
  const draft = await api('/me/risk-assessments', { token, key: `e2e-draft-${randomUUID()}`,
    body: { questionnaireVersion: questionnaire.body.version, answers } });
  expect(draft.status).toBe(201);
  const challenge = await api('/otp/challenges', { token, body: { purpose: 'RISK_PROFILE_CONFIRM', operationId: draft.body.id } });
  expect(challenge.status).toBe(201);
  const code = await demoOtp(customerActorId, challenge.body.challengeId);
  const confirmed = await api(`/me/risk-assessments/${draft.body.id}/confirm`, { token, key: `e2e-risk-${randomUUID()}`,
    body: { challengeId: challenge.body.challengeId, code, expectedCurrentProfileVersion: expectedVersion } });
  expect(confirmed.status).toBe(200);
  return confirmed.body;
}

export async function addHolding(customerId: string, productId: string, marketValue: string, asOf: string, productRisk = 3) {
  await sql(`INSERT INTO holdings_read_snapshots(id,customer_id,product_id,product_risk,asset_class,quantity,market_value,as_of,provenance)
    VALUES($1,$2,$3,$6,'FUND',1,$4,$5,'SYNTHETIC_P3_READ_BRIDGE')`, [randomUUID(), customerId, productId, marketValue, asOf, productRisk]);
}

export async function addPendingProposal(customerId: string, authorRmId = ids.rmAlpha) {
  await sql(`INSERT INTO proposals(id,customer_id,author_rm_id,status,created_at,updated_at)
    VALUES($1,$2,$3,'PENDING_APPROVAL',now(),now())`, [randomUUID(), customerId, authorRmId]);
}

export async function transferViaApi(customerId: string, targetRmId: string, expectedAssignmentVersion: number) {
  return api(`/customers/${customerId}/rm-assignment`, { token: await tokenFor('leader-alpha'), key: `e2e-transfer-${randomUUID()}`,
    body: { targetRmId, reason: 'Điều chuyển thiết lập cho kiểm thử e2e', expectedAssignmentVersion } });
}

/** dd/MM/yyyy in Asia/Ho_Chi_Minh, the display contract for timestamps. */
export function vnDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' })
    .format(new Date(iso));
}

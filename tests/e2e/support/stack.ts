import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import pg from 'pg';
import { insertAsset, insertHolding, insertProposal, insertSnapshot } from '../../helpers/wms';
// @ts-expect-error plain ESM helper shared with the .mjs servers
import { statePath } from './state.mjs';

const apiBase = 'http://127.0.0.1:3000/api/v1';
/**
 * R9 S2 (category 3): demo actors are the team's codes from the vendored seed (scripts/team-seed/wms_seed.sql): staff log in by
 * employee_code, customers by CIF. Only the stable reference rows of the seed (staff, team, terms, questionnaires) are used;
 * its dated business rows are wiped by resetBusinessState, so no test depends on absolute seed dates.
 */
export const actors = {
  rmAlpha: 'NV0002', // RM An
  rmBeta: 'NV0003', // RM Bao
  leader: 'NV0001', // Team leader Lan
  customerAlpha: 'CIF100001', // Core mock: Nguyễn Thị Mai, CASA 0011000123451
  customerBeta: 'CIF100002', // Core mock: Trần Quốc Huy, CASA 0011000123452
} as const;
/** Core mock data of the two E2E customers (D-R9-7: names and CASA numbers equal the team seed). */
export const core = {
  alpha: { cif: actors.customerAlpha, name: 'Nguyễn Thị Mai', casa: '0011000123451' },
  beta: { cif: actors.customerBeta, name: 'Trần Quốc Huy', casa: '0011000123452' },
} as const;
export const ids = {
  rmAlpha: 'b0000000-0000-0000-0000-000000000002', // staff_users.staff_id of NV0002
  rmBeta: 'b0000000-0000-0000-0000-000000000003', // staff_users.staff_id of NV0003
};
/** Reference data that survives a reset (S2 spec): everything else in schema wms is business data. */
const keepTables = new Set(['teams', 'staff_users', 'risk_categories', 'target_allocations', 'risk_questionnaire_versions', 'service_terms']);
/** The provenance label the API now reports for AUM read from portfolio_snapshots (category 4, forced by S1). */
export const AUM_PROVENANCE = 'P3_PORTFOLIO_SNAPSHOT';

export function databaseUrl(): string {
  return JSON.parse(readFileSync(statePath, 'utf8')).databaseUrl as string;
}

export async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();
  try { return (await client.query(text, params)).rows as T[]; } finally { await client.end(); }
}

/**
 * Clears business rows of the e2e-owned database only. Reference data stays (teams, staff_users, risk_categories, target_allocations,
 * questionnaires, service terms, the system rows of ledger_accounts). No TRUNCATE ... CASCADE: every other wms table is listed
 * explicitly, and ledger_accounts (it references investment_accounts) is truncated and its system rows restored with the same ids.
 */
export async function resetBusinessState() {
  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    await client.query('BEGIN');
    const system = (await client.query('SELECT ledger_account_id, code, name, type FROM wms.ledger_accounts WHERE investment_account_id IS NULL')).rows;
    const tables = (await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='wms' AND table_type='BASE TABLE'"))
      .rows.map(row => row.table_name as string).filter(name => !keepTables.has(name));
    expect(tables, 'wms business tables to truncate').toContain('ledger_accounts');
    await client.query(`TRUNCATE ${tables.map(name => `wms."${name}"`).join(',')}`);
    for (const row of system) {
      await client.query('INSERT INTO wms.ledger_accounts(ledger_account_id, code, name, type) VALUES($1,$2,$3,$4)', [row.ledger_account_id, row.code, row.name, row.type]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { await client.end(); }
  const staff = await sql<{ employee_code: string; role: string }>("SELECT employee_code, role FROM wms.staff_users WHERE is_active ORDER BY employee_code");
  for (const [code, role] of [['NV0001', 'LEADER'], ['NV0002', 'RM'], ['NV0003', 'RM']]) {
    expect(staff, `seed:demo must have loaded ${code}`).toContainEqual({ employee_code: code, role });
  }
  expect((await sql('SELECT code FROM wms.ledger_accounts WHERE investment_account_id IS NULL')).length, 'system ledger accounts kept').toBeGreaterThanOrEqual(5);
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
export async function registerCustomer(cifRef: string, customerActorId: string, rmActorId: string = actors.rmAlpha) {
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

/**
 * Gives the customer an OPEN fund holding of `productRisk` (asset created on demand) and, for the first holding of the customer on
 * that date, a portfolio snapshot whose AUM is `marketValue` and whose snapshot_date is the date of `asOf` (category 4: AUM is the
 * latest portfolio_snapshots row, the team table is append-only with one row per customer and date, so a second holding only adds
 * the holding row that the risk downgrade check reads).
 */
export async function addHolding(customerId: string, productCode: string, marketValue: string, asOf: string, productRisk = 3) {
  const asOfDate = new Date(asOf);
  const [asset] = await sql<{ asset_id: string }>('SELECT asset_id FROM wms.assets WHERE asset_code=$1', [productCode]);
  const assetId = asset?.asset_id ?? await insertAsset(sql, { code: productCode, risk: productRisk, assetClass: 'MUTUAL_FUND' });
  await insertHolding(sql, { customerId, assetId, updatedAt: asOfDate });
  const date = asOf.slice(0, 10);
  if ((await sql('SELECT 1 FROM wms.portfolio_snapshots WHERE customer_id=$1 AND snapshot_date=$2', [customerId, date])).length === 0) {
    await insertSnapshot(sql, { customerId, date, aum: marketValue });
  }
}

/** One PENDING_APPROVAL proposal (the team allows at most one per customer; needs the customer's account and risk profile). */
export async function addPendingProposal(customerId: string, authorRmId = ids.rmAlpha) {
  await insertProposal(sql, { customerId, authorRmId, now: new Date() });
}

export async function transferViaApi(customerId: string, targetRmId: string, expectedAssignmentVersion: number) {
  return api(`/customers/${customerId}/rm-assignment`, { token: await tokenFor(actors.leader), key: `e2e-transfer-${randomUUID()}`,
    body: { targetRmId, reason: 'Điều chuyển thiết lập cho kiểm thử e2e', expectedAssignmentVersion } });
}

/** dd/MM/yyyy in Asia/Ho_Chi_Minh, the display contract for timestamps. */
export function vnDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' })
    .format(new Date(iso));
}

import { expect } from 'vitest';
import { actors, viaDataSource } from './actors.js';
import type { startApiFixture } from './application.js';
import { eligibleCustomer } from './application.js';
import { confirmRisk, registerCustomer } from './flows.js';

export type Api = Awaited<ReturnType<typeof startApiFixture>>;
export const CUSTOMER = actors.customer.actorId;
export const CASA = eligibleCustomer(CUSTOMER).accounts[0]!.id;
export const BACK_OFFICE = 'NV0190';

let serial = 0;
export const nextKey = (label = 'cash') => `${label}-${++serial}`;

/** UC-01 + UC-02 through the public API: a customer with an ACTIVE service, ready for cash operations. */
export async function activeCustomer(api: Api) {
  const registered = await registerCustomer(api);
  await confirmRisk(api, CUSTOMER, 2, 0, 'cash-risk');
  return registered as typeof registered & { customerId: string; accountId: string };
}

export async function insertBackOffice(api: Api) {
  await viaDataSource(api.dataSource)(`INSERT INTO wms.staff_users(iam_subject,employee_code,full_name,role)
    VALUES('iam.bo','${BACK_OFFICE}','Back office','BACK_OFFICE')`);
  return api.tokenFor(BACK_OFFICE);
}

export const otpOf = (api: Api, challengeId: string) => api.deliveries.find(item => item.challengeId === challengeId)!;
export const wrongOtp = (api: Api, challengeId: string) => (otpOf(api, challengeId).code === '000000' ? '000001' : '000000');

export type OrderKind = 'deposits' | 'withdrawals';
const casaField = (kind: OrderKind) => (kind === 'deposits' ? 'sourceCasaNo' : 'destCasaNo');

export async function createOrder(api: Api, kind: OrderKind, amount: string, input: { key?: string; casa?: string; actor?: string } = {}) {
  return api.request(`/me/${kind}`, { method: 'POST', token: await api.tokenFor(input.actor ?? CUSTOMER), key: input.key ?? nextKey(kind),
    body: { [casaField(kind)]: input.casa ?? CASA, amount } });
}

export async function confirmOrder(api: Api, kind: OrderKind, order: { txnId: string; challengeId: string }, input: { code?: string; key?: string; actor?: string; challengeId?: string } = {}) {
  const challengeId = input.challengeId ?? order.challengeId;
  return api.request(`/me/${kind}/${order.txnId}/confirm`, { method: 'POST', token: await api.tokenFor(input.actor ?? CUSTOMER), key: input.key ?? nextKey('confirm'),
    body: { challengeId, code: input.code ?? otpOf(api, challengeId).code } });
}

/** Creates and confirms an order; asserts the create step succeeded. */
export async function placeOrder(api: Api, kind: OrderKind, amount: string) {
  const created = await createOrder(api, kind, amount);
  expect(created.status).toBe(201);
  return { created: created.body, confirmed: await confirmOrder(api, kind, created.body) };
}

/** A deposit that the Core mock accepts, used to give the account a balance. */
export async function fund(api: Api, amount: string) {
  const { confirmed } = await placeOrder(api, 'deposits', amount);
  expect(confirmed.body.status).toBe('SUCCESS');
}

export async function account(api: Api) {
  const [row] = await api.dataSource.query('SELECT account_id,balance::text,held_amount::text,status::text FROM wms.investment_accounts WHERE cif_id=$1', [CUSTOMER]);
  return row as { account_id: string; balance: string; held_amount: string; status: string };
}

export async function ledger(api: Api, txnId: string) {
  return api.dataSource.query(`SELECT e.entry_id::text,e.journal_id,l.type::text AS account_type,e.side::text,e.amount::text,e.balance_after::text,e.reversal_of::text
    FROM wms.ledger_entries e JOIN wms.ledger_accounts l USING(ledger_account_id) WHERE e.cash_txn_id=$1 ORDER BY e.entry_id`, [txnId]) as Promise<Array<{
    entry_id: string; journal_id: string; account_type: string; side: string; amount: string; balance_after: string | null; reversal_of: string | null }>>;
}

export async function txn(api: Api, txnId: string) {
  const [row] = await api.dataSource.query(`SELECT c.status::text,c.failure_reason,c.completed_at,
      COALESCE(d.retry_count,w.retry_count) AS retry_count,w.needs_manual_review,COALESCE(d.core_ref,w.core_ref) AS core_ref
    FROM wms.cash_transactions c LEFT JOIN wms.deposit_transactions d USING(txn_id) LEFT JOIN wms.withdrawal_transactions w USING(txn_id) WHERE c.txn_id=$1`, [txnId]);
  return row as { status: string; failure_reason: string | null; completed_at: Date | null; retry_count: number; needs_manual_review: boolean | null; core_ref: string | null };
}

/** NFR-P2-03: account balance equals total credits minus total debits of its ledger account. */
export async function expectBalanceMatchesLedger(api: Api) {
  const [row] = await api.dataSource.query(`SELECT a.balance::text AS balance,
      (COALESCE(SUM(e.amount) FILTER (WHERE e.side='CREDIT'),0)-COALESCE(SUM(e.amount) FILTER (WHERE e.side='DEBIT'),0))::numeric(20,2)::text AS ledger
    FROM wms.investment_accounts a JOIN wms.ledger_accounts l ON l.investment_account_id=a.account_id
    LEFT JOIN wms.ledger_entries e ON e.ledger_account_id=l.ledger_account_id WHERE a.cif_id=$1 GROUP BY a.balance`, [CUSTOMER]);
  expect(row.balance).toBe(row.ledger);
}

export async function audit(api: Api, action: string) {
  return api.dataSource.query(`SELECT actor_id,actor_role::text,outcome::text,reference_type,reference_id,old_value,new_value FROM wms.audit_logs WHERE action=$1 ORDER BY log_id`, [action]) as Promise<Array<{
    actor_id: string; actor_role: string; outcome: string; reference_type: string; reference_id: string; old_value: any; new_value: any }>>;
}

/** POST a job endpoint with the back-office token. */
export const runReconciliation = (api: Api, token: string) => api.request('/demo/jobs/reconciliation', { method: 'POST', token });
export const runMaturity = (api: Api, token: string, asOf?: string) => api.request('/demo/jobs/maturity-settlement', { method: 'POST', token, body: asOf ? { asOf } : {} });

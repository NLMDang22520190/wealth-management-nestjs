import { randomUUID } from 'node:crypto';
import type { Sql } from './actors.js';

/** SQL fixtures on the team schema `wms` (R9). Raw SQL is test-only; the API is never bypassed for behaviour under test. */
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** Deterministic `X-Request-Id` values: `audit_logs.request_id` is a UUID column. */
export const rid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export type ProposalStatus = 'PENDING_APPROVAL' | 'APPROVED' | 'EXECUTING' | 'EXECUTED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';
const CLOSED: ProposalStatus[] = ['EXECUTED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED'];

/**
 * Inserts a proposal that satisfies the team rules (category 6): needs the customer's investment account and a risk
 * profile, `expired_at = created_at + 24 h`, at most one PENDING_APPROVAL per customer, APPROVED/EXECUTING/EXECUTED carry
 * `otp_auth_ref` + `approved_at`, EXECUTED carries `executed_at`. An unknown status is rejected by the enum.
 */
export async function insertProposal(sql: Sql, input: { customerId: string; authorRmId: string; status?: string; now: Date }): Promise<string> {
  const status = input.status ?? 'PENDING_APPROVAL';
  const [account] = await sql('SELECT account_id FROM wms.investment_accounts WHERE customer_id=$1', [input.customerId]);
  const [profile] = await sql('SELECT risk_profile_id FROM wms.risk_profiles WHERE customer_id=$1 ORDER BY version DESC LIMIT 1', [input.customerId]);
  if (!account || !profile) throw new Error('A proposal fixture needs an investment account and a risk profile');
  const id = randomUUID();
  const approved = ['APPROVED', 'EXECUTING', 'EXECUTED'].includes(status);
  const closed = CLOSED.includes(status as ProposalStatus);
  await sql(`INSERT INTO wms.proposals(proposal_id,proposal_code,customer_id,rm_id,account_id,risk_profile_id,status,cash_at_creation,
      created_at,expired_at,otp_auth_ref,approved_at,executed_at,closed_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,0,$8,$9,$10,$11,$12,$13)`,
  [id, `PROP-20260115-${id.slice(0, 8)}`, input.customerId, input.authorRmId, account.account_id, profile.risk_profile_id, status,
    input.now, new Date(input.now.getTime() + DAY), approved ? randomUUID() : null, approved ? input.now : null,
    status === 'EXECUTED' ? input.now : null, closed ? input.now : null]);
  return id;
}

/** P4 simulator: PENDING_APPROVAL -> APPROVED -> EXECUTING -> EXECUTED with `otp_auth_ref`, `approved_at`, `executed_at`. */
export async function executeProposal(sql: Sql, proposalId: string, now: Date) {
  await sql("UPDATE wms.proposals SET status='APPROVED', otp_auth_ref=$2, approved_at=$3 WHERE proposal_id=$1", [proposalId, randomUUID(), now]);
  await sql("UPDATE wms.proposals SET status='EXECUTING' WHERE proposal_id=$1", [proposalId]);
  await sql("UPDATE wms.proposals SET status='EXECUTED', executed_at=$2 WHERE proposal_id=$1", [proposalId, now]);
}

/**
 * Inserts a confirmed risk profile (and its draft) directly, for scenarios the API cannot reach, and makes the service
 * ACTIVE pointing at it (`chk_ws_active` forbids ACTIVE without a profile, so "ACTIVE but never surveyed" no longer exists).
 */
export async function insertRiskProfile(sql: Sql, input: { customerId: string; confirmedAt: Date; version?: number }) {
  const draftId = randomUUID();
  const profileId = randomUUID();
  const answers = Array.from({ length: 10 }, (_, index) => ({ questionId: `q${index + 1}`, optionId: 'o3' }));
  const allocation = { cash: 5, deposit: 30, bond: 30, fund: 35 };
  const expiresAt = new Date(input.confirmedAt.getTime() + 365 * DAY);
  await sql(`INSERT INTO wms.risk_assessment_drafts(draft_id,customer_id,questionnaire_version,answers,score,category,max_product_risk,allocation,
      expected_current_profile_version,payload_hash,created_at,expires_at)
    VALUES($1,$2,'demo-risk-v2-vi',$3,30,'BALANCED',3,$4,$5,$6,$7,$8)`,
  [draftId, input.customerId, JSON.stringify(answers), JSON.stringify(allocation), (input.version ?? 1) - 1, 'a'.repeat(64), input.confirmedAt,
    new Date(input.confirmedAt.getTime() + DAY)]);
  await sql(`INSERT INTO wms.risk_profiles(risk_profile_id,customer_id,version,draft_id,questionnaire_version,answers,score,category,max_product_risk,
      allocation,payload_hash,otp_receipt_ref,confirmed_at,expires_at)
    VALUES($1,$2,$3,$4,'demo-risk-v2-vi',$5,30,'BALANCED',3,$6,$7,$8,$9,$10)`,
  [profileId, input.customerId, input.version ?? 1, draftId, JSON.stringify(answers), JSON.stringify(allocation), 'a'.repeat(64), randomUUID(),
    input.confirmedAt, expiresAt]);
  await sql("UPDATE wms.wealth_services SET status='ACTIVE', current_risk_profile_id=$2 WHERE customer_id=$1", [input.customerId, profileId]);
  return { draftId, profileId, expiresAt };
}

export async function insertAsset(sql: Sql, input: { code: string; risk: number; assetClass: 'TERM_DEPOSIT' | 'BOND' | 'MUTUAL_FUND' }): Promise<string> {
  const [row] = await sql(`INSERT INTO wms.assets(asset_code,asset_name,asset_class,risk_level) VALUES($1,$2,$3,$4) RETURNING asset_id`,
    [input.code, `Synthetic ${input.code}`, input.assetClass, input.risk]);
  return row.asset_id;
}

/** OPEN holding of the customer's investment account; `updatedAt` is the holding's as-of (BEFORE UPDATE trigger only). */
export async function insertHolding(sql: Sql, input: { customerId: string; assetId: string; updatedAt: Date; status?: 'OPEN' | 'CLOSED'; quantity?: string }) {
  const [account] = await sql('SELECT account_id FROM wms.investment_accounts WHERE customer_id=$1', [input.customerId]);
  await sql(`INSERT INTO wms.portfolio_holdings(account_id,asset_id,quantity,avg_cost,principal,status,updated_at)
    VALUES($1,$2,$3,1000,0,$4,$5)`, [account.account_id, input.assetId, input.quantity ?? '10', input.status ?? 'OPEN', input.updatedAt]);
}

/** Daily snapshot (append-only table). `fund` carries the whole AUM so `chk_aum` holds. */
export async function insertSnapshot(sql: Sql, input: { customerId: string; date: string; aum: string }) {
  const [account] = await sql('SELECT account_id FROM wms.investment_accounts WHERE customer_id=$1', [input.customerId]);
  await sql(`INSERT INTO wms.portfolio_snapshots(customer_id,account_id,snapshot_date,cash_balance,deposit_value,bond_value,fund_value,aum)
    VALUES($1,$2,$3,0,0,0,$4,$4)`, [input.customerId, account.account_id, input.date, input.aum]);
}

/**
 * A complete ACTIVE customer on `rmId` for capacity fixtures, copied from a real profile/draft/consent of the same run.
 * Honors the team CHECKs: onboarding 72 h, draft 24 h, profile 12 months, one consent and one account per customer.
 */
export async function insertActiveCustomer(sql: Sql, input: { index: number; rmId: string; teamId: string; now: Date;
  template: { consentId: string; draftId: string; profileId: string } }) {
  const customerId = randomUUID(); const requestId = randomUUID(); const consentId = randomUUID();
  const draftId = randomUUID(); const profileId = randomUUID(); const cif = `capacity-${input.index}`;
  const [consent] = await sql('SELECT terms_version,terms_hash FROM wms.service_consents WHERE consent_id=$1', [input.template.consentId]);
  await sql('INSERT INTO wms.customers(customer_id,cif_id,full_name,created_at) VALUES($1,$2,$3,$4)', [customerId, cif, 'Synthetic capacity customer', input.now]);
  await sql(`INSERT INTO wms.onboarding_requests(request_id,cif_id,customer_name,selected_casa_no,rm_id,team_id,status,terms_version,terms_hash,created_at,expires_at)
    VALUES($1,$2,'Synthetic capacity customer','synthetic-account',$3,$4,'CONFIRMED',$5,$6,$7,$8)`,
  [requestId, cif, input.rmId, input.teamId, consent.terms_version, consent.terms_hash, input.now, new Date(input.now.getTime() + 72 * HOUR)]);
  await sql(`INSERT INTO wms.service_consents(consent_id,request_id,customer_id,terms_version,terms_hash,otp_receipt_ref,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [consentId, requestId, customerId, consent.terms_version, consent.terms_hash, randomUUID(), input.now]);
  await sql("INSERT INTO wms.investment_accounts(account_no,customer_id,cif_id,opened_at) VALUES($1,$2,$3,$4)",
    [`WM9${String(input.index).padStart(9, '0')}`, customerId, cif, input.now]);
  await sql(`INSERT INTO wms.risk_assessment_drafts(draft_id,customer_id,questionnaire_version,answers,score,category,max_product_risk,allocation,
      expected_current_profile_version,payload_hash,created_at,expires_at)
    SELECT $1,$2,questionnaire_version,answers,score,category,max_product_risk,allocation,0,payload_hash,created_at,expires_at
    FROM wms.risk_assessment_drafts WHERE draft_id=$3`, [draftId, customerId, input.template.draftId]);
  await sql(`INSERT INTO wms.risk_profiles(risk_profile_id,customer_id,draft_id,questionnaire_version,answers,score,category,max_product_risk,allocation,
      version,confirmed_at,expires_at,otp_receipt_ref,payload_hash)
    SELECT $1,$2,$3,questionnaire_version,answers,score,category,max_product_risk,allocation,1,confirmed_at,expires_at,$4,payload_hash
    FROM wms.risk_profiles WHERE risk_profile_id=$5`, [profileId, customerId, draftId, randomUUID(), input.template.profileId]);
  await sql(`INSERT INTO wms.wealth_services(customer_id,consent_id,status,linked_payment_account_no,current_risk_profile_id,created_at)
    VALUES($1,$2,'ACTIVE','synthetic-account',$3,$4)`, [customerId, consentId, profileId, input.now]);
  await sql('INSERT INTO wms.rm_assignments(customer_id,rm_id,team_id,valid_from,provisional,version) VALUES($1,$2,$3,$4,false,1)',
    [customerId, input.rmId, input.teamId, input.now]);
  return customerId;
}

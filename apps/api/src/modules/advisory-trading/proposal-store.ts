import type { EntityManager } from 'typeorm';
import { ApiError } from '../../platform/http.js';
import { appendAudit, hash } from '../../platform/transactions.js';
import { JOB_CONTEXT } from '../accounts-ledger/cash.domain.js';

export interface ProposalRow {
  proposal_id: string; proposal_code: string; customer_id: string; full_name: string; rm_id: string; account_id: string; risk_profile_id: string; drift_alert_id: string | null;
  status: string; total_estimated_buy: string; total_estimated_sell: string; cash_at_creation: string; note: string | null; rejection_reason: string | null;
  cancel_reason: string | null; failure_reason: string | null; created_at: Date; expired_at: Date; approved_at: Date | null; executed_at: Date | null; closed_at: Date | null;
}
export interface LegRow {
  leg_id: string; leg_no: number; asset_id: string; asset_code: string; asset_name: string; asset_class: string; source_holding_id: string | null; action_type: string;
  order_quantity: string; expected_price: string; estimated_amount: string; actual_executed_price: string | null; slippage_rate: string | null; executed_amount: string | null;
}

export const PROPOSAL_SELECT = `SELECT p.proposal_id,p.proposal_code,p.customer_id,c.full_name,p.rm_id,p.account_id,p.risk_profile_id,p.drift_alert_id,p.status::text AS status,
    p.total_estimated_buy::text AS total_estimated_buy,p.total_estimated_sell::text AS total_estimated_sell,p.cash_at_creation::text AS cash_at_creation,p.note,
    p.rejection_reason,p.cancel_reason,p.failure_reason,p.created_at,p.expired_at,p.approved_at,p.executed_at,p.closed_at
  FROM wms.proposals p JOIN wms.customers c ON c.customer_id=p.customer_id`;

const EXPIRY_ACTOR = { actorId: 'proposal-expiry', role: 'SYSTEM_JOB' } as const;

export async function loadProposal(manager: EntityManager, proposalId: string, lock = false): Promise<ProposalRow | undefined> {
  const [row] = await manager.query(`${PROPOSAL_SELECT} WHERE p.proposal_id=$1${lock ? ' FOR UPDATE OF p' : ''}`, [proposalId]);
  return row;
}

export function loadLegs(manager: EntityManager, proposalId: string): Promise<LegRow[]> {
  return manager.query(`SELECT l.leg_id,l.leg_no,l.asset_id,a.asset_code,a.asset_name,a.asset_class::text AS asset_class,l.source_holding_id,l.action_type::text AS action_type,
      l.order_quantity::text AS order_quantity,l.expected_price::text AS expected_price,l.estimated_amount::text AS estimated_amount,
      l.actual_executed_price::text AS actual_executed_price,l.slippage_rate::text AS slippage_rate,t.executed_amount::text AS executed_amount
    FROM wms.proposal_legs l JOIN wms.assets a ON a.asset_id=l.asset_id LEFT JOIN wms.investment_transactions t ON t.proposal_leg_id=l.leg_id
    WHERE l.proposal_id=$1 ORDER BY l.leg_no`, [proposalId]);
}

const iso = (value: Date | null) => (value ? new Date(value).toISOString() : null);

export function proposalView(row: ProposalRow, legs: LegRow[]) {
  return { proposalId: row.proposal_id, proposalCode: row.proposal_code, customerId: row.customer_id, fullName: row.full_name, rmId: row.rm_id, status: row.status,
    totalEstimatedBuy: row.total_estimated_buy, totalEstimatedSell: row.total_estimated_sell, cashAtCreation: row.cash_at_creation, note: row.note, driftAlertId: row.drift_alert_id,
    rejectionReason: row.rejection_reason, cancelReason: row.cancel_reason, failureReason: row.failure_reason, createdAt: iso(row.created_at), expiresAt: iso(row.expired_at),
    approvedAt: iso(row.approved_at), executedAt: iso(row.executed_at), closedAt: iso(row.closed_at),
    legs: legs.map(leg => ({ legId: leg.leg_id, legNo: leg.leg_no, action: leg.action_type, assetId: leg.asset_id, assetCode: leg.asset_code, assetName: leg.asset_name,
      assetClass: leg.asset_class, holdingId: leg.source_holding_id, quantity: leg.order_quantity, expectedPrice: leg.expected_price, estimatedAmount: leg.estimated_amount,
      executedPrice: leg.actual_executed_price, slippageRate: leg.slippage_rate, executedAmount: leg.executed_amount })) };
}

export async function viewOf(manager: EntityManager, proposalId: string) {
  return proposalView((await loadProposal(manager, proposalId))!, await loadLegs(manager, proposalId));
}

/** The OTP signs the legs exactly as the customer saw them. */
export const legsHash = (legs: LegRow[]) => hash(JSON.stringify(legs.map(leg => [leg.leg_id, leg.action_type, leg.asset_id, leg.order_quantity, leg.expected_price])));

/** Only a pending proposal can change; an expired one answers 410 like UC-15 exception 2, any other end state 409 with when it changed. */
export function assertPending(row: ProposalRow, now: Date): void {
  if (row.status === 'PENDING_APPROVAL' && new Date(row.expired_at).getTime() > now.getTime()) return;
  if (row.status === 'PENDING_APPROVAL' || row.status === 'EXPIRED') throw new ApiError(410, 'PROPOSAL_EXPIRED', 'The proposal has expired');
  throw new ApiError(409, 'PROPOSAL_NOT_PENDING', 'The proposal is no longer pending', { status: row.status, closedAt: iso(row.closed_at) });
}

/** A proposal that ends gives its drift alert back to the scan: an ACTIONED alert would otherwise never be raised again. */
export async function releaseAlert(manager: EntityManager, alertId: string | null): Promise<void> {
  if (alertId) await manager.query("UPDATE wms.drift_alerts SET status='RESOLVED' WHERE alert_id=$1 AND status='ACTIONED'", [alertId]);
}

/**
 * The team triggers on proposals and legs (`fn_leg_suitability`, `fn_leg_guard`) name their types without a schema, so every transaction that writes
 * proposals or legs resolves them in `wms`, as LedgerService does for the balance trigger.
 */
export async function scopeTeamTriggers(manager: EntityManager): Promise<void> {
  await manager.query("SELECT set_config('search_path', 'wms, public', true)");
}

/** BR-21. Called before any read or action, and by the job; `customerId` narrows it to one customer. */
export async function expireDue(manager: EntityManager, now: Date, customerId?: string): Promise<number> {
  await scopeTeamTriggers(manager);
  const [rows]: [Array<{ proposal_id: string; drift_alert_id: string | null }>, number] = await manager.query(`UPDATE wms.proposals SET status='EXPIRED',closed_at=$1
    WHERE status='PENDING_APPROVAL' AND expired_at<=$1 ${customerId ? 'AND customer_id=$2' : ''} RETURNING proposal_id,drift_alert_id`, customerId ? [now, customerId] : [now]);
  for (const row of rows) {
    await releaseAlert(manager, row.drift_alert_id);
    await appendAudit(manager, EXPIRY_ACTOR, { type: 'PROPOSAL', id: row.proposal_id }, 'PROPOSAL_EXPIRED', { proposalId: row.proposal_id }, now,
      { ...JOB_CONTEXT, before: { status: 'PENDING_APPROVAL' }, after: { status: 'EXPIRED' } });
  }
  return rows.length;
}

/** `PREFIX-YYYYMMDD-NNN`, sequential per Vietnam day under an advisory lock. */
export async function nextCode(manager: EntityManager, table: 'proposals' | 'execution_sessions', column: string, prefix: string, vietnamDay: string, width: number): Promise<string> {
  const stem = `${prefix}-${vietnamDay.replaceAll('-', '')}-`;
  await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`p4-code:${stem}`]);
  const [row] = await manager.query(`SELECT COALESCE(max(substring(${column} from $2)::int),0)+1 AS next FROM wms.${table} WHERE ${column} LIKE $1`, [`${stem}%`, `^${stem}(\\d+)$`]);
  return `${stem}${String(row.next).padStart(width, '0')}`;
}

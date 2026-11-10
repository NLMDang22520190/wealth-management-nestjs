import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { ApplicationOptions } from '../../application.js';
import type { Actor } from '../../auth/actor.js';
import { ApiError } from '../../platform/http.js';
import type { AuditContext } from '../../platform/http.js';
import { RUNTIME_OPTIONS } from '../../platform/runtime.module.js';
import { apiErrorCode, appendAudit, appendSuccess, idempotent, recordOutcome } from '../../platform/transactions.js';
import { vietnamDate } from '../accounts-ledger/cash.domain.js';
import { CustomerAccess } from '../customer-risk/customer-access.service.js';
import { valuePortfolio } from './portfolio-valuer.js';

const VIEW = 'PORTFOLIO_VIEW';
const accountNotFound = () => new ApiError(404, 'ACCOUNT_NOT_FOUND', 'No investment account');
const alertNotFound = () => new ApiError(404, 'ALERT_NOT_FOUND', 'Alert not found');
const alertNotOpen = () => new ApiError(409, 'ALERT_NOT_OPEN', 'The alert is already actioned or resolved');
const ACTION = 'DRIFT_ALERT_ACTIONED';
/** P4 (UC-13) consumes this event to start a rebalancing proposal; P3 only records the request. */
const PROPOSAL_EVENT = 'RebalanceProposalRequested';

interface AlertRow {
  alert_id: string; customer_id: string; full_name: string; allocation_class: string; actual: string; target: string; deviation: string; status: string; created_at: Date; read_at: Date | null; actioned_at: Date | null;
  direction: string | null; amount: string | null; snapshot_date: string; aum: string;
}
const ALERT_SELECT = `SELECT a.alert_id,a.customer_id,c.full_name,a.allocation_class::text AS allocation_class,a.actual_weight::text AS actual,a.target_weight::text AS target,a.deviation::text AS deviation,
    a.status::text AS status,a.created_at,a.read_at,a.actioned_at,s.direction::text AS direction,s.adjust_amount::text AS amount,to_char(ps.snapshot_date,'YYYY-MM-DD') AS snapshot_date,ps.aum::text AS aum
  FROM wms.drift_alerts a JOIN wms.customers c ON c.customer_id=a.customer_id JOIN wms.portfolio_snapshots ps ON ps.snapshot_id=a.snapshot_id
  LEFT JOIN wms.rebalance_suggestions s ON s.alert_id=a.alert_id`;
const OPEN_FIRST = "ORDER BY a.created_at DESC,a.allocation_class";

const alertView = (row: AlertRow) => ({ alertId: row.alert_id, customerId: row.customer_id, fullName: row.full_name, allocationClass: row.allocation_class, actualWeight: row.actual, targetWeight: row.target,
  deviation: row.deviation, status: row.status, createdAt: new Date(row.created_at).toISOString(), readAt: row.read_at ? new Date(row.read_at).toISOString() : null, actionedAt: row.actioned_at ? new Date(row.actioned_at).toISOString() : null,
  direction: row.direction, adjustAmount: row.amount, snapshotDate: row.snapshot_date, aum: row.aum });

/** UC-11 and the RM side of UC-12. Scope comes from the token or P1's assignment check, never from the query; every staff view is audited. */
@Injectable()
export class PortfolioReadService {
  constructor(private readonly database: DataSource, private readonly access: CustomerAccess, @Inject(RUNTIME_OPTIONS) private readonly options: ApplicationOptions) {}

  private today(): string { return vietnamDate(this.options.clock.now()); }

  private async portfolio(customerId: string) {
    const valuation = await valuePortfolio(this.database.manager, customerId, this.today());
    if (!valuation) throw accountNotFound();
    const { accountId: _accountId, riskProfileId: _riskProfileId, ...view } = valuation;
    return view;
  }

  private async history(customerId: string, days: number) {
    const today = this.today();
    const rows: Array<{ date: string; aum: string }> = await this.database.query(`SELECT to_char(snapshot_date,'YYYY-MM-DD') AS date,aum::text AS aum FROM wms.portfolio_snapshots
      WHERE customer_id=$1 AND snapshot_kind='DAILY' AND snapshot_date<$2::date AND snapshot_date>=$2::date-$3::int ORDER BY snapshot_date`, [customerId, today, days]);
    const live = await this.portfolio(customerId);
    return { points: [...rows.map(row => ({ date: row.date, aum: row.aum, live: false })), { date: today, aum: live.aum, live: true }], dataStatus: live.dataStatus };
  }

  async ownPortfolio(actor: Actor) { return this.portfolio((await this.access.own(actor)).id); }
  async ownHistory(actor: Actor, days: number) { return this.history((await this.access.own(actor)).id, days); }

  private async staffScope(actor: Actor, customerId: string, context: AuditContext): Promise<void> {
    const now = this.options.clock.now();
    try {
      await this.access.staff(actor, customerId);
    } catch (error) {
      if (apiErrorCode(error) === 'FORBIDDEN') await recordOutcome(this.database, 'DENIED', actor, { type: 'CUSTOMER', id: customerId }, VIEW, 'FORBIDDEN', now, context);
      throw error;
    }
    await this.database.transaction(manager => appendAudit(manager, actor, { type: 'CUSTOMER', id: customerId }, VIEW, { customerId }, now, { ...context, before: null, after: null }));
  }

  async customerPortfolio(actor: Actor, customerId: string, context: AuditContext) {
    await this.staffScope(actor, customerId, context);
    return this.portfolio(customerId);
  }

  async customerHistory(actor: Actor, customerId: string, days: number, context: AuditContext) {
    await this.staffScope(actor, customerId, context);
    return this.history(customerId, days);
  }

  async customerAlerts(actor: Actor, customerId: string, context: AuditContext) {
    await this.staffScope(actor, customerId, context);
    const rows: AlertRow[] = await this.database.query(`${ALERT_SELECT} WHERE a.customer_id=$1 AND a.status IN ('NEW','READ') ${OPEN_FIRST}`, [customerId]);
    return { items: rows.map(alertView) };
  }

  /** Follows the current assignment, not `rm_id` on the alert: after a transfer the new RM owns the open alerts. */
  async rmAlerts(actor: Actor) {
    const rows: AlertRow[] = await this.database.query(`${ALERT_SELECT} JOIN wms.rm_assignments ra ON ra.customer_id=a.customer_id AND ra.valid_to IS NULL
      WHERE ra.rm_id=$1 AND a.status IN ('NEW','READ') ${OPEN_FIRST} LIMIT 200`, [actor.rmId]);
    return { items: rows.map(alertView) };
  }

  async markRead(actor: Actor, alertId: string, key: string | undefined, context: AuditContext) {
    const now = this.options.clock.now();
    const [found] = await this.database.query('SELECT customer_id FROM wms.drift_alerts WHERE alert_id=$1', [alertId]);
    if (!found) throw alertNotFound();
    try {
      await this.access.staff(actor, found.customer_id);
    } catch (error) {
      if (apiErrorCode(error) === 'FORBIDDEN') await recordOutcome(this.database, 'DENIED', actor, { type: 'DRIFT_ALERT', id: alertId }, 'DRIFT_ALERT_READ', 'FORBIDDEN', now, context);
      throw error;
    }
    return this.database.transaction(manager => idempotent(manager, actor.actorId, 'DRIFT_ALERT_READ', alertId, key, {}, now, async () => {
      await manager.query("UPDATE wms.drift_alerts SET status='READ',read_at=$2 WHERE alert_id=$1 AND status='NEW'", [alertId, now]);
      const [row]: AlertRow[] = await manager.query(`${ALERT_SELECT} WHERE a.alert_id=$1`, [alertId]);
      return alertView(row!);
    }));
  }

  /**
   * UC-12 step 5: the RM asks for a rebalancing proposal. The alert becomes ACTIONED, and the request goes to P4 as an outbox event, with the audit row, in one transaction.
   * Only the RM who holds the customer now may do it (scope as `markRead`); a refused attempt is audited DENIED.
   */
  async requestRebalanceProposal(actor: Actor, alertId: string, key: string | undefined, context: AuditContext) {
    const now = this.options.clock.now();
    const [found] = await this.database.query('SELECT customer_id FROM wms.drift_alerts WHERE alert_id=$1', [alertId]);
    if (!found) throw alertNotFound();
    try {
      await this.access.staff(actor, found.customer_id);
    } catch (error) {
      if (apiErrorCode(error) === 'FORBIDDEN') await recordOutcome(this.database, 'DENIED', actor, { type: 'DRIFT_ALERT', id: alertId }, ACTION, 'FORBIDDEN', now, context);
      throw error;
    }
    return this.database.transaction(manager => idempotent(manager, actor.actorId, ACTION, alertId, key, {}, now, async () => {
      const [alert]: Array<{ customer_id: string; risk_profile_id: string; allocation_class: string; actual: string; target: string; status: string }> = await manager.query(
        `SELECT customer_id,risk_profile_id,allocation_class::text AS allocation_class,actual_weight::text AS actual,target_weight::text AS target,status::text AS status
         FROM wms.drift_alerts WHERE alert_id=$1 FOR UPDATE`, [alertId]);
      if (!alert || (alert.status !== 'NEW' && alert.status !== 'READ')) throw alertNotOpen();
      const suggestions: Array<{ allocation_class: string; direction: string; adjust_amount: string }> = await manager.query(
        'SELECT allocation_class::text AS allocation_class,direction::text AS direction,adjust_amount::text AS adjust_amount FROM wms.rebalance_suggestions WHERE alert_id=$1 ORDER BY allocation_class', [alertId]);
      await manager.query("UPDATE wms.drift_alerts SET status='ACTIONED',actioned_at=$2 WHERE alert_id=$1", [alertId, now]);
      await appendSuccess(manager, actor, { type: 'DRIFT_ALERT', id: alertId }, ACTION, PROPOSAL_EVENT,
        { alertId, customerId: alert.customer_id, rmId: actor.rmId, riskProfileId: alert.risk_profile_id, allocationClass: alert.allocation_class, actualWeight: alert.actual, targetWeight: alert.target,
          suggestions: suggestions.map(row => ({ allocationClass: row.allocation_class, direction: row.direction, adjustAmount: row.adjust_amount })) }, now,
        { ...context, before: { status: alert.status }, after: { status: 'ACTIONED' } });
      const [row]: AlertRow[] = await manager.query(`${ALERT_SELECT} WHERE a.alert_id=$1`, [alertId]);
      return alertView(row!);
    }));
  }
}

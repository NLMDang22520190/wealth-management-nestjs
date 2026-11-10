import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import type { ApplicationOptions } from '../../application.js';
import { RUNTIME_OPTIONS } from '../../platform/runtime.module.js';
import { appendAudit } from '../../platform/transactions.js';
import { JOB_CONTEXT, vietnamDate } from '../accounts-ledger/cash.domain.js';
import { valuePortfolio } from './portfolio-valuer.js';
import type { AllocationRow, Valuation } from './portfolio-valuer.js';

/** DAILY is the 17:00 run; the others follow UC-10, UC-08 and UC-02. */
export type ScanTrigger = 'DAILY' | 'PRICE' | 'MATURITY' | 'RISK';
export interface ScanOutcome { snapshot: boolean; skipped: boolean; alerts: number; }
export interface ScanSummary { scanned: number; alerted: number; failed: number; }

const SCAN_ACTOR = { actorId: 'drift-scan', role: 'SYSTEM_JOB' } as const;
const SKIPPED: ScanOutcome = { snapshot: false, skipped: true, alerts: 0 };

interface OpenAlert { alert_id: string; allocation_class: string; status: string; actual: string; target: string; risk_profile_id: string; amount: string | null; }

/**
 * UC-12 for one customer in one short transaction. Never places an order: it records a fact (the snapshot), a conclusion (the alert) and a hint (the suggestion).
 * Callers run after their own commit and hold no locks.
 */
@Injectable()
export class DriftScanner {
  constructor(private readonly database: DataSource, @Inject(RUNTIME_OPTIONS) private readonly options: ApplicationOptions) {}

  scanCustomer(customerId: string, trigger: ScanTrigger, asOf: string = vietnamDate(this.options.clock.now())): Promise<ScanOutcome> {
    return this.database.transaction(async manager => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`drift-scan:${customerId}`]);
      const now = this.options.clock.now();
      const [service] = await manager.query(`SELECT ws.status::text AS status,rp.expires_at,cr.rm_id FROM wms.wealth_services ws
        LEFT JOIN wms.risk_profiles rp ON rp.risk_profile_id=ws.current_risk_profile_id LEFT JOIN wms.v_customer_current_rm cr ON cr.customer_id=ws.customer_id
        WHERE ws.customer_id=$1`, [customerId]);
      if (service?.status !== 'ACTIVE') return SKIPPED;
      const valuation = await valuePortfolio(manager, customerId, asOf);
      // A missing price would make every weight wrong: wait for it rather than alert on a guess.
      if (!valuation || valuation.dataStatus !== 'COMPLETE') return SKIPPED;

      const canAlert = valuation.aum !== '0.00' && service.rm_id && valuation.riskProfileId && new Date(service.expires_at).getTime() > now.getTime();
      const plan = canAlert ? await this.alertPlan(manager, valuation) : { create: [], resolve: [] };
      const mustSnapshot = trigger === 'DAILY' || trigger === 'PRICE' || plan.create.length > 0;
      const snapshotId = mustSnapshot ? await this.writeSnapshot(manager, valuation, trigger, now) : null;
      if (mustSnapshot && !snapshotId) return { snapshot: false, skipped: false, alerts: 0 };

      for (const alertId of plan.resolve) await manager.query("UPDATE wms.drift_alerts SET status='RESOLVED' WHERE alert_id=$1", [alertId]);
      for (const row of plan.create) await this.createAlert(manager, valuation, row, snapshotId!, service.rm_id, now);
      if (plan.create.length > 0 || plan.resolve.length > 0) {
        await appendAudit(manager, SCAN_ACTOR, { type: 'CUSTOMER', id: customerId }, 'DRIFT_ALERTS_CHANGED', { trigger, snapshotId }, now,
          { ...JOB_CONTEXT, before: null, after: { trigger, created: plan.create.map(row => row.allocationClass), resolved: plan.resolve.length } });
      }
      return { snapshot: snapshotId !== null, skipped: false, alerts: plan.create.length };
    });
  }

  /** One open alert per customer and class, always with the latest numbers; ACTIONED ones wait for P4. */
  private async alertPlan(manager: EntityManager, valuation: Valuation): Promise<{ create: AllocationRow[]; resolve: string[] }> {
    const existing: OpenAlert[] = await manager.query(`SELECT a.alert_id,a.allocation_class::text AS allocation_class,a.status::text AS status,a.actual_weight::text AS actual,a.target_weight::text AS target,a.risk_profile_id,s.adjust_amount::text AS amount
      FROM wms.drift_alerts a LEFT JOIN wms.rebalance_suggestions s ON s.alert_id=a.alert_id WHERE a.customer_id=$1 AND a.status IN ('NEW','READ','ACTIONED')`, [valuation.customerId]);
    const create: AllocationRow[] = [];
    const resolve: string[] = [];
    for (const row of valuation.allocation) {
      const mine = existing.filter(alert => alert.allocation_class === row.allocationClass);
      const open = mine.find(alert => alert.status !== 'ACTIONED');
      if (!row.drifted) {
        if (open) resolve.push(open.alert_id);
        continue;
      }
      if (mine.some(alert => alert.status === 'ACTIONED')) continue;
      if (open && open.actual === row.actualWeight && open.target === row.targetWeight && open.amount === row.suggestedAmount && open.risk_profile_id === valuation.riskProfileId) continue;
      if (open) resolve.push(open.alert_id);
      create.push(row);
    }
    return { create, resolve };
  }

  /** Returns null when today's daily snapshot already exists. */
  private async writeSnapshot(manager: EntityManager, valuation: Valuation, trigger: ScanTrigger, now: Date): Promise<string | null> {
    const kind = trigger === 'DAILY' ? 'DAILY' : 'EVENT';
    const rows: Array<{ snapshot_id: string }> = await manager.query(`INSERT INTO wms.portfolio_snapshots(customer_id,account_id,snapshot_date,cash_balance,deposit_value,bond_value,fund_value,aum,unrealized_pnl,snapshot_kind,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (customer_id,snapshot_date) WHERE snapshot_kind='DAILY' DO NOTHING RETURNING snapshot_id`,
    [valuation.customerId, valuation.accountId, valuation.asOf, valuation.cash, valuation.depositValue, valuation.bondValue, valuation.fundValue, valuation.aum, valuation.unrealizedPnl, kind, now]);
    return rows[0]?.snapshot_id ?? null;
  }

  private async createAlert(manager: EntityManager, valuation: Valuation, row: AllocationRow, snapshotId: string, rmId: string, now: Date): Promise<void> {
    const alertId = randomUUID();
    await manager.query(`INSERT INTO wms.drift_alerts(alert_id,snapshot_id,customer_id,rm_id,risk_profile_id,allocation_class,actual_weight,target_weight,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [alertId, snapshotId, valuation.customerId, rmId, valuation.riskProfileId, row.allocationClass, row.actualWeight, row.targetWeight, now]);
    if (row.direction && row.suggestedAmount) {
      await manager.query('INSERT INTO wms.rebalance_suggestions(alert_id,allocation_class,direction,adjust_amount) VALUES($1,$2,$3,$4)',
        [alertId, row.allocationClass, row.direction, row.suggestedAmount]);
    }
    // D-R10-5: "RM nhận thông báo" without a staff notification table: the event is the notification, written in the alert's own transaction.
    await manager.query(`INSERT INTO wms.outbox_events(event_id,event_type,aggregate_type,aggregate_id,payload,created_at) VALUES($1,'DriftAlertCreated','DRIFT_ALERT',$2,$3,$4)`,
      [randomUUID(), alertId, JSON.stringify({ alertId, customerId: valuation.customerId, rmId, allocationClass: row.allocationClass, deviation: row.deviation }), now]);
  }

  /** A failed scan never undoes the operation that asked for it: the 17:00 run catches up. */
  async scanQuietly(customerId: string, trigger: ScanTrigger, asOf?: string): Promise<ScanOutcome | null> {
    try {
      return await this.scanCustomer(customerId, trigger, asOf);
    } catch {
      this.options.logger.error({ code: 'DRIFT_SCAN_FAILED', customerId, trigger });
      return null;
    }
  }

  private async scanEach(customerIds: string[], trigger: ScanTrigger, asOf?: string): Promise<ScanSummary> {
    const summary: ScanSummary = { scanned: 0, alerted: 0, failed: 0 };
    for (const customerId of customerIds) {
      const outcome = await this.scanQuietly(customerId, trigger, asOf);
      summary.scanned += 1;
      if (!outcome) summary.failed += 1;
      else if (outcome.alerts > 0) summary.alerted += 1;
    }
    return summary;
  }

  /** After a price change (UC-10): everyone holding one of these products, once each. */
  async scanHolders(assetIds: string[]): Promise<ScanSummary> {
    const rows: Array<{ customer_id: string }> = await this.database.query(`SELECT DISTINCT ia.customer_id FROM wms.portfolio_holdings h JOIN wms.investment_accounts ia USING(account_id)
      WHERE h.asset_id=ANY($1::uuid[]) AND h.status='OPEN' ORDER BY ia.customer_id`, [assetIds]);
    return this.scanEach(rows.map(row => row.customer_id), 'PRICE');
  }

  /** After a settlement run (UC-08): each account once, however many of its deposits matured. */
  async scanAccounts(accountIds: string[], asOf: string): Promise<ScanSummary> {
    const rows: Array<{ customer_id: string }> = await this.database.query('SELECT customer_id FROM wms.investment_accounts WHERE account_id=ANY($1::uuid[]) ORDER BY customer_id', [accountIds]);
    return this.scanEach(rows.map(row => row.customer_id), 'MATURITY', asOf);
  }
}

import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import type { ApplicationOptions } from '../../application.js';
import type { Actor } from '../../auth/actor.js';
import { ApiError } from '../../platform/http.js';
import type { AuditContext } from '../../platform/http.js';
import { RUNTIME_OPTIONS } from '../../platform/runtime.module.js';
import { apiErrorCode, appendAudit, idempotent } from '../../platform/transactions.js';
import { vietnamDate } from '../accounts-ledger/cash.domain.js';
import { DriftScanner } from './drift-scanner.js';
import type { ScanSummary } from './drift-scanner.js';
import { assetNotFound, dateRule, invalid, parsePriceCsv, PRICE_TYPE, priceRule } from './portfolio.domain.js';
import type { AssetClass, PriceBody, PriceType } from './portfolio.domain.js';

/** BR-15: a change above this needs a second person. */
const GUARD_PERCENT = 20;

interface PriceResult {
  pricingId: string; assetId: string; assetCode: string; priceType: PriceType; previousValue: string | null; value: string; changePct: string | null; effectiveDate: string;
  status: 'APPLIED' | 'PENDING_APPROVAL'; scan: ScanSummary | null;
}
const AWAITING = "p.status='PENDING_APPROVAL' AND NOT EXISTS (SELECT 1 FROM wms.price_approvals x WHERE x.pricing_id=p.pricing_id)";
const notPending = () => new ApiError(409, 'PRICE_NOT_PENDING', 'The price is not waiting for a decision');

/** UC-10. `asset_pricing` and `price_approvals` are append-only: a decision is a new row, and v_asset_latest_price reads the outcome from it. */
@Injectable()
export class PricingService {
  constructor(private readonly database: DataSource, private readonly scanner: DriftScanner, @Inject(RUNTIME_OPTIONS) private readonly options: ApplicationOptions) {}

  /** Only market prices move a portfolio: open deposits keep their locked rate. */
  private scanAfter(result: Pick<PriceResult, 'priceType' | 'assetId'>): Promise<ScanSummary | null> {
    return result.priceType === 'INTEREST_RATE' ? Promise.resolve(null) : this.scanner.scanHolders([result.assetId]);
  }

  async submit(actor: Actor, body: PriceBody, key: string | undefined, context: AuditContext) {
    let fresh = false;
    const now = this.options.clock.now();
    const result = await this.database.transaction(manager => idempotent(manager, actor.actorId, 'PRICE_SUBMIT', body.assetId, key, body, now, () => {
      fresh = true;
      return this.enter(manager, actor, 'asset_id=$1', body.assetId, body.value, body.effectiveDate, context, now);
    }, 201));
    if (!fresh || result.status !== 'APPLIED') return result;
    return { ...result, scan: await this.scanAfter(result) };
  }

  /** The product row lock makes "compare with the previous price, then write" safe against a second clerk. */
  private async enter(manager: EntityManager, actor: Actor, where: string, assetKey: string, value: string, effectiveDate: string | undefined, context: AuditContext, now: Date): Promise<PriceResult> {
    const today = vietnamDate(now);
    const date = effectiveDate ?? today;
    if (date > today) throw invalid();
    await manager.query("SET LOCAL TIME ZONE 'Asia/Ho_Chi_Minh'");
    const [asset]: Array<{ asset_id: string; asset_code: string; asset_class: AssetClass }> = await manager.query(
      `SELECT asset_id,asset_code,asset_class::text AS asset_class FROM wms.assets WHERE ${where} FOR UPDATE`, [assetKey]);
    if (!asset) throw assetNotFound();
    const priceType = PRICE_TYPE[asset.asset_class];
    const [waiting] = await manager.query(`SELECT 1 FROM wms.asset_pricing p WHERE p.asset_id=$1 AND ${AWAITING} LIMIT 1`, [asset.asset_id]);
    if (waiting) throw new ApiError(409, 'PRICE_PENDING_EXISTS', 'This product already has a price waiting for approval');
    const [previous]: Array<{ value: string; effective_date: string }> = await manager.query(
      "SELECT value::text AS value,to_char(effective_date,'YYYY-MM-DD') AS effective_date FROM wms.v_asset_latest_price WHERE asset_id=$1 AND price_type=$2", [asset.asset_id, priceType]);
    if (previous && date < previous.effective_date) throw new ApiError(409, 'PRICE_NOT_LATEST', 'A newer price already exists');
    // Decided in SQL numeric: the team trigger computes change_pct from the same two values.
    const [row]: Array<{ pricing_id: string; value: string; previous_value: string | null; change_pct: string | null; status: 'APPLIED' | 'PENDING_APPROVAL' }> = await manager.query(
      `INSERT INTO wms.asset_pricing(asset_id,price_type,value,previous_value,effective_date,status,created_by,created_at)
       VALUES($1,$2,$3::numeric,$4::numeric,$5,(CASE WHEN $4::numeric IS NOT NULL AND round(abs($3::numeric-$4::numeric)/$4::numeric*100,4)>$8 THEN 'PENDING_APPROVAL' ELSE 'APPLIED' END)::wms.pricing_status,$6,$7)
       RETURNING pricing_id,value::text AS value,previous_value::text AS previous_value,change_pct::text AS change_pct,status::text AS status`,
    [asset.asset_id, priceType, value, previous?.value ?? null, date, actor.staffId, now, GUARD_PERCENT]);
    if (row!.status === 'APPLIED' && priceType === 'INTEREST_RATE') await this.applyRate(manager, asset.asset_id, row!.value);
    const result: PriceResult = { pricingId: row!.pricing_id, assetId: asset.asset_id, assetCode: asset.asset_code, priceType, previousValue: row!.previous_value, value: row!.value,
      changePct: row!.change_pct, effectiveDate: date, status: row!.status, scan: null };
    await appendAudit(manager, actor, { type: 'ASSET_PRICING', id: row!.pricing_id }, 'PRICE_SUBMITTED', { assetId: asset.asset_id, value, date }, now,
      { ...context, before: { value: row!.previous_value }, after: { value: row!.value, changePct: row!.change_pct, status: row!.status } });
    return result;
  }

  private async applyRate(manager: EntityManager, assetId: string, rate: string): Promise<void> {
    await manager.query('UPDATE wms.term_deposit_products SET interest_rate=$2 WHERE asset_id=$1', [assetId, rate]);
  }

  async importCsv(actor: Actor, csv: string, key: string | undefined, context: AuditContext) {
    const rows = parsePriceCsv(csv);
    let fresh = false;
    const applied = new Set<string>();
    const now = this.options.clock.now();
    const result = await this.database.transaction(manager => idempotent(manager, actor.actorId, 'PRICE_IMPORT', 'import', key, { csv }, now, async () => {
      fresh = true;
      const outcomes = [];
      // Each row has its own transaction, so a bad row stops only itself.
      for (const row of rows) outcomes.push({ line: row.line, assetCode: row.assetCode, ...await this.importRow(actor, row, context, applied) });
      await appendAudit(manager, actor, { type: 'PRICE_IMPORT', id: randomUUID() }, 'PRICE_IMPORTED', { rows: rows.length }, now,
        { ...context, before: null, after: { rows: rows.length, failed: outcomes.filter(outcome => outcome.status === 'ERROR').length } });
      return { rows: outcomes, scan: null as ScanSummary | null };
    }));
    if (!fresh) return result;
    return { ...result, scan: applied.size > 0 ? await this.scanner.scanHolders([...applied]) : null };
  }

  private async importRow(actor: Actor, row: { assetCode: string; value: string; effectiveDate: string }, context: AuditContext, applied: Set<string>) {
    try {
      if (!row.assetCode || !priceRule(row.value) || (row.effectiveDate !== '' && !dateRule(row.effectiveDate))) throw invalid();
      const now = this.options.clock.now();
      const entered = await this.database.transaction(manager => this.enter(manager, actor, 'asset_code=$1', row.assetCode, row.value, row.effectiveDate || undefined, context, now));
      if (entered.status === 'APPLIED' && entered.priceType !== 'INTEREST_RATE') applied.add(entered.assetId);
      return { status: entered.status as string, code: null };
    } catch (error) {
      const code = apiErrorCode(error);
      if (!code) this.options.logger.error({ code: 'PRICE_IMPORT_ROW_FAILED', line: row.assetCode });
      return { status: 'ERROR', code: code ?? 'INTERNAL_ERROR' };
    }
  }

  async pending() {
    const rows: Array<Record<string, unknown>> = await this.database.query(`SELECT p.pricing_id AS "pricingId",p.asset_id AS "assetId",a.asset_code AS "assetCode",a.asset_name AS "assetName",p.price_type::text AS "priceType",
        p.previous_value::text AS "previousValue",p.value::text AS value,p.change_pct::text AS "changePct",to_char(p.effective_date,'YYYY-MM-DD') AS "effectiveDate",s.employee_code AS "makerCode",p.created_at AS "createdAt"
      FROM wms.asset_pricing p JOIN wms.assets a USING(asset_id) JOIN wms.staff_users s ON s.staff_id=p.created_by WHERE ${AWAITING} ORDER BY p.created_at`);
    return { items: rows };
  }

  async decide(actor: Actor, pricingId: string, decision: 'APPROVED' | 'REJECTED', reason: string, key: string | undefined, context: AuditContext) {
    let fresh = false;
    const now = this.options.clock.now();
    const body = { decision, reason };
    const result = await this.database.transaction(manager => idempotent(manager, actor.actorId, 'PRICE_DECISION', pricingId, key, body, now, async () => {
      fresh = true;
      const [found] = await manager.query('SELECT asset_id FROM wms.asset_pricing WHERE pricing_id=$1', [pricingId]);
      if (!found) throw notPending();
      // The same lock as entering a price, so a decision and a new entry cannot cross.
      await manager.query('SELECT 1 FROM wms.assets WHERE asset_id=$1 FOR UPDATE', [found.asset_id]);
      const [row]: Array<{ asset_id: string; created_by: string; price_type: PriceType; value: string; previous_value: string | null }> = await manager.query(
        `SELECT p.asset_id,p.created_by,p.price_type::text AS price_type,p.value::text AS value,p.previous_value::text AS previous_value FROM wms.asset_pricing p WHERE p.pricing_id=$1 AND ${AWAITING}`, [pricingId]);
      if (!row) throw notPending();
      if (row.created_by === actor.staffId) throw new ApiError(403, 'MAKER_CHECKER_VIOLATION', 'The person who entered a price cannot decide on it');
      await manager.query('INSERT INTO wms.price_approvals(pricing_id,maker_id,checker_id,decision,reason,decided_at) VALUES($1,$2,$3,$4,$5,$6)',
        [pricingId, row.created_by, actor.staffId, decision, reason.trim(), now]);
      if (decision === 'APPROVED' && row.price_type === 'INTEREST_RATE') await this.applyRate(manager, row.asset_id, row.value);
      await appendAudit(manager, actor, { type: 'ASSET_PRICING', id: pricingId }, decision === 'APPROVED' ? 'PRICE_APPROVED' : 'PRICE_REJECTED', body, now,
        { ...context, before: { status: 'PENDING_APPROVAL' }, after: { decision, reason: reason.trim() } });
      return { pricingId, assetId: row.asset_id, priceType: row.price_type, previousValue: row.previous_value, value: row.value, decision, scan: null as ScanSummary | null };
    }));
    if (!fresh || decision !== 'APPROVED') return result;
    return { ...result, scan: await this.scanAfter(result) };
  }
}

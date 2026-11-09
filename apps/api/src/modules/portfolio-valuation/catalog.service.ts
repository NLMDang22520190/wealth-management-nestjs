import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import type { ApplicationOptions } from '../../application.js';
import type { Actor } from '../../auth/actor.js';
import { ApiError } from '../../platform/http.js';
import type { AuditContext } from '../../platform/http.js';
import { RUNTIME_OPTIONS } from '../../platform/runtime.module.js';
import { appendAudit, idempotent } from '../../platform/transactions.js';
import { vietnamDate } from '../accounts-ledger/cash.domain.js';
import { assertClassFields, assetNotFound, PRICE_TYPE } from './portfolio.domain.js';
import type { AssetQuery, AssetRiskBody, AssetStatusBody, CreateAssetBody } from './portfolio.domain.js';

interface AssetRow {
  asset_id: string; asset_code: string; asset_name: string; asset_class: string; risk_level: number; min_investment: string; status: string; created_at: Date; updated_at: Date;
}
const ASSET_COLUMNS = "asset_id,asset_code,asset_name,asset_class::text AS asset_class,risk_level,min_investment::text AS min_investment,status::text AS status,created_at,updated_at";

const assetView = (row: AssetRow) => ({ assetId: row.asset_id, assetCode: row.asset_code, assetName: row.asset_name, assetClass: row.asset_class, riskLevel: row.risk_level,
  minInvestment: row.min_investment, status: row.status, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() });

/** UC-09. The team triggers compare dates with CURRENT_DATE, so transactions writing them use the Vietnam calendar day like the rest of the API. */
@Injectable()
export class CatalogService {
  constructor(private readonly database: DataSource, @Inject(RUNTIME_OPTIONS) private readonly options: ApplicationOptions) {}

  create(actor: Actor, body: CreateAssetBody, key: string | undefined, context: AuditContext) {
    assertClassFields(body);
    const now = this.options.clock.now();
    return this.database.transaction(manager => idempotent(manager, actor.actorId, 'ASSET_CREATE', 'catalog', key, body, now, async () => {
      if (body.maturityDate && body.maturityDate < vietnamDate(now)) throw new ApiError(400, 'BOND_MATURITY_PASSED', 'The bond maturity date has passed');
      await manager.query("SET LOCAL TIME ZONE 'Asia/Ho_Chi_Minh'");
      const [row]: AssetRow[] = await manager.query(`INSERT INTO wms.assets(asset_code,asset_name,asset_class,risk_level,min_investment,created_by,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT (asset_code) DO NOTHING RETURNING ${ASSET_COLUMNS}`,
      [body.assetCode.trim(), body.assetName.trim(), body.assetClass, body.riskLevel, body.minInvestment ?? '0', actor.staffId, now]);
      if (!row) throw new ApiError(409, 'PRODUCT_CODE_EXISTS', 'The product code already exists');
      await this.insertDetails(manager, row.asset_id, body);
      const start = body.assetClass === 'TERM_DEPOSIT' ? body.interestRate : body.initialPrice;
      if (start) {
        await manager.query("INSERT INTO wms.asset_pricing(asset_id,price_type,value,effective_date,status,created_by,created_at) VALUES($1,$2,$3,$4,'APPLIED',$5,$6)",
          [row.asset_id, PRICE_TYPE[body.assetClass], start, vietnamDate(now), actor.staffId, now]);
      }
      await appendAudit(manager, actor, { type: 'ASSET', id: row.asset_id }, 'ASSET_CREATED', body, now,
        { ...context, before: null, after: { assetCode: row.asset_code, assetClass: row.asset_class, riskLevel: row.risk_level, status: row.status } });
      return assetView(row);
    }, 201));
  }

  private async insertDetails(manager: EntityManager, assetId: string, body: CreateAssetBody): Promise<void> {
    if (body.assetClass === 'TERM_DEPOSIT') {
      await manager.query('INSERT INTO wms.term_deposit_products(asset_id,term_months,interest_rate) VALUES($1,$2,$3)', [assetId, body.termMonths, body.interestRate]);
    } else if (body.assetClass === 'BOND') {
      await manager.query('INSERT INTO wms.bond_products(asset_id,face_value,coupon_rate,issue_date,maturity_date,issuer) VALUES($1,$2,$3,$4,$5,$6)',
        [assetId, body.faceValue, body.couponRate, body.issueDate ?? null, body.maturityDate, body.issuer!.trim()]);
    } else {
      await manager.query('INSERT INTO wms.mutual_fund_products(asset_id,fund_type,fund_manager) VALUES($1,$2,$3)', [assetId, body.fundType, body.fundManager!.trim()]);
    }
  }

  async list(query: AssetQuery) {
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (condition: string, value: unknown) => { params.push(value); where.push(condition.replaceAll('?', `$${params.length}`)); };
    if (query.assetClass) add('asset_class=?', query.assetClass);
    if (query.status) add('status=?', query.status);
    if (query.q) add('(asset_code ILIKE ? OR asset_name ILIKE ?)', `%${query.q.replace(/[\\%_]/g, '\\$&')}%`);
    const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    const [count] = await this.database.query(`SELECT count(*)::int AS total FROM wms.assets${clause}`, params);
    const rows: AssetRow[] = await this.database.query(`SELECT ${ASSET_COLUMNS} FROM wms.assets${clause} ORDER BY asset_code LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, query.pageSize, (query.page - 1) * query.pageSize]);
    return { items: rows.map(assetView), total: count.total as number, page: query.page, pageSize: query.pageSize };
  }

  async detail(assetId: string) {
    const [row]: AssetRow[] = await this.database.query(`SELECT ${ASSET_COLUMNS} FROM wms.assets WHERE asset_id=$1`, [assetId]);
    if (!row) throw assetNotFound();
    const prices = await this.database.query(`SELECT p.pricing_id AS "pricingId",p.price_type::text AS "priceType",p.value::text AS value,p.previous_value::text AS "previousValue",p.change_pct::text AS "changePct",
        to_char(p.effective_date,'YYYY-MM-DD') AS "effectiveDate",p.status::text AS status,a.decision::text AS decision,p.created_at AS "createdAt"
      FROM wms.asset_pricing p LEFT JOIN wms.price_approvals a USING(pricing_id) WHERE p.asset_id=$1 ORDER BY p.effective_date DESC,p.created_at DESC LIMIT 20`, [assetId]);
    return { ...assetView(row), details: await this.details(row), prices };
  }

  private async details(row: AssetRow): Promise<Record<string, unknown> | null> {
    const query = {
      TERM_DEPOSIT: 'SELECT term_months AS "termMonths",interest_rate::text AS "interestRate" FROM wms.term_deposit_products WHERE asset_id=$1',
      BOND: `SELECT face_value::text AS "faceValue",coupon_rate::text AS "couponRate",to_char(issue_date,'YYYY-MM-DD') AS "issueDate",to_char(maturity_date,'YYYY-MM-DD') AS "maturityDate",issuer FROM wms.bond_products WHERE asset_id=$1`,
      MUTUAL_FUND: 'SELECT fund_type AS "fundType",fund_manager AS "fundManager" FROM wms.mutual_fund_products WHERE asset_id=$1',
    }[row.asset_class as 'TERM_DEPOSIT' | 'BOND' | 'MUTUAL_FUND'];
    const [details] = await this.database.query(query, [row.asset_id]);
    return details ?? null;
  }

  /** Discontinuing hides a product from new proposals; what customers already hold is untouched. */
  changeStatus(actor: Actor, assetId: string, body: AssetStatusBody, key: string | undefined, context: AuditContext) {
    return this.change(actor, assetId, 'ASSET_STATUS', 'ASSET_STATUS_CHANGED', body, key, context, 'status=$2', body.status,
      row => ({ status: row.status }));
  }

  /** The warning to RMs is computed on read (`riskWarnings`), so it clears by itself once nobody exceeds their maximum. */
  changeRisk(actor: Actor, assetId: string, body: AssetRiskBody, key: string | undefined, context: AuditContext) {
    return this.change(actor, assetId, 'ASSET_RISK', 'ASSET_RISK_CHANGED', body, key, context, 'risk_level=$2', body.riskLevel,
      row => ({ riskLevel: row.risk_level }));
  }

  private change(actor: Actor, assetId: string, purpose: string, action: string, body: unknown, key: string | undefined, context: AuditContext,
    assignment: string, value: unknown, snapshot: (row: AssetRow) => Record<string, unknown>) {
    const now = this.options.clock.now();
    return this.database.transaction(manager => idempotent(manager, actor.actorId, purpose, assetId, key, body, now, async () => {
      const [before]: AssetRow[] = await manager.query(`SELECT ${ASSET_COLUMNS} FROM wms.assets WHERE asset_id=$1 FOR UPDATE`, [assetId]);
      if (!before) throw assetNotFound();
      const [rows]: [AssetRow[], number] = await manager.query(`UPDATE wms.assets SET ${assignment} WHERE asset_id=$1 RETURNING ${ASSET_COLUMNS}`, [assetId, value]);
      const after = rows[0]!;
      await appendAudit(manager, actor, { type: 'ASSET', id: assetId }, action, body, now, { ...context, before: snapshot(before), after: snapshot(after) });
      return assetView(after);
    }));
  }

  /** What RMs may offer: products on sale, with the latest usable price. */
  async products() {
    const rows: Array<AssetRow & { price: string | null; price_date: string | null }> = await this.database.query(`SELECT ${ASSET_COLUMNS},price,price_date FROM wms.assets a
      LEFT JOIN LATERAL (SELECT p.value::text AS price,to_char(p.effective_date,'YYYY-MM-DD') AS price_date FROM wms.v_asset_latest_price p WHERE p.asset_id=a.asset_id LIMIT 1) latest ON true
      WHERE a.status='ON_SALE' ORDER BY a.asset_class,a.asset_code`);
    return { items: rows.map(row => ({ ...assetView(row), latestPrice: row.price, priceDate: row.price_date })) };
  }

  /** Customers of this RM holding a product above the maximum of their current risk profile (BR-18). */
  async riskWarnings(actor: Actor) {
    const rows: Array<{ customer_id: string; full_name: string; asset_id: string; asset_code: string; asset_name: string; risk_level: number; max_product_risk: number }> = await this.database.query(
      `SELECT DISTINCT c.customer_id,c.full_name,a.asset_id,a.asset_code,a.asset_name,a.risk_level,rp.max_product_risk
       FROM wms.rm_assignments ra JOIN wms.customers c USING(customer_id) JOIN wms.wealth_services ws USING(customer_id)
       JOIN wms.risk_profiles rp ON rp.risk_profile_id=ws.current_risk_profile_id JOIN wms.investment_accounts ia ON ia.customer_id=c.customer_id
       JOIN wms.portfolio_holdings h ON h.account_id=ia.account_id AND h.status='OPEN' JOIN wms.assets a ON a.asset_id=h.asset_id
       WHERE ra.rm_id=$1 AND ra.valid_to IS NULL AND a.risk_level>rp.max_product_risk ORDER BY c.full_name,a.asset_code`, [actor.rmId]);
    return { items: rows.map(row => ({ customerId: row.customer_id, fullName: row.full_name, assetId: row.asset_id, assetCode: row.asset_code, assetName: row.asset_name,
      riskLevel: row.risk_level, maxProductRisk: row.max_product_risk })) };
  }
}

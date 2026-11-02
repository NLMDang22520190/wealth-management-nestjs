import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { ApplicationOptions } from '../../application.js';
import type { Actor } from '../../auth/actor.js';
import { ApiError } from '../../platform/http.js';
import type { AuditContext } from '../../platform/http.js';
import { apiErrorCode, recordOutcome } from '../../platform/transactions.js';
import { RUNTIME_OPTIONS } from '../../platform/runtime.module.js';
import { CustomerAccess } from './customer-access.service.js';
import { customerSummary } from './rm-customers.domain.js';
import type { CustomerListQuery, CustomerSummaryRow } from './rm-customers.domain.js';

const SORT_SQL = { name: 's.name', aum: 'aum.value', riskExpiresAt: 'rp.expires_at', pendingProposals: 'COALESCE(pp.count,0)' } as const;

/**
 * Set-based read model: scope, P2 balance, P3 snapshot and P4 proposal counts are joined once, never per customer.
 * Cash is v_account_balance.available_balance; AUM is the latest portfolio_snapshots row (as-of = its snapshot date).
 */
const SELECT = `
  SELECT s.id AS customer_id, s.name, s.status AS service_status, s.rm_id, s.team_id, s.version AS assignment_version,
    s.provisional, s.valid_from AS assigned_from, rp.risk_profile_id AS risk_id, rp.category::text AS risk_category, rp.version AS risk_version,
    rp.expires_at AS risk_expires_at, aum.value::text AS aum_value, aum.snapshot_date AS aum_as_of,
    ia.available_balance::text AS cash_value,
    COALESCE(dr.count,0)::integer AS drift_count, COALESCE(pp.count,0)::integer AS pending_count
  FROM scope s
  LEFT JOIN wms.risk_profiles rp ON rp.risk_profile_id=s.current_risk_profile_id
  LEFT JOIN wms.v_account_balance ia ON ia.customer_id=s.id
  LEFT JOIN (SELECT DISTINCT ON (customer_id) customer_id, aum AS value, to_char(snapshot_date,'YYYY-MM-DD') AS snapshot_date
    FROM wms.portfolio_snapshots WHERE customer_id IN (SELECT id FROM scope)
    ORDER BY customer_id,snapshot_date DESC) aum ON aum.customer_id=s.id
  LEFT JOIN (SELECT customer_id, count(*) AS count FROM wms.proposals WHERE status='PENDING_APPROVAL'
    AND customer_id IN (SELECT id FROM scope) GROUP BY customer_id) pp ON pp.customer_id=s.id
  LEFT JOIN (SELECT aggregate_id, count(*) AS count FROM wms.outbox_events WHERE event_type='RiskHoldingsCheckRequested'
    AND published_at IS NULL AND payload->>'triggerDrift'='true' AND aggregate_id IN (SELECT id FROM scope) GROUP BY aggregate_id) dr
    ON dr.aggregate_id=s.id`;

@Injectable()
export class RmCustomersService {
  constructor(private readonly database: DataSource, private readonly access: CustomerAccess,
    @Inject(RUNTIME_OPTIONS) private readonly options: ApplicationOptions) {}

  private scope(where: string): string {
    return `WITH scope AS (SELECT c.customer_id AS id,c.full_name AS name,ws.status::text AS status,ws.current_risk_profile_id,a.rm_id,a.team_id,a.version,a.provisional,a.valid_from
      FROM wms.customers c JOIN wms.rm_assignments a ON a.customer_id=c.customer_id AND a.valid_to IS NULL
      JOIN wms.wealth_services ws ON ws.customer_id=c.customer_id WHERE ${where})`;
  }

  async list(actor: Actor, query: CustomerListQuery) {
    if (actor.role !== 'RM' || !actor.rmId) throw new ApiError(403, 'FORBIDDEN', 'Access denied');
    const now = this.options.clock.now();
    const params: unknown[] = [actor.rmId];
    const filters: string[] = [];
    const bind = (value: unknown) => { params.push(value); return `$${params.length}`; };
    if (query.name) filters.push(`s.name ILIKE ${bind(`%${query.name.replace(/[\\%_]/g, '\\$&')}%`)}`);
    if (query.risk) filters.push(`rp.category::text=${bind(query.risk)}`);
    if (query.serviceStatus) filters.push(`s.status=${bind(query.serviceStatus)}`);
    if (query.riskExpiry === 'VALID') filters.push(`rp.expires_at > ${bind(now)}`);
    if (query.riskExpiry === 'EXPIRED') filters.push(`rp.expires_at <= ${bind(now)}`);
    if (query.riskExpiry === 'MISSING') filters.push('rp.risk_profile_id IS NULL');
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const direction = query.direction === 'desc' ? 'DESC' : 'ASC';
    // Sort happens in SQL over the full authorized set before LIMIT/OFFSET; customer id is the stable tie-break.
    const order = `${query.sort ? `${SORT_SQL[query.sort]} ${direction} NULLS LAST,` : ''} s.id ASC`;
    const base = this.scope('a.rm_id=$1');
    const [count] = await this.database.query(`${base} SELECT count(*)::integer AS total FROM (${SELECT} ${where}) filtered`, params);
    const limit = bind(query.pageSize);
    const offset = bind((query.page - 1) * query.pageSize);
    const rows: CustomerSummaryRow[] = await this.database.query(`${base} ${SELECT} ${where} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, params);
    return { items: rows.map(row => customerSummary(row, now)), total: count.total, page: query.page, pageSize: query.pageSize };
  }

  async detail(actor: Actor, customerId: string, context: AuditContext) {
    let customer;
    try { customer = await this.access.authorize(actor, customerId, this.database.manager); }
    catch (error) {
      if (apiErrorCode(error) === 'FORBIDDEN') {
        await recordOutcome(this.database, 'DENIED', actor, { type: 'CUSTOMER', id: customerId }, 'CUSTOMER_DETAIL_READ', 'FORBIDDEN', this.options.clock.now(), context);
      }
      throw error;
    }
    const [row]: CustomerSummaryRow[] = await this.database.query(`${this.scope('c.customer_id=$1')} ${SELECT}`, [customer.id]);
    if (!row) throw new ApiError(403, 'FORBIDDEN', 'Access denied');
    return customerSummary(row, this.options.clock.now());
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { ApplicationOptions } from '../../application.js';
import type { Actor } from '../../auth/actor.js';
import { ApiError } from '../../platform/http.js';
import { RUNTIME_OPTIONS } from '../../platform/runtime.module.js';
import { CustomerAccess } from './customer-access.service.js';
import { customerSummary } from './rm-customers.domain.js';
import type { CustomerListQuery, CustomerSummaryRow } from './rm-customers.domain.js';

const SORT_SQL = { name: 's.name', aum: 'aum.value', riskExpiresAt: 'rp.expires_at', pendingProposals: 'COALESCE(pp.count,0)' } as const;

/** Set-based read model: scope, P3 holdings and P4 proposal counts are joined once, never per customer. */
const SELECT = `
  SELECT s.id AS customer_id, s.name, s.status AS service_status, s.rm_id, s.team_id, s.version AS assignment_version,
    s.provisional, s.valid_from AS assigned_from, rp.id AS risk_id, rp.category AS risk_category, rp.version AS risk_version,
    rp.expires_at AS risk_expires_at, aum.value::text AS aum_value, aum.as_of AS aum_as_of, aum.provenance AS aum_provenance,
    COALESCE(dr.count,0)::integer AS drift_count, COALESCE(pp.count,0)::integer AS pending_count
  FROM scope s
  LEFT JOIN risk_profiles rp ON rp.id=s.current_risk_profile_id
  LEFT JOIN (SELECT customer_id, sum(market_value) AS value, max(as_of) AS as_of,
      CASE WHEN count(DISTINCT provenance)=1 THEN min(provenance) END AS provenance
    FROM (SELECT DISTINCT ON (customer_id,product_id) customer_id,product_id,market_value,as_of,provenance
      FROM holdings_read_snapshots WHERE customer_id IN (SELECT id FROM scope)
      ORDER BY customer_id,product_id,as_of DESC,id DESC) latest GROUP BY customer_id) aum ON aum.customer_id=s.id
  LEFT JOIN (SELECT customer_id, count(*) AS count FROM proposals WHERE status='PENDING_APPROVAL'
    AND customer_id IN (SELECT id FROM scope) GROUP BY customer_id) pp ON pp.customer_id=s.id
  LEFT JOIN (SELECT aggregate_id, count(*) AS count FROM outbox_events WHERE event_type='RiskHoldingsCheckRequested'
    AND published_at IS NULL AND payload->>'triggerDrift'='true' AND aggregate_id IN (SELECT id FROM scope) GROUP BY aggregate_id) dr
    ON dr.aggregate_id=s.id`;

@Injectable()
export class RmCustomersService {
  constructor(private readonly database: DataSource, private readonly access: CustomerAccess,
    @Inject(RUNTIME_OPTIONS) private readonly options: ApplicationOptions) {}

  private scope(where: string): string {
    return `WITH scope AS (SELECT c.id,c.name,ws.status,ws.current_risk_profile_id,a.rm_id,a.team_id,a.version,a.provisional,a.valid_from
      FROM customers c JOIN rm_assignment_history a ON a.customer_id=c.id AND a.valid_to IS NULL
      JOIN wealth_services ws ON ws.customer_id=c.id WHERE ${where})`;
  }

  async list(actor: Actor, query: CustomerListQuery) {
    if (actor.role !== 'RM' || !actor.rmId) throw new ApiError(403, 'FORBIDDEN', 'Access denied');
    const now = this.options.clock.now();
    const params: unknown[] = [actor.rmId];
    const filters: string[] = [];
    const bind = (value: unknown) => { params.push(value); return `$${params.length}`; };
    if (query.name) filters.push(`s.name ILIKE ${bind(`%${query.name.replace(/[\\%_]/g, '\\$&')}%`)}`);
    if (query.risk) filters.push(`rp.category=${bind(query.risk)}`);
    if (query.serviceStatus) filters.push(`s.status=${bind(query.serviceStatus)}`);
    if (query.riskExpiry === 'VALID') filters.push(`rp.expires_at > ${bind(now)}`);
    if (query.riskExpiry === 'EXPIRED') filters.push(`rp.expires_at <= ${bind(now)}`);
    if (query.riskExpiry === 'MISSING') filters.push('rp.id IS NULL');
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

  async detail(actor: Actor, customerId: string) {
    const customer = await this.access.authorize(actor, customerId, this.database.manager);
    const [row]: CustomerSummaryRow[] = await this.database.query(`${this.scope('c.id=$1')} ${SELECT}`, [customer.id]);
    if (!row) throw new ApiError(403, 'FORBIDDEN', 'Access denied');
    return customerSummary(row, this.options.clock.now());
  }
}

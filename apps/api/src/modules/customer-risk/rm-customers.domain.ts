import { ApiError } from '../../platform/http.js';
import { riskPaging } from './risk.domain.js';

export const CUSTOMER_SORTS = ['name', 'aum', 'riskExpiresAt', 'pendingProposals'] as const;
export type CustomerSort = typeof CUSTOMER_SORTS[number];
const RISK_CATEGORIES = ['CONSERVATIVE', 'BALANCED', 'GROWTH'];
const RISK_EXPIRY = ['VALID', 'EXPIRED', 'MISSING'];

export interface CustomerListQuery {
  page: number; pageSize: number; sort: CustomerSort | undefined; direction: 'asc' | 'desc';
  name?: string; risk?: string; serviceStatus?: string; riskExpiry?: 'VALID' | 'EXPIRED' | 'MISSING';
}
type Raw = Record<string, unknown>;

function invalid(): never { throw new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed'); }
function single(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') invalid();
  return value;
}

/** Only whitelisted keys are read; any other key, such as an injected rmId, never influences scope. */
export function parseCustomerListQuery(raw: Raw): CustomerListQuery {
  const { page, pageSize } = riskPaging(single(raw.page), single(raw.pageSize));
  const sort = single(raw.sort);
  if (sort !== undefined && !(CUSTOMER_SORTS as readonly string[]).includes(sort)) invalid();
  const direction = single(raw.direction) ?? 'asc';
  if (direction !== 'asc' && direction !== 'desc') invalid();
  const name = single(raw.name);
  if (name !== undefined && (name.trim().length === 0 || name.length > 100)) invalid();
  const risk = single(raw.risk);
  if (risk !== undefined && !RISK_CATEGORIES.includes(risk)) invalid();
  const serviceStatus = single(raw.serviceStatus);
  if (serviceStatus !== undefined && !/^[A-Z_]{1,40}$/.test(serviceStatus)) invalid();
  const riskExpiry = single(raw.riskExpiry);
  if (riskExpiry !== undefined && !RISK_EXPIRY.includes(riskExpiry)) invalid();
  return { page, pageSize, sort: sort as CustomerSort | undefined, direction,
    name: name?.trim(), risk, serviceStatus, riskExpiry: riskExpiry as CustomerListQuery['riskExpiry'] };
}

export interface CustomerSummaryRow {
  customer_id: string; name: string; service_status: string; rm_id: string; team_id: string; assignment_version: number;
  provisional: boolean; assigned_from: Date; risk_id: string | null; risk_category: string | null; risk_version: number | null;
  risk_expires_at: Date | null; aum_value: string | null; aum_as_of: Date | null; aum_provenance: string | null;
  drift_count: number; pending_count: number;
}

export function customerSummary(row: CustomerSummaryRow, now: Date) {
  const iso = (value: Date) => new Date(value).toISOString();
  return {
    customerId: row.customer_id, name: row.name, serviceStatus: row.service_status,
    currentAssignment: { rmId: row.rm_id, teamId: row.team_id, version: row.assignment_version,
      provisional: row.provisional, validFrom: iso(row.assigned_from) },
    currentRisk: row.risk_id ? { id: row.risk_id, category: row.risk_category, version: row.risk_version,
      expiresAt: iso(row.risk_expires_at!), valid: now.getTime() < new Date(row.risk_expires_at!).getTime() } : null,
    // Missing valuation is unknown, never zero; value is a decimal string produced by SQL numeric math.
    aum: row.aum_value === null
      ? { value: null, asOf: null, provenance: null, dataStatus: 'UNAVAILABLE' }
      : { value: row.aum_value, asOf: iso(row.aum_as_of!), provenance: row.aum_provenance, dataStatus: 'AVAILABLE' },
    driftAlerts: { count: row.drift_count, asOf: now.toISOString(), provenance: 'OUTBOX_RISK_HOLDINGS_CHECK', dataStatus: 'AVAILABLE' },
    pendingProposals: { count: row.pending_count, asOf: now.toISOString(), provenance: 'PROPOSALS_TABLE', dataStatus: 'AVAILABLE' },
  };
}

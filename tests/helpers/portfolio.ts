import { expect } from 'vitest';
import { actors, viaDataSource } from './actors.js';
import { account, BACK_OFFICE, insertBackOffice, nextKey } from './cash.js';
import type { Api } from './cash.js';

export const MANAGER = 'NV0191';
export const RM = actors.rm.actorId;

export async function insertManager(api: Api) {
  await viaDataSource(api.dataSource)(`INSERT INTO wms.staff_users(iam_subject,employee_code,full_name,role)
    VALUES('iam.bom','${MANAGER}','BO manager','BACK_OFFICE_MANAGER')`);
  return api.tokenFor(MANAGER);
}
export async function staffTokens(api: Api) { return { backOffice: await insertBackOffice(api), manager: await insertManager(api) }; }

let serial = 0;
export const CREATE = { TERM_DEPOSIT: { termMonths: 6, interestRate: '5.2' },
  BOND: { faceValue: '100000', couponRate: '8.5', maturityDate: '2030-01-01', issuer: 'Synthetic issuer', initialPrice: '100000' },
  MUTUAL_FUND: { fundType: 'BALANCED', fundManager: 'Synthetic manager', initialPrice: '20000' } } as const;
export type AssetClass = keyof typeof CREATE;

export function assetBody(assetClass: AssetClass, extra: Record<string, unknown> = {}) {
  return { assetClass, assetCode: `P3-${++serial}`, assetName: 'Sản phẩm mẫu', riskLevel: 2, minInvestment: '1000000', ...CREATE[assetClass], ...extra };
}

export async function createAsset(api: Api, token: string, assetClass: AssetClass, extra: Record<string, unknown> = {}) {
  const created = await api.request('/back-office/assets', { method: 'POST', token, key: nextKey('asset'), body: assetBody(assetClass, extra) });
  expect(created.status).toBe(201);
  return created.body as { assetId: string; assetCode: string };
}

/** The clock moves first: v_asset_latest_price breaks a same-day tie by created_at, and the fixture clock is frozen. */
export const submitPrice = (api: Api, token: string, assetId: string, value: string, effectiveDate?: string, key = nextKey('price')) => {
  api.tick();
  return api.request('/back-office/prices', { method: 'POST', token, key, body: { assetId, value, ...(effectiveDate ? { effectiveDate } : {}) } });
};

export const decide = (api: Api, token: string, pricingId: string, decision: 'approve' | 'reject', reason = 'Đã đối chiếu với công ty quản lý quỹ') =>
  api.request(`/back-office/prices/${pricingId}/${decision}`, { method: 'POST', token, key: nextKey('decide'), body: { reason } });

/** A market holding (bond or fund). P3 never writes holdings; UC-16 will, so these are fixtures. */
export async function holdUnits(api: Api, assetId: string, quantity: string, avgCost: string) {
  const { account_id: accountId } = await account(api);
  await api.dataSource.query('INSERT INTO wms.portfolio_holdings(account_id,asset_id,quantity,avg_cost) VALUES($1,$2,$3,$4)', [accountId, assetId, quantity, avgCost]);
}

export async function holdDeposit(api: Api, assetId: string, input: { principal: string; rate: string; start: string; maturity: string }) {
  const { account_id: accountId } = await account(api);
  await api.dataSource.query('INSERT INTO wms.portfolio_holdings(account_id,asset_id,principal,locked_rate,start_date,maturity_date) VALUES($1,$2,$3,$4,$5,$6)',
    [accountId, assetId, input.principal, input.rate, input.start, input.maturity]);
}

export const runSnapshot = (api: Api, token: string, asOf?: string) => api.request('/demo/jobs/portfolio-snapshot', { method: 'POST', token, body: asOf ? { asOf } : {} });

export const snapshots = (api: Api) => api.dataSource.query(
  "SELECT snapshot_kind,to_char(snapshot_date,'YYYY-MM-DD') AS date,aum::text AS aum FROM wms.portfolio_snapshots ORDER BY created_at,snapshot_kind") as Promise<Array<{ snapshot_kind: string; date: string; aum: string }>>;

export const alerts = (api: Api) => api.dataSource.query(`SELECT a.allocation_class::text AS class,a.status::text AS status,a.actual_weight::text AS actual,a.target_weight::text AS target,
    s.direction::text AS direction,s.adjust_amount::text AS amount
  FROM wms.drift_alerts a LEFT JOIN wms.rebalance_suggestions s USING(alert_id) ORDER BY a.created_at,a.allocation_class`) as Promise<Array<{ class: string; status: string; actual: string; target: string; direction: string | null; amount: string | null }>>;

export { BACK_OFFICE };

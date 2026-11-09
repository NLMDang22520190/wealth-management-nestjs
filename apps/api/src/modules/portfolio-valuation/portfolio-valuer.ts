import type { EntityManager } from 'typeorm';

export type AllocationClass = 'CASH' | 'TERM_DEPOSIT' | 'BOND' | 'MUTUAL_FUND';
const ALLOCATION_ORDER: Array<{ allocationClass: AllocationClass; key: 'cash' | 'deposit' | 'bond' | 'fund' }> = [
  { allocationClass: 'CASH', key: 'cash' }, { allocationClass: 'TERM_DEPOSIT', key: 'deposit' }, { allocationClass: 'BOND', key: 'bond' }, { allocationClass: 'MUTUAL_FUND', key: 'fund' }];

/** A price older than this many working days is labelled, not refused (process 3c). */
const STALE_AFTER_WORKING_DAYS = 3;

/** Money is integer cents in BigInt and weights are integer basis points: JS floats never touch either. */
function cents(amount: string): bigint {
  const negative = amount.startsWith('-');
  const [whole, fraction = ''] = (negative ? amount.slice(1) : amount).split('.');
  const value = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
  return negative ? -value : value;
}
function money(value: bigint): string {
  const digits = (value < 0n ? -value : value).toString().padStart(3, '0');
  return `${value < 0n ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}
const percent = money;
const roundedDivide = (numerator: bigint, denominator: bigint) => (numerator * 2n + denominator) / (denominator * 2n);
const absolute = (value: bigint) => (value < 0n ? -value : value);

function workingDaysAfter(from: string, to: string): number {
  let count = 0;
  const day = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`).getTime();
  while (count <= STALE_AFTER_WORKING_DAYS) {
    day.setUTCDate(day.getUTCDate() + 1);
    if (day.getTime() > end) break;
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) count += 1;
  }
  return count;
}

interface HoldingRow {
  holding_id: string; asset_id: string; asset_code: string; asset_name: string; asset_class: 'TERM_DEPOSIT' | 'BOND' | 'MUTUAL_FUND'; risk_level: number; quantity: string; principal: string;
  locked_rate: string | null; maturity_date: string | null; unit_price: string | null; price_date: string | null; accrued: string | null; cost: string; value: string | null;
}

export interface AllocationRow {
  allocationClass: AllocationClass; value: string; actualWeight: string | null; targetWeight: string | null; deviation: string | null; drifted: boolean;
  direction: 'INCREASE' | 'DECREASE' | null; suggestedAmount: string | null;
}

export interface Valuation {
  customerId: string; accountId: string; riskProfileId: string | null; asOf: string; dataStatus: 'COMPLETE' | 'INCOMPLETE'; hasStalePrice: boolean;
  aum: string; cash: string; depositValue: string; bondValue: string; fundValue: string; totalCost: string; unrealizedPnl: string;
  items: Array<{
    holdingId: string; assetId: string; assetCode: string; assetName: string; assetClass: string; riskLevel: number; quantity: string; unitPrice: string | null; priceDate: string | null; priceStale: boolean;
    principal: string; accruedInterest: string | null; cost: string; value: string | null; unrealizedPnl: string | null; maturityDate: string | null;
  }>;
  allocation: AllocationRow[];
}

/**
 * BR-17, read only: deposit = principal + interest accrued so far, bond and fund = quantity x latest usable price. Holdings belong to UC-16, so nothing is written
 * back; `accrued_interest` is not read because nothing keeps it current. Prices waiting for approval are invisible through v_asset_latest_price.
 */
export async function valuePortfolio(manager: EntityManager, customerId: string, asOf: string): Promise<Valuation | null> {
  const [owner] = await manager.query(`SELECT b.account_id,b.available_balance::text AS cash,ws.current_risk_profile_id AS risk_profile_id,rp.category::text AS category,
      (rp.allocation->>'cash')::numeric(6,2)::text AS target_cash,(rp.allocation->>'deposit')::numeric(6,2)::text AS target_deposit,
      (rp.allocation->>'bond')::numeric(6,2)::text AS target_bond,(rp.allocation->>'fund')::numeric(6,2)::text AS target_fund
    FROM wms.v_account_balance b LEFT JOIN wms.wealth_services ws ON ws.customer_id=b.customer_id LEFT JOIN wms.risk_profiles rp ON rp.risk_profile_id=ws.current_risk_profile_id
    WHERE b.customer_id=$1`, [customerId]);
  if (!owner) return null;
  const rows: HoldingRow[] = await manager.query(`SELECT h.holding_id,a.asset_id,a.asset_code,a.asset_name,a.asset_class::text AS asset_class,a.risk_level,h.quantity::text AS quantity,h.principal::text AS principal,
      h.locked_rate::text AS locked_rate,to_char(h.maturity_date,'YYYY-MM-DD') AS maturity_date,p.value::text AS unit_price,to_char(p.effective_date,'YYYY-MM-DD') AS price_date,
      d.accrued::text AS accrued,
      (CASE WHEN a.asset_class='TERM_DEPOSIT' THEN h.principal ELSE round(h.quantity*h.avg_cost,2) END)::numeric(20,2)::text AS cost,
      (CASE WHEN a.asset_class='TERM_DEPOSIT' THEN h.principal+d.accrued ELSE round(h.quantity*p.value,2) END)::numeric(20,2)::text AS value
    FROM wms.portfolio_holdings h JOIN wms.investment_accounts ia ON ia.account_id=h.account_id JOIN wms.assets a ON a.asset_id=h.asset_id
    LEFT JOIN wms.v_asset_latest_price p ON a.asset_class<>'TERM_DEPOSIT' AND p.asset_id=a.asset_id
      AND p.price_type=(CASE a.asset_class WHEN 'BOND' THEN 'BOND_PRICE' ELSE 'NAV' END)::wms.price_type
    LEFT JOIN LATERAL (SELECT floor(h.principal*COALESCE(h.locked_rate,0)*GREATEST(LEAST($2::date,COALESCE(h.maturity_date,$2::date))-COALESCE(h.start_date,$2::date),0)/36500)::numeric(20,2) AS accrued) d
      ON a.asset_class='TERM_DEPOSIT'
    WHERE ia.customer_id=$1 AND h.status='OPEN' ORDER BY a.asset_class,a.asset_code,h.holding_id`, [customerId, asOf]);

  const totals = { TERM_DEPOSIT: 0n, BOND: 0n, MUTUAL_FUND: 0n };
  let totalCost = 0n;
  let pnl = 0n;
  let complete = true;
  let hasStalePrice = false;
  const items = rows.map(row => {
    const value = row.value === null ? null : cents(row.value);
    const stale = row.price_date !== null && workingDaysAfter(row.price_date, asOf) > STALE_AFTER_WORKING_DAYS;
    hasStalePrice ||= stale;
    if (value === null) complete = false;
    else {
      totals[row.asset_class] += value;
      totalCost += cents(row.cost);
      pnl += value - cents(row.cost);
    }
    return { holdingId: row.holding_id, assetId: row.asset_id, assetCode: row.asset_code, assetName: row.asset_name, assetClass: row.asset_class, riskLevel: row.risk_level,
      quantity: row.quantity, unitPrice: row.unit_price, priceDate: row.price_date, priceStale: stale, principal: row.principal, accruedInterest: row.accrued, cost: row.cost,
      value: value === null ? null : money(value), unrealizedPnl: value === null ? null : money(value - cents(row.cost)), maturityDate: row.maturity_date };
  });

  const cash = cents(owner.cash);
  const aum = cash + totals.TERM_DEPOSIT + totals.BOND + totals.MUTUAL_FUND;
  const thresholds: Array<{ allocation_class: AllocationClass; threshold: string }> = owner.category
    ? await manager.query('SELECT allocation_class::text AS allocation_class,drift_threshold::text AS threshold FROM wms.target_allocations WHERE category=$1', [owner.category]) : [];
  const values: Record<AllocationClass, bigint> = { CASH: cash, ...totals };
  const allocation = ALLOCATION_ORDER.map(({ allocationClass, key }): AllocationRow => {
    const value = values[allocationClass];
    const targetText: string | null = owner[`target_${key}`] ?? null;
    const base = { allocationClass, value: money(value), targetWeight: targetText };
    if (aum === 0n || targetText === null) return { ...base, actualWeight: aum === 0n ? null : percent(roundedDivide(value * 10000n, aum)), deviation: null, drifted: false, direction: null, suggestedAmount: null };
    const actualBp = roundedDivide(value * 10000n, aum);
    const targetBp = cents(targetText);
    const deviationBp = absolute(actualBp - targetBp);
    const threshold = thresholds.find(row => row.allocation_class === allocationClass)?.threshold;
    const drifted = threshold !== undefined && deviationBp >= cents(threshold);
    const targetValue = roundedDivide(aum * targetBp, 10000n);
    return { ...base, actualWeight: percent(actualBp), deviation: percent(deviationBp), drifted, direction: drifted ? (value > targetValue ? 'DECREASE' : 'INCREASE') : null,
      suggestedAmount: drifted && value !== targetValue ? money(absolute(value - targetValue)) : null };
  });

  return { customerId, accountId: owner.account_id, riskProfileId: owner.risk_profile_id ?? null, asOf, dataStatus: complete ? 'COMPLETE' : 'INCOMPLETE', hasStalePrice,
    aum: money(aum), cash: money(cash), depositValue: money(totals.TERM_DEPOSIT), bondValue: money(totals.BOND), fundValue: money(totals.MUTUAL_FUND),
    totalCost: money(totalCost), unrealizedPnl: money(pnl), items, allocation };
}

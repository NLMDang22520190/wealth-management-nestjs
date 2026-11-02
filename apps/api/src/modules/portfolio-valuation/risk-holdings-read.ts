import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/** Label for holdings read from the P3 tables (the team schema has no per-row provenance column). */
const HOLDINGS_PROVENANCE = 'P3_PORTFOLIO_HOLDINGS';

/** P3 boundary: read the customer's OPEN holdings; no valuation, selling or holding mutation. */
@Injectable()
export class RiskHoldingsRead {
  constructor(private readonly database: DataSource) {}

  async pending(customerId: string, profileId: string, maxProductRisk: number) {
    const holdings: Array<{ product_id: string; product_risk: number; as_of: Date }> = await this.database.query(
      `SELECT a.asset_code AS product_id,a.risk_level AS product_risk,max(h.updated_at) AS as_of
        FROM wms.portfolio_holdings h
        JOIN wms.investment_accounts ia ON ia.account_id=h.account_id
        JOIN wms.assets a ON a.asset_id=h.asset_id
        WHERE ia.customer_id=$1 AND h.status='OPEN'
        GROUP BY a.asset_id,a.asset_code,a.risk_level ORDER BY a.asset_code`, [customerId]);
    const latest = holdings.reduce<Date | undefined>((date, holding) =>
      !date || new Date(holding.as_of) > date ? new Date(holding.as_of) : date, undefined);
    return { profileId, status: 'PENDING', asOf: latest?.toISOString() ?? null,
      provenance: holdings.length > 0 ? HOLDINGS_PROVENANCE : null,
      incompatibleHoldings: holdings.filter(item => item.product_risk > maxProductRisk)
        .map(item => ({ productId: item.product_id, productRisk: item.product_risk, maxProductRisk })) };
  }
}

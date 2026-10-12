import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/** P3 boundary: read actual persisted demo snapshots; no valuation, selling or holding mutation. */
@Injectable()
export class RiskHoldingsRead {
  constructor(private readonly database: DataSource) {}

  async pending(customerId: string, profileId: string, maxProductRisk: number) {
    const snapshots: Array<{ product_id: string; product_risk: number; as_of: Date; provenance: string }> =
      await this.database.query(`SELECT DISTINCT ON (product_id) product_id,product_risk,as_of,provenance
        FROM holdings_read_snapshots WHERE customer_id=$1 ORDER BY product_id,as_of DESC,id DESC`, [customerId]);
    const latest = snapshots.reduce<Date | undefined>((date, snapshot) =>
      !date || new Date(snapshot.as_of) > date ? new Date(snapshot.as_of) : date, undefined);
    return { profileId, status: 'PENDING', asOf: latest?.toISOString() ?? null,
      provenance: snapshots.length > 0 && snapshots.every(item => item.provenance === snapshots[0].provenance)
        ? snapshots[0].provenance : null,
      incompatibleHoldings: snapshots.filter(item => item.product_risk > maxProductRisk)
        .map(item => ({ productId: item.product_id, productRisk: item.product_risk, maxProductRisk })) };
  }
}

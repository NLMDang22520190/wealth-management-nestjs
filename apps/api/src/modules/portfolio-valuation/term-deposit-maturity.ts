import { Injectable } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';

export interface DueDeposit { holding_id: string; account_id: string; }
export interface LockedDeposit {
  holding_id: string; status: string; principal: string; interest: string | null; total: string | null; days: number | null;
}

/** P3 bridge for UC-08: P2 reads and closes term deposit holdings only through here. */
@Injectable()
export class TermDepositMaturity {
  /** `asset_class` matters: bonds carry a maturity date too but are not settled by this job. */
  due(database: DataSource, asOf: string): Promise<DueDeposit[]> {
    return database.query(`SELECT h.holding_id,h.account_id FROM wms.portfolio_holdings h JOIN wms.assets a USING(asset_id)
      WHERE h.status='OPEN' AND h.maturity_date<=$1 AND a.asset_class='TERM_DEPOSIT' ORDER BY h.maturity_date,h.holding_id`, [asOf]);
  }

  /** BR-P2-05, in SQL numeric: principal x annual % x days held / 365, rounded down to the dong. A late run adds no days. */
  async lock(manager: EntityManager, holdingId: string): Promise<LockedDeposit> {
    const [row] = await manager.query(`SELECT holding_id,status::text AS status,principal::text AS principal,(maturity_date-start_date)::int AS days,
        floor(principal*locked_rate*(maturity_date-start_date)/36500)::numeric(20,2)::text AS interest,
        (principal+floor(principal*locked_rate*(maturity_date-start_date)/36500))::numeric(20,2)::text AS total
      FROM wms.portfolio_holdings WHERE holding_id=$1 FOR UPDATE`, [holdingId]);
    return row;
  }

  async close(manager: EntityManager, holdingId: string): Promise<void> {
    await manager.query("UPDATE wms.portfolio_holdings SET status='CLOSED' WHERE holding_id=$1", [holdingId]);
  }
}

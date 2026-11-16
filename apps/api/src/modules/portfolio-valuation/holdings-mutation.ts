import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

/** The holding is gone, closed or smaller than the order: the execution must stop. */
export class HoldingUnavailable extends Error {}

/**
 * P3 bridge for UC-16: the only writer of `portfolio_holdings` besides UC-08. It runs in the caller's transaction, which already holds the
 * account lock, so each holding is locked here in turn.
 */
@Injectable()
export class HoldingsMutation {
  async sell(manager: EntityManager, accountId: string, holdingId: string, quantity: string): Promise<void> {
    const [holding] = await manager.query(`SELECT quantity>=$3::numeric AS enough FROM wms.portfolio_holdings
      WHERE holding_id=$1 AND account_id=$2 AND status='OPEN' FOR UPDATE`, [holdingId, accountId, quantity]);
    if (!holding?.enough) throw new HoldingUnavailable();
    await manager.query(`UPDATE wms.portfolio_holdings SET quantity=quantity-$2::numeric,
      status=(CASE WHEN quantity-$2::numeric=0 THEN 'CLOSED' ELSE 'OPEN' END)::wms.holding_status WHERE holding_id=$1`, [holdingId, quantity]);
  }

  /** Adds to the open holding of this product at a weighted average cost, or opens one. */
  async buy(manager: EntityManager, accountId: string, assetId: string, quantity: string, price: string): Promise<string> {
    const [existing] = await manager.query(`SELECT holding_id FROM wms.portfolio_holdings
      WHERE account_id=$1 AND asset_id=$2 AND status='OPEN' AND start_date IS NULL FOR UPDATE`, [accountId, assetId]);
    if (existing) {
      await manager.query(`UPDATE wms.portfolio_holdings SET avg_cost=round((quantity*avg_cost+$2::numeric*$3::numeric)/(quantity+$2::numeric),4),
        quantity=quantity+$2::numeric WHERE holding_id=$1`, [existing.holding_id, quantity, price]);
      return existing.holding_id;
    }
    const [row] = await manager.query('INSERT INTO wms.portfolio_holdings(account_id,asset_id,quantity,avg_cost) VALUES($1,$2,$3,$4) RETURNING holding_id',
      [accountId, assetId, quantity, price]);
    return row.holding_id;
  }

  /** A new deposit at today's rate; the rate stays locked for its whole term. */
  async openDeposit(manager: EntityManager, accountId: string, assetId: string, principal: string, today: string): Promise<{ holdingId: string; rate: string }> {
    const [terms] = await manager.query(`SELECT COALESCE((SELECT value FROM wms.v_asset_latest_price WHERE asset_id=$1 AND price_type='INTEREST_RATE'),t.interest_rate)::text AS rate,
        t.term_months FROM wms.term_deposit_products t WHERE t.asset_id=$1`, [assetId]);
    if (!terms) throw new HoldingUnavailable();
    const [row] = await manager.query(`INSERT INTO wms.portfolio_holdings(account_id,asset_id,principal,locked_rate,start_date,maturity_date)
      VALUES($1,$2,$3,$4,$5::date,($5::date+make_interval(months=>$6::int))::date) RETURNING holding_id`, [accountId, assetId, principal, terms.rate, today, terms.term_months]);
    return { holdingId: row.holding_id, rate: terms.rate };
  }

  /** Early or on time: principal plus the interest accrued so far at the locked rate, as UC-11 shows it; the whole deposit closes. */
  async settleDeposit(manager: EntityManager, accountId: string, holdingId: string, today: string): Promise<{ principal: string; interest: string }> {
    const [row] = await manager.query(`SELECT h.principal::text AS principal,
        floor(h.principal*COALESCE(h.locked_rate,0)*GREATEST(LEAST($3::date,COALESCE(h.maturity_date,$3::date))-COALESCE(h.start_date,$3::date),0)/36500)::numeric(20,2)::text AS interest
      FROM wms.portfolio_holdings h JOIN wms.assets a USING(asset_id)
      WHERE h.holding_id=$1 AND h.account_id=$2 AND h.status='OPEN' AND a.asset_class='TERM_DEPOSIT' FOR UPDATE OF h`, [holdingId, accountId, today]);
    if (!row) throw new HoldingUnavailable();
    await manager.query("UPDATE wms.portfolio_holdings SET status='CLOSED' WHERE holding_id=$1", [holdingId]);
    return row;
  }
}

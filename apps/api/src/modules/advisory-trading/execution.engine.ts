import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { formatCents, toCents } from '../accounts-ledger/cash.domain.js';
import { lockAccount } from '../accounts-ledger/cash-store.js';
import { LedgerService } from '../accounts-ledger/ledger.service.js';
import { HoldingsMutation, HoldingUnavailable } from '../portfolio-valuation/holdings-mutation.js';
import type { LegRow, ProposalRow } from './proposal-store.js';

/** Ends the whole execution: the caller rolls everything back and records the proposal as FAILED with this code. */
export class ExecutionFailure extends Error {
  constructor(readonly code: string, readonly sessionStarted: boolean) { super(code); }
}

const HOLDING_ACCOUNT: Record<string, string> = { BOND: 'BOND_HOLDING', MUTUAL_FUND: 'FUND_HOLDING' };
const MARKET_PRICE = "(CASE a.asset_class WHEN 'BOND' THEN 'BOND_PRICE' ELSE 'NAV' END)::wms.price_type";

export interface MarketQuote { legNo: number; expectedPrice: string; currentPrice: string | null; pricingId: string | null; slippagePct: string | null; exceeded: boolean }

/** BR-22 for every fund and bond leg, decided in SQL numeric. Deposits have no market price. */
export async function quotes(manager: EntityManager, proposalId: string, limit: string): Promise<MarketQuote[]> {
  const rows = await manager.query(`SELECT l.leg_no,l.expected_price::text AS expected,p.value::text AS current,p.pricing_id,
      round(abs(p.value-l.expected_price)/l.expected_price*100,4)::text AS slippage,(abs(p.value-l.expected_price)/l.expected_price*100>$2::numeric) AS exceeded
    FROM wms.proposal_legs l JOIN wms.assets a ON a.asset_id=l.asset_id LEFT JOIN wms.v_asset_latest_price p ON p.asset_id=a.asset_id AND p.price_type=${MARKET_PRICE}
    WHERE l.proposal_id=$1 AND a.asset_class<>'TERM_DEPOSIT' ORDER BY l.leg_no`, [proposalId, limit]);
  return rows.map((row: Record<string, any>) => ({ legNo: row.leg_no, expectedPrice: row.expected, currentPrice: row.current, pricingId: row.pricing_id,
    slippagePct: row.slippage, exceeded: row.current === null || row.exceeded === true }));
}

/**
 * UC-16 inside the approval transaction: sales and settlements first, then purchases and new deposits (BR-23). Any failure throws, so the caller's
 * transaction undoes every holding, entry and balance change together.
 */
@Injectable()
export class ExecutionEngine {
  constructor(private readonly ledger: LedgerService, private readonly holdings: HoldingsMutation) {}

  async execute(manager: EntityManager, proposal: ProposalRow, legs: LegRow[], marketQuotes: MarketQuote[], sessionId: string, today: string, now: Date): Promise<void> {
    const quoteOf = (legNo: number) => marketQuotes.find(quote => quote.legNo === legNo)!;
    const ordered = [...legs.filter(leg => leg.action_type === 'SELL' || leg.action_type === 'SETTLE'), ...legs.filter(leg => leg.action_type === 'BUY' || leg.action_type === 'OPEN')];
    let checkedBudget = false;
    for (const leg of ordered) {
      const buying = leg.action_type === 'BUY' || leg.action_type === 'OPEN';
      if (buying && !checkedBudget) {
        await this.assertFunds(manager, proposal.account_id, legs, quoteOf);
        checkedBudget = true;
      }
      try {
        await this.executeLeg(manager, proposal, leg, quoteOf, sessionId, today, now);
      } catch (error) {
        if (error instanceof HoldingUnavailable) throw new ExecutionFailure('HOLDING_UNAVAILABLE', true);
        throw error;
      }
    }
  }

  /** BR-20 at execution time: after the sales, cash must cover the purchases at today's prices. */
  private async assertFunds(manager: EntityManager, accountId: string, legs: LegRow[], quoteOf: (legNo: number) => MarketQuote): Promise<void> {
    const account = await lockAccount(manager, accountId);
    const available = toCents(account.balance) - toCents(account.held_amount);
    let needed = 0n;
    for (const leg of legs) {
      if (leg.action_type === 'OPEN') needed += toCents(leg.estimated_amount);
      if (leg.action_type === 'BUY') needed += toCents(await this.amount(manager, leg.order_quantity, quoteOf(leg.leg_no).currentPrice!));
    }
    if (needed > available) throw new ExecutionFailure('INSUFFICIENT_FUNDS_FOR_EXECUTION', true);
  }

  private async amount(manager: EntityManager, quantity: string, price: string): Promise<string> {
    const [row] = await manager.query('SELECT round($1::numeric*$2::numeric,2)::numeric(20,2)::text AS amount', [quantity, price]);
    return row.amount;
  }

  private async executeLeg(manager: EntityManager, proposal: ProposalRow, leg: LegRow, quoteOf: (legNo: number) => MarketQuote, sessionId: string, today: string, now: Date): Promise<void> {
    const accountId = proposal.account_id;
    const transactionId = randomUUID();
    const deposit = leg.asset_class === 'TERM_DEPOSIT';
    const quote = deposit ? null : quoteOf(leg.leg_no);
    const price = quote ? quote.currentPrice! : '1';
    let amount: string;
    let holdingId: string;
    let customerSide: 'DEBIT' | 'CREDIT';
    let counter: Array<{ code: string; amount: string }>;
    switch (leg.action_type) {
      case 'SELL':
        amount = await this.amount(manager, leg.order_quantity, price);
        await this.holdings.sell(manager, accountId, leg.source_holding_id!, leg.order_quantity);
        holdingId = leg.source_holding_id!;
        customerSide = 'CREDIT';
        counter = [{ code: HOLDING_ACCOUNT[leg.asset_class]!, amount }];
        break;
      case 'SETTLE': {
        const settled = await this.holdings.settleDeposit(manager, accountId, leg.source_holding_id!, today);
        amount = formatCents(toCents(settled.principal) + toCents(settled.interest));
        holdingId = leg.source_holding_id!;
        customerSide = 'CREDIT';
        // Interest of zero has no entry: every entry amount must be positive.
        counter = [{ code: 'TERM_DEPOSIT', amount: settled.principal }, ...(settled.interest === '0.00' ? [] : [{ code: 'INTEREST_PAYABLE', amount: settled.interest }])];
        break;
      }
      case 'BUY':
        amount = await this.amount(manager, leg.order_quantity, price);
        holdingId = await this.holdings.buy(manager, accountId, leg.asset_id, leg.order_quantity, price);
        customerSide = 'DEBIT';
        counter = [{ code: HOLDING_ACCOUNT[leg.asset_class]!, amount }];
        break;
      default:
        amount = leg.estimated_amount;
        holdingId = (await this.holdings.openDeposit(manager, accountId, leg.asset_id, amount, today)).holdingId;
        customerSide = 'DEBIT';
        counter = [{ code: 'TERM_DEPOSIT', amount }];
    }
    const number = `ITX-${(await manager.query('SELECT proposal_code FROM wms.proposals WHERE proposal_id=$1', [proposal.proposal_id]))[0].proposal_code.slice(5)}-${String(leg.leg_no).padStart(2, '0')}`;
    await manager.query(`INSERT INTO wms.investment_transactions(transaction_id,transaction_no,session_id,proposal_leg_id,account_id,asset_id,holding_id,action_type,quantity,
        executed_price,pricing_id,executed_amount,status,executed_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'EXECUTED',$13,$13)`,
    [transactionId, number, sessionId, leg.leg_id, accountId, leg.asset_id, holdingId, leg.action_type, leg.order_quantity, price, quote?.pricingId ?? null, amount, now]);
    await this.ledger.post(manager, { accountId, investmentTransactionId: transactionId, customerSide, amount, counter, description: `${leg.action_type} ${leg.asset_code}`, now });
    await manager.query(`UPDATE wms.proposal_legs SET actual_executed_price=$2::numeric,slippage_rate=round(abs($2::numeric-expected_price)/expected_price*100,4) WHERE leg_id=$1`, [leg.leg_id, price]);
  }
}

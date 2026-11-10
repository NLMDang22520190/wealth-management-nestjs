import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { AuditContext } from '../../platform/http.js';
import { appendAudit, appendSuccess } from '../../platform/transactions.js';
import type { AuditActor } from '../../platform/transactions.js';
import { ORDER } from './cash.domain.js';
import type { OrderType } from './cash.domain.js';
import type { OrderRow } from './cash-store.js';
import { LedgerService } from './ledger.service.js';

export const CLEARING = 'CORE_CLEARING';
const childTable = (order: OrderRow) => (order.txn_type === 'DEPOSIT' ? 'wms.deposit_transactions' : 'wms.withdrawal_transactions');

export interface Performed { actor: AuditActor; context: AuditContext; now: Date; }

/** Final and intermediate state changes of a deposit or withdrawal. Callers hold the account and transaction row locks. */
@Injectable()
export class CashSettlement {
  constructor(private readonly ledger: LedgerService) {}

  /** A deposit is posted only here, once Core confirmed the debit; a withdrawal was already posted before Core was called. */
  async succeed(manager: EntityManager, order: OrderRow, coreRef: string | null, by: Performed): Promise<void> {
    if (order.txn_type === 'DEPOSIT') {
      await this.ledger.post(manager, { accountId: order.account_id, cashTxnId: order.txn_id, customerSide: 'CREDIT', amount: order.amount,
        counter: [{ code: CLEARING, amount: order.amount }], description: `Nạp tiền ${order.ref_no}`, now: by.now });
    }
    if (coreRef) await manager.query(`UPDATE ${childTable(order)} SET core_ref=$2 WHERE txn_id=$1`, [order.txn_id, coreRef]);
    await this.finish(manager, order, 'SUCCESS', null, by);
  }

  /** Undoes what the order did so far: a posted withdrawal is reversed, an unposted one only releases its hold. */
  async fail(manager: EntityManager, order: OrderRow, reason: string, by: Performed): Promise<void> {
    if (order.txn_type === 'WITHDRAWAL') {
      const [posted] = await manager.query('SELECT 1 FROM wms.ledger_entries WHERE cash_txn_id=$1 LIMIT 1', [order.txn_id]);
      if (posted) await this.ledger.reverse(manager, order.account_id, order.txn_id, `Hoàn tiền rút ${order.ref_no}`, by.now);
      else await manager.query('UPDATE wms.investment_accounts SET held_amount=GREATEST(held_amount-$2::numeric,0),version=version+1 WHERE account_id=$1', [order.account_id, order.amount]);
    }
    await this.finish(manager, order, 'FAILED', reason, by);
  }

  async markPending(manager: EntityManager, order: OrderRow, coreRef: string | null, by: Performed): Promise<void> {
    if (coreRef) await manager.query(`UPDATE ${childTable(order)} SET core_ref=$2 WHERE txn_id=$1`, [order.txn_id, coreRef]);
    await manager.query("UPDATE wms.cash_transactions SET status='PENDING' WHERE txn_id=$1", [order.txn_id]);
    await appendAudit(manager, by.actor, { type: 'CASH_TXN', id: order.txn_id }, `${ORDER[order.txn_type as OrderType].action}_PENDING`,
      { txnId: order.txn_id }, by.now, { ...by.context, before: { status: order.status }, after: { status: 'PENDING' } });
  }

  private async finish(manager: EntityManager, order: OrderRow, status: 'SUCCESS' | 'FAILED', reason: string | null, by: Performed): Promise<void> {
    await manager.query('UPDATE wms.cash_transactions SET status=$2,failure_reason=$3,completed_at=$4 WHERE txn_id=$1', [order.txn_id, status, reason, by.now]);
    const verb = status === 'SUCCESS' ? 'SUCCEEDED' : 'FAILED';
    const payload = { txnId: order.txn_id, refNo: order.ref_no, txnType: order.txn_type, amount: order.amount, status, failureReason: reason };
    await appendSuccess(manager, by.actor, { type: 'CASH_TXN', id: order.txn_id }, `${ORDER[order.txn_type as OrderType].action}_${verb}`,
      'CashTransactionCompleted', payload, by.now, { ...by.context, before: { status: order.status }, after: { status, failureReason: reason } });
  }
}

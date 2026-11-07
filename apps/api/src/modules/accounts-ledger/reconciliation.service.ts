import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import type { ApplicationOptions } from '../../application.js';
import type { Actor } from '../../auth/actor.js';
import { ApiError } from '../../platform/http.js';
import type { AuditContext } from '../../platform/http.js';
import { RUNTIME_OPTIONS } from '../../platform/runtime.module.js';
import { appendAudit, idempotent } from '../../platform/transactions.js';
import { JOB_CONTEXT, MAX_RECONCILIATION_ROUNDS, notFound, RECONCILIATION_ACTOR } from './cash.domain.js';
import { CashSettlement } from './cash-settlement.service.js';
import type { Performed } from './cash-settlement.service.js';
import { loadOrder, lockAccount, orderView } from './cash-store.js';
import type { OrderRow } from './cash-store.js';
import { withCoreTimeout } from './core-ledger.js';
import type { CoreStatus } from './core-ledger.js';

/**
 * The Core timeout only stops waiting; the call itself may still be running. So an order is not asked about or swept until this long after its OTP
 * was consumed: "not posted" from Core would otherwise fail an order whose money is about to move.
 */
const CORE_SETTLE_GRACE_MS = 60_000;

export interface ReconciliationResult { expired: number; recovered: number; checked: number; succeeded: number; failed: number; unanswered: number; }

/** Process 2c. Core is asked outside any lock; every order is then settled in its own short transaction. */
@Injectable()
export class ReconciliationService {
  constructor(private readonly database: DataSource, private readonly settlement: CashSettlement,
    @Inject(RUNTIME_OPTIONS) private readonly options: ApplicationOptions) {}

  private job(): Performed { return { actor: RECONCILIATION_ACTOR, context: JOB_CONTEXT, now: this.options.clock.now() }; }

  /** Runs `work` under the account and order locks, only while the order is still in `status`. */
  private async whileStatus(txnId: string, accountId: string, status: string, work: (manager: EntityManager, order: OrderRow) => Promise<void>): Promise<boolean> {
    return this.database.transaction(async manager => {
      await lockAccount(manager, accountId);
      const order = (await loadOrder(manager, txnId, true))!;
      if (order.status !== status) return false;
      await work(manager, order);
      return true;
    });
  }

  /** `skipGrace` is for the demo trigger only: the mock Core answers at once, so nothing can still be in flight there. */
  async run({ skipGrace = false } = {}): Promise<ReconciliationResult> {
    const result: ReconciliationResult = { expired: 0, recovered: 0, checked: 0, succeeded: 0, failed: 0, unanswered: 0 };
    await this.sweep(result);
    const core = this.options.coreLedger;
    if (!core) return result;
    const settledBefore = skipGrace ? this.options.clock.now() : new Date(this.options.clock.now().getTime() - CORE_SETTLE_GRACE_MS);
    const pending: Array<{ txn_id: string }> = await this.database.query(`SELECT c.txn_id FROM wms.cash_transactions c
      LEFT JOIN wms.deposit_transactions d USING(txn_id) LEFT JOIN wms.withdrawal_transactions w USING(txn_id)
      LEFT JOIN wms.otp_challenges o ON o.challenge_id=COALESCE(d.otp_challenge_id,w.otp_challenge_id)
      WHERE c.status='PENDING' AND COALESCE(d.retry_count,w.retry_count)<$1 AND o.consumed_at<=$2 ORDER BY c.created_at`, [MAX_RECONCILIATION_ROUNDS, settledBefore]);
    for (const { txn_id: txnId } of pending) {
      const order = (await loadOrder(this.database.manager, txnId))!;
      result.checked += 1;
      let answer: CoreStatus | null = null;
      try {
        answer = await withCoreTimeout(core.status({ refNo: order.ref_no, casaNo: order.casa_no!, amount: order.amount }));
      } catch {
        this.options.logger.warn({ code: 'CORE_NO_ANSWER', txnId });
      }
      try {
        const settled = await this.whileStatus(txnId, order.account_id, 'PENDING', async (manager, current) => {
          if (answer?.outcome === 'POSTED') await this.settlement.succeed(manager, current, answer.coreRef, this.job());
          else if (answer?.outcome === 'NOT_POSTED') await this.settlement.fail(manager, current, 'CORE_NOT_POSTED', this.job());
          else await this.recordRound(manager, current);
        });
        if (settled) {
          if (answer?.outcome === 'POSTED') result.succeeded += 1;
          else if (answer?.outcome === 'NOT_POSTED') result.failed += 1;
          else result.unanswered += 1;
        }
      } catch {
        // One broken order must not stop the others; it stays PENDING for the next round.
        this.options.logger.error({ code: 'RECONCILIATION_FAILED', txnId });
      }
    }
    return result;
  }

  /** Orders left in INIT: an expired OTP ends them and frees their hold; a consumed OTP without an outcome goes to reconciliation. */
  private async sweep(result: ReconciliationResult): Promise<void> {
    const now = this.options.clock.now();
    const open: Array<{ txn_id: string; account_id: string; otp_status: string | null; expires_at: Date | null; consumed_at: Date | null }> = await this.database.query(
      `SELECT c.txn_id,c.account_id,o.status::text AS otp_status,o.expires_at,o.consumed_at FROM wms.cash_transactions c
       LEFT JOIN wms.deposit_transactions d USING(txn_id) LEFT JOIN wms.withdrawal_transactions w USING(txn_id)
       LEFT JOIN wms.otp_challenges o ON o.challenge_id=COALESCE(d.otp_challenge_id,w.otp_challenge_id)
       WHERE c.status='INIT' ORDER BY c.created_at`);
    for (const row of open) {
      try {
        if (!row.consumed_at && row.expires_at && row.expires_at.getTime() <= now.getTime()) {
          if (await this.whileStatus(row.txn_id, row.account_id, 'INIT', (manager, order) => this.settlement.fail(manager, order, 'OTP_EXPIRED', this.job()))) result.expired += 1;
        } else if (row.consumed_at && now.getTime() - row.consumed_at.getTime() >= CORE_SETTLE_GRACE_MS) {
          if (await this.whileStatus(row.txn_id, row.account_id, 'INIT', (manager, order) => this.settlement.markPending(manager, order, null, this.job()))) result.recovered += 1;
        }
      } catch {
        // Same rule as the PENDING loop: this order waits for the next round, the others go on.
        this.options.logger.error({ code: 'RECONCILIATION_FAILED', txnId: row.txn_id });
      }
    }
  }

  private async recordRound(manager: EntityManager, order: OrderRow): Promise<void> {
    const table = order.txn_type === 'DEPOSIT' ? 'wms.deposit_transactions' : 'wms.withdrawal_transactions';
    await manager.query(`UPDATE ${table} SET retry_count=retry_count+1 WHERE txn_id=$1`, [order.txn_id]);
    const rounds = (order.retry_count ?? 0) + 1;
    if (rounds >= MAX_RECONCILIATION_ROUNDS && order.txn_type === 'WITHDRAWAL') {
      await manager.query('UPDATE wms.withdrawal_transactions SET needs_manual_review=true WHERE txn_id=$1', [order.txn_id]);
    }
    const { actor, context, now } = this.job();
    await appendAudit(manager, actor, { type: 'CASH_TXN', id: order.txn_id }, 'RECONCILIATION_NO_ANSWER', { txnId: order.txn_id }, now,
      { ...context, before: { retryCount: order.retry_count }, after: { retryCount: rounds } });
  }

  /** The human decision after three unanswered rounds; the back-office clerk checked Core directly. */
  async resolve(actor: Actor, id: string, body: { outcome: 'SUCCESS' | 'FAILED'; note: string }, key: string | undefined, context: AuditContext) {
    const found = await loadOrder(this.database.manager, id);
    if (!found) throw notFound();
    return this.database.transaction(manager => idempotent(manager, actor.actorId, 'CASH_RESOLVE', id, key, body, this.options.clock.now(), async () => {
      const now = this.options.clock.now();
      await lockAccount(manager, found.account_id);
      const order = (await loadOrder(manager, id, true))!;
      if (order.status !== 'PENDING' || (order.retry_count ?? 0) < MAX_RECONCILIATION_ROUNDS) throw new ApiError(409, 'TXN_NOT_RESOLVABLE', 'The order is not waiting for back-office');
      const by = { actor, context, now };
      if (body.outcome === 'SUCCESS') await this.settlement.succeed(manager, order, null, by);
      else await this.settlement.fail(manager, order, 'BACK_OFFICE_RESOLVED', by);
      await appendAudit(manager, actor, { type: 'CASH_TXN', id }, 'CASH_TRANSACTION_RESOLVED', body, now,
        { ...context, before: { status: 'PENDING' }, after: { outcome: body.outcome, note: body.note } });
      return orderView((await loadOrder(manager, id))!, await lockAccount(manager, found.account_id));
    }));
  }
}

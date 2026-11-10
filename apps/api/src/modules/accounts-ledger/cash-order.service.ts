import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import type { ApplicationOptions } from '../../application.js';
import type { Actor } from '../../auth/actor.js';
import { ApiError } from '../../platform/http.js';
import type { AuditContext } from '../../platform/http.js';
import { OtpService } from '../../platform/otp.service.js';
import type { OtpDelivery } from '../../platform/otp.service.js';
import { RUNTIME_OPTIONS } from '../../platform/runtime.module.js';
import { apiErrorCode, appendAudit, hash, idempotencyReplay, idempotent, recordOutcome } from '../../platform/transactions.js';
import { eligibleAccounts } from '../customer-risk/onboarding.domain.js';
import { DAILY_LIMIT_CENTS, endOfVietnamDay, forbidden, formatCents, MIN_CASH_CENTS, notFound, ORDER, startOfVietnamDay, toCents, vietnamDate } from './cash.domain.js';
import type { OrderType } from './cash.domain.js';
import { CashSettlement, CLEARING } from './cash-settlement.service.js';
import type { Performed } from './cash-settlement.service.js';
import { accountOfCif, loadOrder, lockAccount, nextRefNo, orderView } from './cash-store.js';
import type { AccountRow, OrderRow } from './cash-store.js';
import { withCoreTimeout } from './core-ledger.js';
import type { CoreLedger, CorePosting } from './core-ledger.js';
import { LedgerService } from './ledger.service.js';

interface OrderInput { casaNo: string; amount: string; }
interface ConfirmInput { challengeId: string; code: string; }

const REQUEST_FAILURES = new Set(['AMOUNT_BELOW_MINIMUM', 'DAILY_LIMIT_EXCEEDED', 'INSUFFICIENT_AVAILABLE_BALANCE', 'ACCOUNT_NOT_ACTIVE', 'CASA_NOT_ELIGIBLE', 'SERVICE_INACTIVE']);
/** Confirm failures that end the order. A mismatched challenge does not: it says nothing about the order itself. */
const TERMINAL_CONFIRM_FAILURES = new Set(['OTP_INVALID', 'OTP_EXPIRED', 'ACCOUNT_NOT_ACTIVE', 'INSUFFICIENT_AVAILABLE_BALANCE']);
const coreUnavailable = () => new ApiError(503, 'CORE_UNAVAILABLE', 'Core banking is unavailable');
const payloadHash = (order: Pick<OrderRow, 'txn_id' | 'amount' | 'casa_no'>) => hash(JSON.stringify({ txnId: order.txn_id, amount: order.amount, casaNo: order.casa_no }));

/** UC-05 and UC-06: short transactions around an external Core call; no lock is held while Core or OTP delivery is awaited. */
@Injectable()
export class CashOrderService {
  constructor(private readonly database: DataSource, private readonly otp: OtpService, private readonly ledger: LedgerService,
    private readonly settlement: CashSettlement, @Inject(RUNTIME_OPTIONS) private readonly options: ApplicationOptions) {}

  private get core(): CoreLedger {
    if (!this.options.coreLedger) throw coreUnavailable();
    return this.options.coreLedger;
  }

  private async ownAccount(actor: Actor): Promise<AccountRow> {
    const account = await accountOfCif(this.database.manager, actor.cifId ?? '');
    if (!account) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', 'Investment account not found');
    return account;
  }

  private async casaAccounts(cifId: string) {
    if (!this.options.coreBanking) throw coreUnavailable();
    try {
      const customer = await withCoreTimeout(this.options.coreBanking.lookup(cifId));
      return customer ? eligibleAccounts(customer) : [];
    } catch { throw coreUnavailable(); }
  }

  private async usedToday(manager: EntityManager, accountId: string, type: OrderType, now: Date): Promise<bigint> {
    const day = vietnamDate(now);
    const [row] = await manager.query(`SELECT COALESCE(SUM(amount),0)::numeric(20,2)::text AS used FROM wms.cash_transactions
      WHERE account_id=$1 AND txn_type=$2 AND status<>'FAILED' AND created_at>=$3 AND created_at<$4`, [accountId, type, startOfVietnamDay(day), endOfVietnamDay(day)]);
    return toCents(row.used);
  }

  async accountView(actor: Actor) {
    const account = await this.ownAccount(actor);
    const core = this.core;
    let casaAccounts: Array<{ casaNo: string; balance: string }>;
    try {
      const accounts = await this.casaAccounts(account.cif_id);
      casaAccounts = await Promise.all(accounts.map(async item => ({ casaNo: item.id, balance: await withCoreTimeout(core.casaBalance(item.id)) })));
    } catch { throw coreUnavailable(); }
    const now = this.options.clock.now();
    const remaining = async (type: OrderType) => {
      const left = DAILY_LIMIT_CENTS - await this.usedToday(this.database.manager, account.account_id, type, now);
      return formatCents(left > 0n ? left : 0n);
    };
    return { accountNo: account.account_no, balance: account.balance, heldAmount: account.held_amount, availableBalance: account.available, status: account.status,
      remainingDepositLimit: await remaining('DEPOSIT'), remainingWithdrawalLimit: await remaining('WITHDRAWAL'), casaAccounts };
  }

  async create(type: OrderType, actor: Actor, input: OrderInput, key: string | undefined, context: AuditContext) {
    const config = ORDER[type];
    const account = await this.ownAccount(actor);
    const audited = { type: 'INVESTMENT_ACCOUNT', id: account.account_id };
    const failed = async (error: unknown) => {
      const code = apiErrorCode(error);
      if (code && REQUEST_FAILURES.has(code)) await recordOutcome(this.database, 'FAILURE', actor, audited, `${config.action}_REQUEST`, code, this.options.clock.now(), context);
    };
    const payload = { casaNo: input.casaNo, amount: input.amount };
    const replay = await idempotencyReplay<unknown>(this.database.manager, actor.actorId, config.action, account.customer_id, key, payload, this.options.clock.now());
    if (replay) return replay.response;
    const cents = toCents(input.amount);
    let delivery: OtpDelivery | undefined;
    try {
      if (cents < MIN_CASH_CENTS) throw new ApiError(422, 'AMOUNT_BELOW_MINIMUM', 'Amount is below the minimum');
      if (!this.options.coreLedger) throw coreUnavailable();
      // Core is an external boundary: looked up before any transaction opens.
      const accounts = await this.casaAccounts(account.cif_id);
      if (!accounts.some(item => item.id === input.casaNo)) throw new ApiError(422, 'CASA_NOT_ELIGIBLE', 'Payment account is not eligible');
      const response = await this.database.transaction(manager => idempotent(manager, actor.actorId, config.action, account.customer_id, key, payload,
        this.options.clock.now(), async () => {
          const now = this.options.clock.now();
          const locked = await lockAccount(manager, account.account_id);
          await this.requireOpen(manager, locked);
          const used = await this.usedToday(manager, locked.account_id, type, now);
          if (used + cents > DAILY_LIMIT_CENTS) {
            const left = DAILY_LIMIT_CENTS - used;
            throw new ApiError(422, 'DAILY_LIMIT_EXCEEDED', 'Daily limit exceeded', { remaining: formatCents(left > 0n ? left : 0n) });
          }
          if (type === 'WITHDRAWAL') {
            if (cents > toCents(locked.available)) throw new ApiError(422, 'INSUFFICIENT_AVAILABLE_BALANCE', 'Amount exceeds the available balance', { maxAmount: locked.available });
            await manager.query('UPDATE wms.investment_accounts SET held_amount=held_amount+$2::numeric,version=version+1 WHERE account_id=$1', [locked.account_id, formatCents(cents)]);
          }
          const order = await this.insertOrder(manager, type, locked.account_id, input.casaNo, formatCents(cents), key!, now);
          delivery = await this.otp.issue(manager, actor.actorId, config.otpPurpose, order.txnId, payloadHash({ txn_id: order.txnId, amount: order.amount, casa_no: input.casaNo }));
          await manager.query(`UPDATE ${type === 'DEPOSIT' ? 'wms.deposit_transactions' : 'wms.withdrawal_transactions'} SET otp_challenge_id=$2 WHERE txn_id=$1`, [order.txnId, delivery.challengeId]);
          await appendAudit(manager, actor, { type: 'CASH_TXN', id: order.txnId }, `${config.action}_REQUESTED`, payload, now,
            { ...context, before: null, after: { status: 'INIT', refNo: order.refNo, amount: order.amount } });
          return { ...order, casaNo: input.casaNo, status: 'INIT', challengeId: delivery.challengeId, expiresAt: delivery.expiresAt };
        }, 201));
      if (delivery) await this.otp.deliver(delivery);
      return response;
    } catch (error) {
      if ((error as { constraint?: string }).constraint === (type === 'DEPOSIT' ? 'ux_deposit_idem' : 'ux_withdrawal_idem')) {
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Key already binds a different request');
      }
      await failed(error);
      throw error;
    }
  }

  private async requireOpen(manager: EntityManager, account: AccountRow): Promise<void> {
    const [service] = await manager.query('SELECT status::text AS status FROM wms.wealth_services WHERE customer_id=$1', [account.customer_id]);
    if (service?.status !== 'ACTIVE') throw new ApiError(422, 'SERVICE_INACTIVE', 'The service is not active');
    if (account.status !== 'ACTIVE') throw new ApiError(422, 'ACCOUNT_NOT_ACTIVE', 'The investment account is not active');
  }

  private async insertOrder(manager: EntityManager, type: OrderType, accountId: string, casaNo: string, amount: string, key: string, now: Date) {
    const txnId = randomUUID();
    const refNo = await nextRefNo(manager, ORDER[type].prefix, vietnamDate(now));
    await manager.query(`INSERT INTO wms.cash_transactions(txn_id,ref_no,account_id,txn_type,amount,status,created_at) VALUES($1,$2,$3,$4,$5,'INIT',$6)`,
      [txnId, refNo, accountId, type, amount, now]);
    const [table, column] = type === 'DEPOSIT' ? ['wms.deposit_transactions', 'source_casa_no'] : ['wms.withdrawal_transactions', 'dest_casa_no'];
    // The team index on this column is global, so the stored value is scoped: another customer's key must not block this one.
    await manager.query(`INSERT INTO ${table}(txn_id,${column},idempotency_key) VALUES($1,$2,$3)`, [txnId, casaNo, hash(`${accountId}:${key}`)]);
    return { txnId, refNo, txnType: type, amount, createdAt: now.toISOString() };
  }

  async confirm(type: OrderType, actor: Actor, id: string, body: ConfirmInput, key: string | undefined, context: AuditContext) {
    const config = ORDER[type];
    const purpose = `${config.action}_CONFIRM`;
    const found = await loadOrder(this.database.manager, id);
    if (!found || found.txn_type !== type) throw notFound();
    if (found.cif_id !== actor.cifId) {
      await recordOutcome(this.database, 'DENIED', actor, { type: 'CASH_TXN', id }, purpose, 'FORBIDDEN', this.options.clock.now(), context);
      throw forbidden();
    }
    const payload = { challengeId: body.challengeId, code: body.code };
    const replay = await idempotencyReplay<unknown>(this.database.manager, actor.actorId, purpose, id, key, payload, this.options.clock.now());
    if (replay) return replay.response;
    const by = (): Performed => ({ actor, context, now: this.options.clock.now() });
    try {
      await this.database.transaction(async manager => {
        const now = this.options.clock.now();
        const account = await lockAccount(manager, found.account_id);
        const order = (await loadOrder(manager, id, true))!;
        if (order.status !== 'INIT' || order.otp_consumed_at) throw new ApiError(409, 'TXN_NOT_CONFIRMABLE', 'The order can no longer be confirmed');
        if (account.status !== 'ACTIVE') throw new ApiError(422, 'ACCOUNT_NOT_ACTIVE', 'The investment account is not active');
        // Normally guaranteed by the hold; rechecked under the row lock because the balance may have moved while the customer typed the OTP.
        if (type === 'WITHDRAWAL' && (toCents(account.balance) < toCents(order.amount) || toCents(account.held_amount) < toCents(order.amount))) {
          throw new ApiError(422, 'INSUFFICIENT_AVAILABLE_BALANCE', 'Amount exceeds the available balance', { maxAmount: account.available });
        }
        await this.otp.consume(manager, body.challengeId, body.code, actor.actorId, config.otpPurpose, id, payloadHash(order));
        if (type === 'WITHDRAWAL') {
          await this.ledger.post(manager, { accountId: order.account_id, cashTxnId: id, customerSide: 'DEBIT', amount: order.amount, consumeHold: true,
            counter: [{ code: CLEARING, amount: order.amount }], description: `Rút tiền ${order.ref_no}`, now });
        }
        await appendAudit(manager, actor, { type: 'CASH_TXN', id }, `${config.action}_AUTHORIZED`, { txnId: id }, now,
          { ...context, before: { otp: 'ISSUED' }, after: { otp: 'VERIFIED' } });
      });
    } catch (error) {
      const code = apiErrorCode(error);
      if (code && TERMINAL_CONFIRM_FAILURES.has(code)) {
        await recordOutcome(this.database, 'FAILURE', actor, { type: 'CASH_TXN', id }, purpose, code, this.options.clock.now(), context);
        if (code === 'OTP_INVALID') await this.otp.recordFailedAttempt(this.database, body.challengeId);
        await this.database.transaction(async manager => {
          await lockAccount(manager, found.account_id);
          const order = (await loadOrder(manager, id, true))!;
          if (order.status === 'INIT') await this.settlement.fail(manager, order, code, by());
        });
      }
      throw error;
    }
    // Outside every lock. No answer is not a failure: the money may have moved, so the order waits for reconciliation.
    let posting: CorePosting | null = null;
    try {
      const request = { refNo: found.ref_no, casaNo: found.casa_no!, amount: found.amount };
      posting = await withCoreTimeout(type === 'DEPOSIT' ? this.core.debit(request) : this.core.credit(request));
    } catch {
      this.options.logger.warn({ code: 'CORE_NO_ANSWER', txnId: id });
    }
    const coreRef = posting?.outcome === 'POSTED' ? posting.coreRef : null;
    try {
      return await this.database.transaction(manager => idempotent(manager, actor.actorId, purpose, id, key, payload, this.options.clock.now(), async () => {
        await lockAccount(manager, found.account_id);
        const order = (await loadOrder(manager, id, true))!;
        // A job may have taken over a slow order; then this request only reports the current state.
        if (order.status === 'INIT') {
          if (posting?.outcome === 'POSTED') await this.settlement.succeed(manager, order, coreRef, by());
          else if (posting?.outcome === 'REJECTED') await this.settlement.fail(manager, order, 'CORE_REJECTED', by());
          else await this.settlement.markPending(manager, order, null, by());
        }
        return orderView((await loadOrder(manager, id))!, await lockAccount(manager, found.account_id));
      }));
    } catch (error) {
      if (apiErrorCode(error) === 'IDEMPOTENCY_CONFLICT') throw error;
      // Core may already have moved the money, so a local failure must not read as "failed" (UC-05 E5).
      this.options.logger.error({ code: 'CASH_SETTLE_FAILED', txnId: id });
      return this.database.transaction(async manager => {
        await lockAccount(manager, found.account_id);
        const order = (await loadOrder(manager, id, true))!;
        if (order.status === 'INIT') await this.settlement.markPending(manager, order, coreRef, by());
        return orderView((await loadOrder(manager, id))!, await lockAccount(manager, found.account_id));
      });
    }
  }
}

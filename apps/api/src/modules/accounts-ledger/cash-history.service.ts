import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { ApplicationOptions } from '../../application.js';
import type { Actor } from '../../auth/actor.js';
import type { AuditContext } from '../../platform/http.js';
import { RUNTIME_OPTIONS } from '../../platform/runtime.module.js';
import { apiErrorCode, appendAudit, recordOutcome } from '../../platform/transactions.js';
import { CustomerAccess } from '../customer-risk/customer-access.service.js';
import { forbidden, MAX_RECONCILIATION_ROUNDS, notFound } from './cash.domain.js';
import type { HistoryQuery } from './cash.domain.js';
import { accountOfCif, loadOrder, ORDER_SELECT } from './cash-store.js';
import type { OrderRow } from './cash-store.js';

const VIEW = 'CASH_HISTORY_VIEW';
const DEFAULT_RANGE_MS = 30 * 86_400_000;

function item(order: OrderRow) {
  return { txnId: order.txn_id, refNo: order.ref_no, txnType: order.txn_type, amount: order.amount, status: order.status, failureReason: order.failure_reason,
    casaNo: order.casa_no, principalAmount: order.principal_amount, interestAmount: order.interest_amount,
    createdAt: order.created_at.toISOString(), completedAt: order.completed_at ? order.completed_at.toISOString() : null };
}
function backOfficeItem(order: OrderRow) {
  const retryCount = order.retry_count ?? 0;
  return { ...item(order), cifId: order.cif_id, customerId: order.customer_id, retryCount, needsReview: order.status === 'PENDING' && retryCount >= MAX_RECONCILIATION_ROUNDS };
}

/** UC-07: read only. Scope comes from the token or from P1's assignment check (I-04), never from the query. */
@Injectable()
export class CashHistoryService {
  constructor(private readonly database: DataSource, private readonly access: CustomerAccess,
    @Inject(RUNTIME_OPTIONS) private readonly options: ApplicationOptions) {}

  private async search(where: string[], params: unknown[], query: HistoryQuery) {
    const add = (condition: string, value: unknown) => { params.push(value); where.push(condition.replace('?', `$${params.length}`)); };
    if (query.type) add('c.txn_type=?', query.type);
    if (query.status) add('c.status=?', query.status);
    if (query.from) add('c.created_at>=?', query.from);
    if (query.to) add('c.created_at<?', query.to);
    const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    const [count] = await this.database.query(`SELECT count(*)::int AS total FROM (${ORDER_SELECT}${clause}) found`, params);
    const rows: OrderRow[] = await this.database.query(`${ORDER_SELECT}${clause} ORDER BY c.created_at DESC,c.txn_id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, query.pageSize, (query.page - 1) * query.pageSize]);
    return { rows, total: count.total as number, page: query.page, pageSize: query.pageSize };
  }

  /** The default window is the last 30 days (NFR-P2-12); `to` alone keeps that window out of the way. */
  private withDefaultRange(query: HistoryQuery): HistoryQuery {
    return query.from || query.to ? query : { ...query, from: new Date(this.options.clock.now().getTime() - DEFAULT_RANGE_MS) };
  }

  private async entries(txnId: string) {
    const rows: Array<{ entry_id: string; journal_id: string; account_type: string; side: string; amount: string; balance_after: string | null; reversal_of: string | null; created_at: Date; description: string | null }> = await this.database.query(
      `SELECT e.entry_id::text,e.journal_id,l.type::text AS account_type,e.side::text AS side,e.amount::text AS amount,e.balance_after::text AS balance_after,e.reversal_of::text AS reversal_of,e.created_at,e.description
       FROM wms.ledger_entries e JOIN wms.ledger_accounts l USING(ledger_account_id) WHERE e.cash_txn_id=$1 ORDER BY e.entry_id`, [txnId]);
    return rows.map(row => ({ entryId: row.entry_id, journalId: row.journal_id, accountType: row.account_type, side: row.side, amount: row.amount,
      balanceAfter: row.balance_after, reversalOf: row.reversal_of, description: row.description, createdAt: row.created_at.toISOString() }));
  }

  private async audited(actor: Actor, reference: { type: string; id: string }, payload: unknown, context: AuditContext): Promise<void> {
    const now = this.options.clock.now();
    await this.database.transaction(manager => appendAudit(manager, actor, reference, VIEW, payload, now, { ...context, before: null, after: null }));
  }

  private async denied(actor: Actor, reference: { type: string; id: string }, context: AuditContext): Promise<void> {
    await recordOutcome(this.database, 'DENIED', actor, reference, VIEW, 'FORBIDDEN', this.options.clock.now(), context);
  }

  async own(actor: Actor, query: HistoryQuery) {
    const account = await accountOfCif(this.database.manager, actor.cifId ?? '');
    if (!account) return { items: [], total: 0, page: query.page, pageSize: query.pageSize };
    const { rows, ...page } = await this.search(['c.account_id=$1'], [account.account_id], this.withDefaultRange(query));
    return { items: rows.map(item), ...page };
  }

  async ownDetail(actor: Actor, txnId: string, context: AuditContext) {
    const order = await loadOrder(this.database.manager, txnId);
    if (!order) throw notFound();
    if (order.cif_id !== actor.cifId) {
      await this.denied(actor, { type: 'CASH_TXN', id: txnId }, context);
      throw forbidden();
    }
    return { ...item(order), entries: await this.entries(txnId) };
  }

  private async staffScope(actor: Actor, customerId: string, context: AuditContext): Promise<void> {
    try {
      await this.access.staff(actor, customerId);
    } catch (error) {
      if (apiErrorCode(error) === 'FORBIDDEN') await this.denied(actor, { type: 'CUSTOMER', id: customerId }, context);
      throw error;
    }
  }

  async forCustomer(actor: Actor, customerId: string, query: HistoryQuery, context: AuditContext) {
    await this.staffScope(actor, customerId, context);
    await this.audited(actor, { type: 'CUSTOMER', id: customerId }, { customerId }, context);
    const { rows, ...page } = await this.search(['a.customer_id=$1'], [customerId], this.withDefaultRange(query));
    return { items: rows.map(item), ...page };
  }

  async customerDetail(actor: Actor, customerId: string, txnId: string, context: AuditContext) {
    await this.staffScope(actor, customerId, context);
    const order = await loadOrder(this.database.manager, txnId);
    if (!order || order.customer_id !== customerId) throw notFound();
    await this.audited(actor, { type: 'CASH_TXN', id: txnId }, { customerId, txnId }, context);
    return { ...item(order), entries: await this.entries(txnId) };
  }

  async backOffice(actor: Actor, query: HistoryQuery, context: AuditContext) {
    await this.audited(actor, { type: 'CASH_TXN_SEARCH', id: '' }, { type: query.type, status: query.status, cifId: query.cifId, needsReview: query.needsReview }, context);
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.cifId) { params.push(query.cifId); where.push(`a.cif_id=$${params.length}`); }
    if (query.needsReview) {
      params.push(MAX_RECONCILIATION_ROUNDS);
      where.push(`c.status='PENDING' AND COALESCE(d.retry_count,w.retry_count)>=$${params.length}`);
    }
    const { rows, ...page } = await this.search(where, params, query);
    return { items: rows.map(backOfficeItem), ...page };
  }

  async backOfficeDetail(actor: Actor, txnId: string, context: AuditContext) {
    const order = await loadOrder(this.database.manager, txnId);
    if (!order) throw notFound();
    await this.audited(actor, { type: 'CASH_TXN', id: txnId }, { txnId }, context);
    return { ...backOfficeItem(order), entries: await this.entries(txnId) };
  }

  /** Finished transactions are the customer's result feed; there is no separate notification row to keep in step. */
  async results(actor: Actor) {
    const account = await accountOfCif(this.database.manager, actor.cifId ?? '');
    if (!account) return { items: [] };
    const rows: OrderRow[] = await this.database.query(`${ORDER_SELECT} WHERE c.account_id=$1 AND c.status IN ('SUCCESS','FAILED')
      ORDER BY c.completed_at DESC,c.txn_id DESC LIMIT 20`, [account.account_id]);
    return { items: rows.map(item) };
  }
}

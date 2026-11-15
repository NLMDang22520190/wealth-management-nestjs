import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import type { ApplicationOptions } from '../../application.js';
import type { Actor } from '../../auth/actor.js';
import { ApiError } from '../../platform/http.js';
import type { AuditContext } from '../../platform/http.js';
import { RUNTIME_OPTIONS } from '../../platform/runtime.module.js';
import { apiErrorCode, appendAudit, appendSuccess, idempotent, recordOutcome } from '../../platform/transactions.js';
import { formatCents, toCents, vietnamDate } from '../accounts-ledger/cash.domain.js';
import { CustomerAccess } from '../customer-risk/customer-access.service.js';
import { forbidden, invalid, legError, notFound, PROPOSAL_TTL_MS, SALES } from './proposal.domain.js';
import type { CancelProposalBody, CreateProposalBody, LegInput, RejectProposalBody } from './proposal.domain.js';
import { assertPending, expireDue, loadLegs, loadProposal, nextCode, PROPOSAL_SELECT, proposalView, releaseAlert, scopeTeamTriggers, viewOf } from './proposal-store.js';
import type { ProposalRow } from './proposal-store.js';

interface PricedLeg { legNo: number; action: string; assetId: string; holdingId: string | null; quantity: string; price: string; amount: string }
const MARKET_PRICE = "(CASE a.asset_class WHEN 'BOND' THEN 'BOND_PRICE' ELSE 'NAV' END)::wms.price_type";
const VIEW = 'PROPOSAL_VIEW';

/** UC-13, UC-14, the customer's reject (UC-15) and every read. Scope comes from P1's assignment check or the token, never from the request. */
@Injectable()
export class ProposalService {
  constructor(private readonly database: DataSource, private readonly access: CustomerAccess, @Inject(RUNTIME_OPTIONS) private readonly options: ApplicationOptions) {}

  private now(): Date { return this.options.clock.now(); }

  private async denied(actor: Actor, reference: { type: string; id: string }, action: string, context: AuditContext, error: unknown): Promise<never> {
    if (apiErrorCode(error) === 'FORBIDDEN') await recordOutcome(this.database, 'DENIED', actor, reference, action, 'FORBIDDEN', this.now(), context);
    throw error;
  }

  /** Expiry runs in its own transaction first, so a refused action never rolls it back. */
  async expire(customerId?: string): Promise<void> {
    await this.database.transaction(manager => expireDue(manager, this.now(), customerId));
  }

  create(actor: Actor, customerId: string, body: CreateProposalBody, key: string | undefined, context: AuditContext) {
    const now = this.now();
    return this.access.withAccessTransaction(actor, customerId, manager => idempotent(manager, actor.actorId, 'PROPOSAL_CREATE', customerId, key, body, now, async () => {
      await expireDue(manager, now, customerId);
      const [profile] = await manager.query(`SELECT ws.status::text AS status,rp.risk_profile_id,rp.max_product_risk,rp.expires_at FROM wms.wealth_services ws
        LEFT JOIN wms.risk_profiles rp ON rp.risk_profile_id=ws.current_risk_profile_id WHERE ws.customer_id=$1`, [customerId]);
      if (profile?.status !== 'ACTIVE' || !profile.risk_profile_id || new Date(profile.expires_at).getTime() <= now.getTime()) {
        throw new ApiError(422, 'RISK_PROFILE_REQUIRED', 'A valid risk profile is required');
      }
      const [pending] = await manager.query("SELECT 1 FROM wms.proposals WHERE customer_id=$1 AND status='PENDING_APPROVAL'", [customerId]);
      if (pending) throw new ApiError(409, 'PROPOSAL_PENDING_EXISTS', 'The customer already has a proposal waiting for approval');
      const [account] = await manager.query('SELECT account_id,available_balance::text AS cash FROM wms.v_account_balance WHERE customer_id=$1', [customerId]);
      if (!account) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', 'No investment account');

      const legs: PricedLeg[] = [];
      for (const [index, leg] of body.legs.entries()) legs.push(await this.price(manager, index + 1, leg, account.account_id, profile.max_product_risk));
      const sum = (sales: boolean) => legs.filter(leg => SALES.includes(leg.action as never) === sales).reduce((total, leg) => total + toCents(leg.amount), 0n);
      const buy = sum(false);
      const sell = sum(true);
      const cash = toCents(account.cash);
      if (buy > cash + sell) throw legError(422, 'BUDGET_EXCEEDED', 'Purchases exceed cash plus expected sales', { shortfall: formatCents(buy - cash - sell) });

      if (body.driftAlertId) await this.takeAlert(manager, body.driftAlertId, customerId, now);
      const proposalId = randomUUID();
      const code = await nextCode(manager, 'proposals', 'proposal_code', 'PROP', vietnamDate(now), 3);
      await manager.query(`INSERT INTO wms.proposals(proposal_id,proposal_code,customer_id,rm_id,account_id,risk_profile_id,drift_alert_id,total_estimated_buy,total_estimated_sell,
          cash_at_creation,note,created_at,expired_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [proposalId, code, customerId, actor.rmId, account.account_id, profile.risk_profile_id, body.driftAlertId ?? null, formatCents(buy), formatCents(sell), account.cash,
        body.note?.trim() ?? null, now, new Date(now.getTime() + PROPOSAL_TTL_MS)]);
      for (const leg of legs) {
        await manager.query(`INSERT INTO wms.proposal_legs(proposal_id,leg_no,asset_id,source_holding_id,action_type,order_quantity,expected_price,estimated_amount)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [proposalId, leg.legNo, leg.assetId, leg.holdingId, leg.action, leg.quantity, leg.price, leg.amount]);
      }
      await appendSuccess(manager, actor, { type: 'PROPOSAL', id: proposalId }, 'PROPOSAL_CREATED', 'ProposalCreated',
        { proposalId, customerId, proposalCode: code, totalBuy: formatCents(buy), totalSell: formatCents(sell) }, now,
        { ...context, before: null, after: { status: 'PENDING_APPROVAL', legs: legs.length, driftAlertId: body.driftAlertId ?? null } });
      return viewOf(manager, proposalId);
    }, 201)).catch(error => this.denied(actor, { type: 'CUSTOMER', id: customerId }, 'PROPOSAL_CREATE', context, error));
  }

  /** Expected prices come from the server: the latest usable price (BR-22 compares against them), 1 for deposits whose quantity is the principal. */
  private async price(manager: EntityManager, legNo: number, leg: LegInput, accountId: string, maxRisk: number): Promise<PricedLeg> {
    const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) => legError(status, code, message, { legNo, ...extra });
    if (leg.action === 'BUY' || leg.action === 'OPEN') {
      const [asset] = await manager.query(`SELECT a.asset_id,a.asset_code,a.asset_class::text AS asset_class,a.risk_level,a.status::text AS status,a.min_investment::text AS min_investment,
          p.value::text AS price FROM wms.assets a LEFT JOIN wms.v_asset_latest_price p ON p.asset_id=a.asset_id AND p.price_type=${MARKET_PRICE} WHERE a.asset_id=$1`, [leg.assetId]);
      if (!asset) throw fail(422, 'ASSET_NOT_FOUND', 'Product not found');
      if ((leg.action === 'OPEN') !== (asset.asset_class === 'TERM_DEPOSIT')) throw invalid();
      if (asset.risk_level > maxRisk) throw fail(422, 'SUITABILITY_VIOLATION', `Product ${asset.asset_code} exceeds the customer's risk`, { assetCode: asset.asset_code, riskLevel: asset.risk_level, maxProductRisk: maxRisk });
      if (asset.status !== 'ON_SALE') throw fail(422, 'PRODUCT_NOT_ON_SALE', 'The product is not on sale', { assetCode: asset.asset_code });
      const price = leg.action === 'OPEN' ? '1' : asset.price;
      if (!price) throw fail(422, 'PRICE_UNAVAILABLE', 'The product has no usable price', { assetCode: asset.asset_code });
      const quantity = leg.action === 'OPEN' ? leg.amount! : leg.quantity!;
      const amount = await this.amount(manager, quantity, price);
      if (toCents(amount) < toCents(asset.min_investment)) throw fail(422, 'BELOW_MIN_INVESTMENT', 'Below the product minimum', { minInvestment: asset.min_investment });
      return { legNo, action: leg.action, assetId: asset.asset_id, holdingId: null, quantity, price, amount };
    }
    const [holding] = await manager.query(`SELECT h.holding_id,h.asset_id,a.asset_class::text AS asset_class,h.quantity::text AS held,h.principal::text AS principal,
        (h.quantity>=$3::numeric) AS enough,p.value::text AS price
      FROM wms.portfolio_holdings h JOIN wms.assets a ON a.asset_id=h.asset_id
      LEFT JOIN wms.v_asset_latest_price p ON p.asset_id=a.asset_id AND p.price_type=${MARKET_PRICE}
      WHERE h.holding_id=$1 AND h.account_id=$2 AND h.status='OPEN'`, [leg.holdingId, accountId, leg.quantity ?? '0']);
    const deposit = holding?.asset_class === 'TERM_DEPOSIT';
    if (!holding || deposit !== (leg.action === 'SETTLE')) throw fail(422, 'HOLDING_NOT_FOUND', 'No such holding of this customer');
    if (deposit) return { legNo, action: 'SETTLE', assetId: holding.asset_id, holdingId: holding.holding_id, quantity: holding.principal, price: '1', amount: holding.principal };
    if (!holding.enough) throw fail(422, 'QUANTITY_EXCEEDS_HOLDING', 'More than the customer holds', { held: holding.held });
    if (!holding.price) throw fail(422, 'PRICE_UNAVAILABLE', 'The product has no usable price');
    return { legNo, action: 'SELL', assetId: holding.asset_id, holdingId: holding.holding_id, quantity: leg.quantity!, price: holding.price,
      amount: await this.amount(manager, leg.quantity!, holding.price) };
  }

  /** Same rounding as the team's chk_leg_amount. */
  private async amount(manager: EntityManager, quantity: string, price: string): Promise<string> {
    const [row] = await manager.query('SELECT round($1::numeric*$2::numeric,2)::numeric(20,2)::text AS amount', [quantity, price]);
    return row.amount;
  }

  private async takeAlert(manager: EntityManager, alertId: string, customerId: string, now: Date): Promise<void> {
    const [alert] = await manager.query('SELECT status::text AS status FROM wms.drift_alerts WHERE alert_id=$1 AND customer_id=$2 FOR UPDATE', [alertId, customerId]);
    if (!alert) throw new ApiError(404, 'ALERT_NOT_FOUND', 'Alert not found');
    if (alert.status !== 'NEW' && alert.status !== 'READ') throw new ApiError(409, 'ALERT_NOT_OPEN', 'The alert is already handled');
    await manager.query("UPDATE wms.drift_alerts SET status='ACTIONED',actioned_at=$2 WHERE alert_id=$1", [alertId, now]);
  }

  // ---- Reads ----

  private async list(where: string, params: unknown[]) {
    const rows: ProposalRow[] = await this.database.query(`${PROPOSAL_SELECT} WHERE ${where} ORDER BY p.created_at DESC LIMIT 100`, params);
    return { items: await Promise.all(rows.map(async row => proposalView(row, await loadLegs(this.database.manager, row.proposal_id)))) };
  }

  private async staffScope(actor: Actor, customerId: string, context: AuditContext): Promise<void> {
    try {
      await this.access.staff(actor, customerId);
    } catch (error) {
      if (apiErrorCode(error) === 'FORBIDDEN') await recordOutcome(this.database, 'DENIED', actor, { type: 'CUSTOMER', id: customerId }, VIEW, 'FORBIDDEN', this.now(), context);
      throw error;
    }
    await this.database.transaction(manager => appendAudit(manager, actor, { type: 'CUSTOMER', id: customerId }, VIEW, { customerId }, this.now(), { ...context, before: null, after: null }));
  }

  async forCustomer(actor: Actor, customerId: string, context: AuditContext) {
    await this.staffScope(actor, customerId, context);
    await this.expire(customerId);
    return this.list('p.customer_id=$1', [customerId]);
  }

  async staffDetail(actor: Actor, proposalId: string, context: AuditContext) {
    const row = await loadProposal(this.database.manager, proposalId);
    if (!row) throw notFound();
    await this.staffScope(actor, row.customer_id, context);
    await this.expire(row.customer_id);
    return viewOf(this.database.manager, proposalId);
  }

  async forRm(actor: Actor, status: string | undefined) {
    await this.expire();
    const params: unknown[] = [actor.rmId];
    if (status) params.push(status);
    return this.list(`p.customer_id IN (SELECT customer_id FROM wms.rm_assignments WHERE rm_id=$1 AND valid_to IS NULL)${status ? ' AND p.status=$2' : ''}`, params);
  }

  /** The customer's own proposal; anyone else's is a denied access. */
  async own(actor: Actor, proposalId: string, context: AuditContext, action = VIEW): Promise<ProposalRow> {
    const customer = await this.access.own(actor);
    const row = await loadProposal(this.database.manager, proposalId);
    if (!row) throw notFound();
    if (row.customer_id !== customer.id) {
      await recordOutcome(this.database, 'DENIED', actor, { type: 'PROPOSAL', id: proposalId }, action, 'FORBIDDEN', this.now(), context);
      throw forbidden();
    }
    await this.expire(row.customer_id);
    return (await loadProposal(this.database.manager, proposalId))!;
  }

  async ownList(actor: Actor) {
    const customer = await this.access.own(actor);
    await this.expire(customer.id);
    return this.list('p.customer_id=$1', [customer.id]);
  }

  async ownDetail(actor: Actor, proposalId: string, context: AuditContext) {
    await this.own(actor, proposalId, context);
    return viewOf(this.database.manager, proposalId);
  }

  // ---- UC-14 and the customer's reject ----

  private close(manager: EntityManager, actor: Actor, proposalId: string, key: string | undefined, body: unknown, purpose: string, context: AuditContext,
    change: { status: 'CANCELLED' | 'REJECTED'; column: 'cancel_reason' | 'rejection_reason'; reason: string; action: string }) {
    const now = this.now();
    return idempotent(manager, actor.actorId, purpose, proposalId, key, body, now, async () => {
      await scopeTeamTriggers(manager);
      const row = (await loadProposal(manager, proposalId, true))!;
      assertPending(row, now);
      await manager.query(`UPDATE wms.proposals SET status=$2,${change.column}=$3,closed_at=$4 WHERE proposal_id=$1`, [proposalId, change.status, change.reason, now]);
      await releaseAlert(manager, row.drift_alert_id);
      await appendAudit(manager, actor, { type: 'PROPOSAL', id: proposalId }, change.action, body, now,
        { ...context, before: { status: 'PENDING_APPROVAL' }, after: { status: change.status, reason: change.reason } });
      return viewOf(manager, proposalId);
    });
  }

  async cancel(actor: Actor, proposalId: string, body: CancelProposalBody, key: string | undefined, context: AuditContext) {
    const row = await loadProposal(this.database.manager, proposalId);
    if (!row) throw notFound();
    await this.expire(row.customer_id);
    return this.access.withAccessTransaction(actor, row.customer_id, manager => this.close(manager, actor, proposalId, key, body, 'PROPOSAL_CANCEL', context,
      { status: 'CANCELLED', column: 'cancel_reason', reason: body.reason.trim(), action: 'PROPOSAL_CANCELLED' }))
      .catch(error => this.denied(actor, { type: 'PROPOSAL', id: proposalId }, 'PROPOSAL_CANCEL', context, error));
  }

  async reject(actor: Actor, proposalId: string, body: RejectProposalBody, key: string | undefined, context: AuditContext) {
    await this.own(actor, proposalId, context, 'PROPOSAL_REJECT');
    return this.database.transaction(manager => this.close(manager, actor, proposalId, key, body, 'PROPOSAL_REJECT', context,
      { status: 'REJECTED', column: 'rejection_reason', reason: body.reason.trim(), action: 'PROPOSAL_REJECTED' }));
  }
}

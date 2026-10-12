import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import type { ApplicationOptions } from '../../application.js';
import type { Actor } from '../../auth/actor.js';
import { ApiError } from '../../platform/http.js';
import { OtpService } from '../../platform/otp.service.js';
import { RUNTIME_OPTIONS } from '../../platform/runtime.module.js';
import { appendSuccess, idempotent, lockCustomer } from '../../platform/transactions.js';
import { AccountBootstrap } from '../accounts-ledger/account-bootstrap.js';
import { consentPayloadHash, eligibleAccounts, isEligible, ownRequest, requireUnexpired, requestProjection } from './onboarding.domain.js';
import type { CoreCustomer, ConsentBody, OnboardingRequest, OnboardingRequestBody } from './onboarding.domain.js';

@Injectable()
export class OnboardingService {
  constructor(private readonly database: DataSource, private readonly otp: OtpService,
    private readonly accounts: AccountBootstrap, @Inject(RUNTIME_OPTIONS) private readonly options: ApplicationOptions) {}

  private async core(reference: string): Promise<CoreCustomer> {
    if (!this.options.coreBanking) throw new ApiError(503, 'CORE_UNAVAILABLE', 'Core banking unavailable');
    let customer: CoreCustomer | null;
    try { customer = await this.options.coreBanking.lookup(reference); }
    catch { throw new ApiError(503, 'CORE_UNAVAILABLE', 'Core banking unavailable'); }
    if (!customer || customer.cifId !== reference) throw new ApiError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found');
    return customer;
  }

  async lookup(reference: string) {
    const customer = await this.core(reference);
    return { cifRef: customer.cifId, name: customer.name, eligible: isEligible(customer, this.options.clock.now()), accounts: eligibleAccounts(customer) };
  }

  private async eligible(reference: string, selectedAccount: string) {
    const customer = await this.core(reference);
    if (!isEligible(customer, this.options.clock.now())) throw new ApiError(422, 'CUSTOMER_INELIGIBLE', 'Customer is ineligible');
    if (!eligibleAccounts(customer).some(account => account.id === selectedAccount)) throw new ApiError(422, 'ACCOUNT_INELIGIBLE', 'Selected account is ineligible');
    return customer;
  }

  async create(actor: Actor, body: OnboardingRequestBody, key: string | undefined) {
    const now = this.options.clock.now();
    return this.database.transaction(manager => idempotent(manager, actor.actorId, 'ONBOARDING_REQUEST', body.cifRef,
      key, { cifRef: body.cifRef, selectedAccountId: body.selectedAccountId }, now, async () => {
        if (!actor.rmId || !actor.teamId) throw new ApiError(403, 'FORBIDDEN', 'Access denied');
        await lockCustomer(manager, body.cifRef, [actor.rmId]);
        const [registered] = await manager.query('SELECT id FROM customers WHERE cif_id=$1', [body.cifRef]);
        if (registered) throw new ApiError(409, 'SERVICE_EXISTS', 'Service already registered');
        // Normalize historical expired requests before the partial unique constraint is consulted.
        await manager.query(`UPDATE rm_capacity_reservations SET status='EXPIRED'
          WHERE status='ACTIVE' AND onboarding_request_id IN
          (SELECT id FROM onboarding_requests WHERE cif_id=$1 AND status='PENDING_CONSENT' AND expires_at <= $2)`, [body.cifRef, now]);
        await manager.query(`UPDATE onboarding_requests SET status='EXPIRED' WHERE cif_id=$1 AND status='PENDING_CONSENT' AND expires_at <= $2`, [body.cifRef, now]);
        const [pending] = await manager.query("SELECT id FROM onboarding_requests WHERE cif_id=$1 AND status='PENDING_CONSENT'", [body.cifRef]);
        if (pending) throw new ApiError(409, 'ONBOARDING_EXISTS', 'A registration request is pending');
        const customer = await this.eligible(body.cifRef, body.selectedAccountId);
        await this.requireCapacity(manager, actor.rmId, now);
        const [terms] = await manager.query('SELECT version,content_hash FROM service_terms ORDER BY version DESC LIMIT 1');
        const id = randomUUID();
        const expiresAt = new Date(now.getTime() + 72 * 3_600_000);
        const [request] = await manager.query(`INSERT INTO onboarding_requests
          (id,cif_id,customer_name,selected_account_id,rm_id,team_id,status,terms_version,terms_hash,created_at,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,'PENDING_CONSENT',$7,$8,$9,$10) RETURNING *`,
          [id, body.cifRef, customer.name, body.selectedAccountId, actor.rmId, actor.teamId, terms.version, terms.content_hash, now, expiresAt]);
        await manager.query(`INSERT INTO rm_capacity_reservations(id,onboarding_request_id,rm_id,status,expires_at)
          VALUES($1,$2,$3,'ACTIVE',$4)`, [randomUUID(), id, actor.rmId, expiresAt]);
        return requestProjection(request);
      }));
  }

  private async requireCapacity(manager: EntityManager, rmId: string, now: Date): Promise<void> {
    const [rm] = await manager.query("SELECT rm_id FROM mock_actors WHERE role='RM' AND rm_id=$1 AND active=true", [rmId]);
    if (!rm) throw new ApiError(422, 'RM_INACTIVE', 'Relationship manager is inactive');
    const [capacity] = await manager.query(`SELECT
      (SELECT count(*) FROM rm_assignment_history WHERE rm_id=$1 AND valid_to IS NULL) +
      (SELECT count(*) FROM rm_capacity_reservations WHERE rm_id=$1 AND status='ACTIVE' AND expires_at > $2) AS used`, [rmId, now]);
    if (Number(capacity.used) >= 80) throw new ApiError(409, 'RM_CAPACITY_EXCEEDED', 'Relationship manager capacity exceeded');
  }

  private async request(manager: EntityManager, id: string): Promise<OnboardingRequest | undefined> {
    const [row] = await manager.query('SELECT * FROM onboarding_requests WHERE id=$1', [id]);
    return row;
  }

  async detail(actor: Actor, id: string) {
    const request = await this.request(this.database.manager, id);
    ownRequest(request, actor);
    requireUnexpired(request, this.options.clock.now());
    const [terms] = await this.database.query('SELECT content FROM service_terms WHERE version=$1', [request.terms_version]);
    return { ...requestProjection(request), terms: terms.content };
  }

  async challenge(actor: Actor, purpose: string, operationId: string) {
    const request = await this.request(this.database.manager, operationId);
    ownRequest(request, actor);
    if (purpose !== 'SERVICE_CONSENT') throw new ApiError(400, 'OTP_PURPOSE_MISMATCH', 'OTP purpose does not match this operation');
    const delivery = await this.database.transaction(async manager => {
      await lockCustomer(manager, request.cif_id, [request.rm_id]);
      const current = await this.request(manager, operationId);
      ownRequest(current, actor);
      requireUnexpired(current, this.options.clock.now());
      if (current.status !== 'PENDING_CONSENT') throw new ApiError(409, 'SERVICE_EXISTS', 'Service already registered');
      return this.otp.issue(manager, actor.actorId, purpose, operationId, consentPayloadHash(current));
    });
    await this.otp.deliver(delivery);
    return { challengeId: delivery.challengeId, expiresAt: delivery.expiresAt };
  }

  async confirm(actor: Actor, id: string, body: ConsentBody, key: string | undefined) {
    const request = await this.request(this.database.manager, id);
    ownRequest(request, actor);
    const now = this.options.clock.now();
    return this.database.transaction(manager => idempotent(manager, actor.actorId, 'SERVICE_CONSENT', id, key,
      { challengeId: body.challengeId, code: body.code }, now, async () => {
        await lockCustomer(manager, request.cif_id, [request.rm_id]);
        const current = await this.request(manager, id);
        ownRequest(current, actor);
        requireUnexpired(current, now);
        const receipt = await this.otp.consume(manager, body.challengeId, body.code, actor.actorId, 'SERVICE_CONSENT', id, consentPayloadHash(current));
        const customer = await this.eligible(current.cif_id, current.selected_account_id);
        const [reservation] = await manager.query("SELECT id FROM rm_capacity_reservations WHERE onboarding_request_id=$1 AND status='ACTIVE' AND expires_at > $2 FOR UPDATE", [id, now]);
        if (!reservation) throw new ApiError(409, 'ONBOARDING_EXISTS', 'Registration reservation unavailable');
        const customerId = randomUUID();
        const serviceId = randomUUID();
        const consentId = randomUUID();
        await manager.query('INSERT INTO customers(id,cif_id,name,created_at) VALUES($1,$2,$3,$4)', [customerId, current.cif_id, customer.name, now]);
        const accountId = await this.accounts.create(manager, customerId, now);
        await manager.query(`INSERT INTO service_consents(id,request_id,customer_id,terms_version,terms_hash,otp_receipt_ref,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [consentId, id, customerId, current.terms_version, current.terms_hash, receipt, now]);
        await manager.query(`INSERT INTO wealth_services(id,customer_id,status,linked_payment_account_id,consent_id,created_at)
          VALUES($1,$2,'PENDING_RISK_ASSESSMENT',$3,$4,$5)`, [serviceId, customerId, current.selected_account_id, consentId, now]);
        await manager.query(`INSERT INTO rm_assignment_history(id,customer_id,rm_id,team_id,valid_from,provisional)
          VALUES($1,$2,$3,$4,$5,true)`, [randomUUID(), customerId, current.rm_id, current.team_id, now]);
        await manager.query("UPDATE rm_capacity_reservations SET status='CONSUMED' WHERE onboarding_request_id=$1", [id]);
        await manager.query("UPDATE onboarding_requests SET status='CONFIRMED' WHERE id=$1", [id]);
        const result = { requestId: id, customerId, serviceId, accountId, status: 'PENDING_RISK_ASSESSMENT' };
        await appendSuccess(manager, actor.actorId, customerId, 'SERVICE_REGISTERED', 'ServiceRegistered', result, now);
        return result;
      }));
  }
}

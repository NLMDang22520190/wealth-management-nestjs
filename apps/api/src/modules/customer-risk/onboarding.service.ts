import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import type { ApplicationOptions } from '../../application.js';
import type { Actor } from '../../auth/actor.js';
import { ApiError } from '../../platform/http.js';
import type { AuditContext } from '../../platform/http.js';
import { OtpService } from '../../platform/otp.service.js';
import { RUNTIME_OPTIONS } from '../../platform/runtime.module.js';
import { apiErrorCode, appendAudit, appendSuccess, idempotencyReplay, idempotent, lockCustomer, recordOutcome } from '../../platform/transactions.js';
import { CustomerAccess } from './customer-access.service.js';
import { AccountBootstrap } from '../accounts-ledger/account-bootstrap.js';
import { consentPayloadHash, eligibleAccounts, isEligible, ownRequest, requireUnexpired, requestProjection } from './onboarding.domain.js';
import type { CoreCustomer, ConsentBody, OnboardingRequest, OnboardingRequestBody } from './onboarding.domain.js';

@Injectable()
export class OnboardingService {
  constructor(private readonly database: DataSource, private readonly otp: OtpService,
    private readonly accounts: AccountBootstrap, private readonly access: CustomerAccess, @Inject(RUNTIME_OPTIONS) private readonly options: ApplicationOptions) {}

  private async core(reference: string): Promise<CoreCustomer> {
    if (!this.options.coreBanking) throw new ApiError(503, 'CORE_UNAVAILABLE', 'Core banking unavailable');
    let customer: CoreCustomer | null;
    try { customer = await this.options.coreBanking.lookup(reference); }
    catch { throw new ApiError(503, 'CORE_UNAVAILABLE', 'Core banking unavailable'); }
    if (!customer) throw new ApiError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found');
    return customer;
  }

  private readonly lookups = new Map<string, { window: number; count: number }>();

  /** Fixed one-minute window per trusted actor on the injected clock; demo default of 30 lookups, process-local. */
  private limitLookup(actor: Actor): void {
    const window = Math.floor(this.options.clock.now().getTime() / 60_000);
    const used = this.lookups.get(actor.actorId);
    const count = used?.window === window ? used.count + 1 : 1;
    if (count > (this.options.lookupRateLimitPerMinute ?? 30)) throw new ApiError(429, 'RATE_LIMITED', 'Too many lookups; retry later');
    this.lookups.set(actor.actorId, { window, count });
  }

  private readonly invites = new Map<string, { window: number; count: number }>();

  /** Fixed one-minute window per RM on the injected clock; default 10 invitations, process-local. */
  private limitInvite(actor: Actor): void {
    const window = Math.floor(this.options.clock.now().getTime() / 60_000);
    const used = this.invites.get(actor.actorId);
    const count = used?.window === window ? used.count + 1 : 1;
    if (count > (this.options.inviteRateLimitPerMinute ?? 10)) throw new ApiError(429, 'RATE_LIMITED', 'Too many invitations; retry later');
    this.invites.set(actor.actorId, { window, count });
  }

  async lookup(actor: Actor, reference: string) {
    this.limitLookup(actor);
    const customer = await this.core(reference);
    // A registered customer's PII is only visible to the current assignee; unregistered prospects stay open to any RM.
    const [registered] = await this.database.query('SELECT customer_id FROM wms.customers WHERE cif_id=$1', [customer.cifId]);
    if (registered) await this.access.authorize(actor, registered.customer_id, this.database.manager);
    return { cifRef: customer.cifId, name: customer.name, dateOfBirth: customer.dateOfBirth, active: customer.active,
      eligible: isEligible(customer, this.options.clock.now()), accounts: eligibleAccounts(customer) };
  }

  private requireEligible(customer: CoreCustomer, selectedAccount: string, now: Date): void {
    if (!isEligible(customer, now)) throw new ApiError(422, 'CUSTOMER_INELIGIBLE', 'Customer is ineligible');
    if (!eligibleAccounts(customer).some(account => account.id === selectedAccount)) throw new ApiError(422, 'ACCOUNT_INELIGIBLE', 'Selected account is ineligible');
  }

  async create(actor: Actor, body: OnboardingRequestBody, key: string | undefined, context: AuditContext) {
    if (!actor.rmId || !actor.teamId) throw new ApiError(403, 'FORBIDDEN', 'Access denied');
    const payload = { cifRef: body.cifRef, selectedAccountId: body.selectedAccountId };
    const replay = await idempotencyReplay(this.database.manager, actor.actorId, 'ONBOARDING_REQUEST', body.cifRef, key, payload, this.options.clock.now());
    if (replay) return replay.response;
    this.limitInvite(actor);
    // Core is an external boundary: no transaction or application lock is open while awaiting it.
    const customer = await this.core(body.cifRef);
    const now = this.options.clock.now();
    return this.database.transaction(manager => idempotent(manager, actor.actorId, 'ONBOARDING_REQUEST', body.cifRef,
      key, payload, now, async () => {
        await lockCustomer(manager, customer.cifId, [actor.rmId!]);
        const now = this.options.clock.now();
        this.requireEligible(customer, body.selectedAccountId, now);
        const [registered] = await manager.query('SELECT customer_id FROM wms.customers WHERE cif_id=$1', [customer.cifId]);
        if (registered) throw new ApiError(409, 'SERVICE_EXISTS', 'Service already registered');
        // Normalize historical expired requests before the partial unique constraint is consulted.
        await manager.query(`UPDATE wms.rm_capacity_reservations SET status='EXPIRED'
          WHERE status='ACTIVE' AND request_id IN
          (SELECT request_id FROM wms.onboarding_requests WHERE cif_id=$1 AND status='PENDING_CONSENT' AND expires_at <= $2)`, [customer.cifId, now]);
        await manager.query(`UPDATE wms.onboarding_requests SET status='EXPIRED' WHERE cif_id=$1 AND status='PENDING_CONSENT' AND expires_at <= $2`, [customer.cifId, now]);
        const [pending] = await manager.query("SELECT request_id FROM wms.onboarding_requests WHERE cif_id=$1 AND status='PENDING_CONSENT'", [customer.cifId]);
        if (pending) throw new ApiError(409, 'ONBOARDING_EXISTS', 'A registration request is pending');
        await this.requireCapacity(manager, actor.rmId!, now);
        // Latest terms already in force on the app clock (team seed: TERMS-2025.1).
        const [terms] = await manager.query(`SELECT terms_version,content_hash FROM wms.service_terms WHERE effective_from <= $1
          ORDER BY effective_from DESC,terms_version DESC LIMIT 1`, [now]);
        if (!terms) throw new ApiError(503, 'UNAVAILABLE', 'Service terms unavailable');
        const id = randomUUID();
        // Team chk_onb_ttl: expires_at is exactly created_at + 72 hours.
        const expiresAt = new Date(now.getTime() + 72 * 3_600_000);
        const [request] = await manager.query(`INSERT INTO wms.onboarding_requests
          (request_id,cif_id,customer_name,selected_casa_no,rm_id,team_id,status,terms_version,terms_hash,created_at,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,'PENDING_CONSENT',$7,$8,$9,$10) RETURNING *`,
          [id, customer.cifId, customer.name, body.selectedAccountId, actor.rmId, actor.teamId, terms.terms_version, terms.content_hash, now, expiresAt]);
        await manager.query(`INSERT INTO wms.rm_capacity_reservations(request_id,rm_id,status,created_at,expires_at)
          VALUES($1,$2,'ACTIVE',$3,$4)`, [id, actor.rmId, now, expiresAt]);
        const result = requestProjection(request);
        await appendAudit(manager, actor, { type: 'ONBOARDING_REQUEST', id }, 'ONBOARDING_REQUESTED', result, now,
          { ...context, before: null, after: result });
        return result;
      }, 201));
  }

  private async requireCapacity(manager: EntityManager, rmId: string, now: Date): Promise<void> {
    const [rm] = await manager.query("SELECT max_customers FROM wms.staff_users WHERE role='RM' AND staff_id=$1 AND is_active", [rmId]);
    if (!rm) throw new ApiError(422, 'RM_INACTIVE', 'Relationship manager is inactive');
    const [capacity] = await manager.query(`SELECT
      (SELECT count(*) FROM wms.rm_assignments WHERE rm_id=$1 AND valid_to IS NULL) +
      (SELECT count(*) FROM wms.rm_capacity_reservations WHERE rm_id=$1 AND status='ACTIVE' AND expires_at > $2) AS used`, [rmId, now]);
    if (Number(capacity.used) >= rm.max_customers) throw new ApiError(409, 'RM_CAPACITY_EXCEEDED', 'Relationship manager capacity exceeded');
  }

  private async request(manager: EntityManager, id: string): Promise<OnboardingRequest | undefined> {
    const [row] = await manager.query('SELECT * FROM wms.onboarding_requests WHERE request_id=$1', [id]);
    return row;
  }

  async detail(actor: Actor, id: string) {
    const request = await this.request(this.database.manager, id);
    ownRequest(request, actor);
    requireUnexpired(request, this.options.clock.now());
    const [terms] = await this.database.query('SELECT content FROM wms.service_terms WHERE terms_version=$1', [request.terms_version]);
    return { ...requestProjection(request), terms: terms.content };
  }

  async invitations(actor: Actor) {
    if (actor.role !== 'CUSTOMER' || !actor.cifId) throw new ApiError(403, 'FORBIDDEN', 'Access denied');
    const requests: OnboardingRequest[] = await this.database.query('SELECT * FROM wms.onboarding_requests WHERE cif_id=$1 ORDER BY created_at DESC,request_id', [actor.cifId]);
    const now = this.options.clock.now();
    return { items: requests.map(request => requestProjection({ ...request,
      status: request.status === 'PENDING_CONSENT' && new Date(request.expires_at).getTime() <= now.getTime() ? 'EXPIRED' : request.status })) };
  }

  async challenge(actor: Actor, purpose: string, operationId: string, context: AuditContext) {
    const request = await this.request(this.database.manager, operationId);
    ownRequest(request, actor);
    if (purpose !== 'SERVICE_CONSENT') throw new ApiError(400, 'OTP_PURPOSE_MISMATCH', 'OTP purpose does not match this operation');
    const delivery = await this.database.transaction(async manager => {
      await lockCustomer(manager, request.cif_id, [request.rm_id]);
      const current = await this.request(manager, operationId);
      ownRequest(current, actor);
      requireUnexpired(current, this.options.clock.now());
      if (current.status !== 'PENDING_CONSENT') throw new ApiError(409, 'SERVICE_EXISTS', 'Service already registered');
      const delivery = await this.otp.issue(manager, actor.actorId, purpose, operationId, consentPayloadHash(current));
      const result = { challengeId: delivery.challengeId, purpose, operationId };
      await appendAudit(manager, actor, { type: 'OTP_CHALLENGE', id: delivery.challengeId }, 'OTP_ISSUED', result, this.options.clock.now(),
        { ...context, before: null, after: result });
      return delivery;
    });
    await this.otp.deliver(delivery);
    return { challengeId: delivery.challengeId, expiresAt: delivery.expiresAt };
  }

  async confirm(actor: Actor, id: string, body: ConsentBody, key: string | undefined, context: AuditContext) {
    const request = await this.request(this.database.manager, id);
    ownRequest(request, actor);
    const payload = { challengeId: body.challengeId, code: body.code };
    const replay = await idempotencyReplay(this.database.manager, actor.actorId, 'SERVICE_CONSENT', id, key, payload, this.options.clock.now());
    if (replay) return replay.response;
    const customer = await this.core(request.cif_id);
    const now = this.options.clock.now();
    try {
      return await this.confirmTransaction(actor, id, body, key, context, request, customer, payload, now);
    } catch (error) {
      if (apiErrorCode(error) === 'OTP_INVALID') {
        await recordOutcome(this.database, 'FAILURE', actor, { type: 'ONBOARDING_REQUEST', id }, 'SERVICE_CONSENT_CONFIRM', 'OTP_INVALID', this.options.clock.now(), context);
        await this.otp.recordFailedAttempt(this.database, body.challengeId);
      }
      throw error;
    }
  }

  private confirmTransaction(actor: Actor, id: string, body: ConsentBody, key: string | undefined, context: AuditContext,
    request: OnboardingRequest, customer: CoreCustomer, payload: unknown, now: Date) {
    return this.database.transaction(manager => idempotent(manager, actor.actorId, 'SERVICE_CONSENT', id, key,
      payload, now, async () => {
        await lockCustomer(manager, request.cif_id, [request.rm_id]);
        const current = await this.request(manager, id);
        ownRequest(current, actor);
        const now = this.options.clock.now();
        requireUnexpired(current, now);
        if (customer.cifId !== current.cif_id) throw new ApiError(403, 'FORBIDDEN', 'Access denied');
        const receipt = await this.otp.consume(manager, body.challengeId, body.code, actor.actorId, 'SERVICE_CONSENT', id, consentPayloadHash(current));
        this.requireEligible(customer, current.selected_casa_no, now);
        const [reservation] = await manager.query("SELECT reservation_id FROM wms.rm_capacity_reservations WHERE request_id=$1 AND status='ACTIVE' AND expires_at > $2 FOR UPDATE", [id, now]);
        if (!reservation) throw new ApiError(409, 'ONBOARDING_EXISTS', 'Registration reservation unavailable');
        const customerId = randomUUID();
        const serviceId = randomUUID();
        const consentId = randomUUID();
        // Customers created by UC-01 carry the pre-onboarding subject 'cust.<lower cif>' as their IAM subject (D-R9-5).
        await manager.query(`INSERT INTO wms.customers(customer_id,cif_id,iam_subject,full_name,date_of_birth,created_at)
          VALUES($1,$2,$3,$4,$5,$6)`, [customerId, current.cif_id, `cust.${current.cif_id.toLowerCase()}`, customer.name, customer.dateOfBirth, now]);
        const accountId = await this.accounts.create(manager, customerId, current.cif_id, now);
        await manager.query(`INSERT INTO wms.service_consents(consent_id,request_id,customer_id,terms_version,terms_hash,otp_receipt_ref,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [consentId, id, customerId, current.terms_version, current.terms_hash, receipt, now]);
        await manager.query(`INSERT INTO wms.wealth_services(service_id,customer_id,status,linked_payment_account_no,consent_id,created_at)
          VALUES($1,$2,'PENDING_RISK_ASSESSMENT',$3,$4,$5)`, [serviceId, customerId, current.selected_casa_no, consentId, now]);
        await manager.query(`INSERT INTO wms.rm_assignments(customer_id,rm_id,team_id,version,valid_from,provisional)
          VALUES($1,$2,$3,1,$4,true)`, [customerId, current.rm_id, current.team_id, now]);
        await manager.query("UPDATE wms.rm_capacity_reservations SET status='CONSUMED' WHERE request_id=$1", [id]);
        await manager.query("UPDATE wms.onboarding_requests SET status='CONFIRMED',confirmed_at=$2 WHERE request_id=$1", [id, now]);
        const result = { requestId: id, customerId, serviceId, accountId, status: 'PENDING_RISK_ASSESSMENT' };
        await appendSuccess(manager, actor, { type: 'CUSTOMER', id: customerId }, 'SERVICE_REGISTERED', 'ServiceRegistered', result, now,
          { ...context, before: { requestId: id, status: 'PENDING_CONSENT' },
            after: { requestId: id, status: result.status, serviceId } });
        return result;
      }));
  }
}

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { actors } from '../helpers/actors.js';
import { eligibleCustomer, expectApiError, startApiFixture, TEST_NOW } from '../helpers/application.js';
import type { CoreCustomer } from '../helpers/application.js';

type Fixture = Awaited<ReturnType<typeof startApiFixture>>;
const HOUR = 3_600_000;
const TABLES = ['customers', 'onboarding_requests', 'rm_capacity_reservations', 'wealth_services',
  'investment_accounts', 'service_consents', 'rm_assignment_history', 'audit_events', 'outbox_events'] as const;

describe('S1 AC03/AC08 onboarding and consent', () => {
  let api: Fixture;
  beforeEach(async () => { api = await startApiFixture(); });
  afterEach(async () => { await api?.stop(); });

  async function lookup(cifRef = actors.customer.cifId as string) {
    const response = await api.request('/onboarding/customer-lookup', {
      method: 'POST', token: await api.tokenFor(), body: { cifRef },
    });
    expect(response.status).toBe(200);
    return response.body;
  }
  async function createRequest(key = 's1-request', cifRef = actors.customer.cifId as string) {
    const customer = await lookup(cifRef);
    expect(customer.eligible).toBe(true);
    const response = await api.request('/onboarding/requests', {
      method: 'POST', token: await api.tokenFor(), key,
      body: { cifRef: customer.cifRef, selectedAccountId: customer.accounts[0].id },
    });
    expect(response.status).toBe(201);
    expect(response.body).toEqual(expect.objectContaining({ id: expect.any(String), status: 'PENDING_CONSENT',
      termsVersion: expect.any(String), expiresAt: expect.any(String) }));
    return response.body;
  }
  async function challenge(requestId: string) {
    const response = await api.request('/otp/challenges', {
      method: 'POST', token: await api.tokenFor(actors.customer.actorId),
      body: { purpose: 'SERVICE_CONSENT', operationId: requestId },
    });
    expect(response.status).toBe(201);
    expect(response.body).toEqual(expect.objectContaining({ challengeId: expect.any(String), expiresAt: expect.any(String) }));
    expect(response.body.code).toBeUndefined();
    const delivery = api.deliveries.find(item => item.challengeId === response.body.challengeId);
    expect(delivery).toEqual(expect.objectContaining({ actorId: actors.customer.actorId, purpose: 'SERVICE_CONSENT', operationId: requestId }));
    expect(delivery!.code).toMatch(/^\d{6}$/);
    return delivery!;
  }
  async function confirm(requestId: string, otp: { challengeId: string; code: string }, key = 's1-confirm') {
    return api.request(`/me/onboarding-requests/${requestId}/confirm`, {
      method: 'POST', token: await api.tokenFor(actors.customer.actorId), key,
      body: { challengeId: otp.challengeId, code: otp.code },
    });
  }
  async function counts() {
    const result: Record<string, number> = {};
    for (const table of TABLES) {
      const [row] = await api.dataSource.query(`SELECT count(*)::integer AS count FROM ${table}`);
      result[table] = row.count;
    }
    return result;
  }
  async function expectNoService() {
    for (const table of ['wealth_services', 'investment_accounts', 'service_consents', 'rm_assignment_history']) {
      const [row] = await api.dataSource.query(`SELECT count(*)::integer AS count FROM ${table}`);
      expect(row.count, `${table} must remain empty before valid consent`).toBe(0);
    }
  }

  test('AC03 exactly 18, active KYC and own VND creates only a reservation until customer OTP atomically registers zero balance', async () => {
    const customer = await lookup();
    expect(customer).toEqual(expect.objectContaining({ cifRef: actors.customer.cifId, eligible: true }));
    expect(customer.accounts).toContainEqual(expect.objectContaining({ id: eligibleCustomer().accounts[0].id, currency: 'VND' }));
    const request = await createRequest();
    expect(request.expiresAt).toBe(new Date(new Date(TEST_NOW).getTime() + 72 * HOUR).toISOString());
    const [reservation] = await api.dataSource.query('SELECT * FROM rm_capacity_reservations WHERE onboarding_request_id=$1', [request.id]);
    expect(reservation).toMatchObject({ rm_id: actors.rm.rmId, status: 'ACTIVE' });
    await expectNoService();
    const detail = await api.request(`/me/onboarding-requests/${request.id}`, { token: await api.tokenFor(actors.customer.actorId) });
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ id: request.id, termsVersion: request.termsVersion, status: 'PENDING_CONSENT' });
    expect(detail.body.terms).toEqual(expect.any(String));
    expect(detail.body.terms.length).toBeGreaterThan(0);
    const rm = await api.tokenFor();
    const own = await api.tokenFor(actors.customer.actorId);
    expectApiError(await api.request('/onboarding/customer-lookup', { method: 'POST', token: own, body: { cifRef: actors.customer.cifId } }), 403, 'FORBIDDEN');
    expectApiError(await api.request('/onboarding/requests', { method: 'POST', token: own, key: 'forbidden', body: { cifRef: customer.cifRef, selectedAccountId: customer.accounts[0].id } }), 403, 'FORBIDDEN');
    expectApiError(await api.request(`/me/onboarding-requests/${request.id}/confirm`, { method: 'POST', token: rm, key: 'forbidden', body: { challengeId: request.id, code: '123456' } }), 403, 'FORBIDDEN');
    expectApiError(await api.request(`/me/onboarding-requests/${request.id}`, { token: await api.tokenFor(actors.otherCustomer.actorId) }), 403, 'FORBIDDEN');
    const otp = await challenge(request.id);
    await expectNoService();
    const accepted = await confirm(request.id, otp);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual(expect.objectContaining({ requestId: request.id, customerId: expect.any(String), serviceId: expect.any(String), accountId: expect.any(String), status: 'PENDING_RISK_ASSESSMENT' }));
    const [service] = await api.dataSource.query('SELECT * FROM wealth_services WHERE id=$1', [accepted.body.serviceId]);
    const [account] = await api.dataSource.query('SELECT * FROM investment_accounts WHERE id=$1', [accepted.body.accountId]);
    const [consent] = await api.dataSource.query('SELECT * FROM service_consents WHERE request_id=$1', [request.id]);
    const assignments = await api.dataSource.query('SELECT * FROM rm_assignment_history WHERE customer_id=$1 AND valid_to IS NULL', [accepted.body.customerId]);
    expect(service).toMatchObject({ customer_id: accepted.body.customerId, status: 'PENDING_RISK_ASSESSMENT', linked_payment_account_id: customer.accounts[0].id, current_risk_profile_id: null, consent_id: consent.id });
    expect(account).toMatchObject({ customer_id: accepted.body.customerId, balance: '0', currency: 'VND' });
    expect(consent).toMatchObject({ customer_id: accepted.body.customerId, terms_version: request.termsVersion, otp_receipt_ref: expect.any(String) });
    expect(consent.terms_hash).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({ rm_id: actors.rm.rmId, provisional: true });
    const [consumed] = await api.dataSource.query('SELECT status FROM rm_capacity_reservations WHERE onboarding_request_id=$1', [request.id]);
    expect(consumed.status).toBe('CONSUMED');
    expect((await api.dataSource.query("SELECT * FROM outbox_events WHERE event_type='ServiceRegistered'")).length).toBe(1);
    expect((await api.dataSource.query("SELECT * FROM audit_events WHERE action='SERVICE_REGISTERED' AND outcome='SUCCESS'")).length).toBe(1);
    const publicOutput = JSON.stringify([accepted.body, detail.body, ...api.logs]);
    expect(publicOutput).not.toContain(otp.code);
    expect(publicOutput).not.toContain(own);
  });

  describe('eligibility exclusions leave no partial state', () => {
    test.each([
      ['under18', { dateOfBirth: '2008-01-16' }, 'CUSTOMER_INELIGIBLE', 422],
      ['frozen CIF', { active: false }, 'CUSTOMER_INELIGIBLE', 422],
      ['missing KYC', { kycVerified: false }, 'CUSTOMER_INELIGIBLE', 422],
      ['no VND', { accounts: [{ id: 'usd-only', ownerCifId: actors.customer.cifId, currency: 'USD', active: true }] }, 'CUSTOMER_INELIGIBLE', 422],
      ['inactive VND', { accounts: [{ id: 'inactive', ownerCifId: actors.customer.cifId, currency: 'VND', active: false }] }, 'CUSTOMER_INELIGIBLE', 422],
      ['foreign VND', { accounts: [{ id: 'foreign', ownerCifId: actors.otherCustomer.cifId, currency: 'VND', active: true }] }, 'CUSTOMER_INELIGIBLE', 422],
      ['missing CIF', null, 'CUSTOMER_NOT_FOUND', 404],
      ['Core timeout', 'timeout', 'CORE_UNAVAILABLE', 503],
    ] as const)('AC03 %s refuses request and leaves service/account/consent/assignment absent', async (_label, override, code, status) => {
      if (override === 'timeout') api.state.coreFailure = true;
      else if (override === null) api.state.core = null;
      else {
        const altered = override as Partial<CoreCustomer>;
        api.state.core = { ...eligibleCustomer(), ...altered, accounts: altered.accounts ? [...altered.accounts] : eligibleCustomer().accounts };
      }
      const response = await api.request('/onboarding/requests', { method: 'POST', token: await api.tokenFor(), key: 'ineligible', body: { cifRef: actors.customer.cifId, selectedAccountId: api.state.core?.accounts[0]?.id ?? 'missing' } });
      expectApiError(response, status, code);
      await expectNoService();
      const current = await counts();
      expect(current.onboarding_requests).toBe(0);
      expect(current.rm_capacity_reservations).toBe(0);
      expect(current.outbox_events).toBe(0);
    });
    test('AC03 selecting an account outside the eligible own-VND list is refused', async () => {
      await lookup();
      expectApiError(await api.request('/onboarding/requests', { method: 'POST', token: await api.tokenFor(), key: 'foreign-selection', body: { cifRef: actors.customer.cifId, selectedAccountId: 'account-not-owned' } }), 422, 'ACCOUNT_INELIGIBLE');
      await expectNoService();
      expect((await counts()).onboarding_requests).toBe(0);
    });
  });

  test('AC03/AC08 concurrent same CIF, same-key replay and changed-body conflict never duplicate request or registration', async () => {
    const customer = await lookup();
    const body = { cifRef: customer.cifRef, selectedAccountId: customer.accounts[0].id };
    const rm = await api.tokenFor();
    const make = (key: string, value = body) => api.request('/onboarding/requests', { method: 'POST', token: rm, key, body: value });
    const parallel = await Promise.all([make('race-one'), make('race-two')]);
    expect(parallel.map(item => item.status).sort()).toEqual([201, 409]);
    const winner = parallel.find(item => item.status === 201)!;
    expect(parallel.find(item => item.status === 409)!.body.code).toBe('ONBOARDING_EXISTS');
    const winningKey = parallel[0].status === 201 ? 'race-one' : 'race-two';
    const replay = await make(winningKey);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(winner.body);
    expectApiError(await make(winningKey, { ...body, selectedAccountId: 'changed-account' }), 409, 'IDEMPOTENCY_CONFLICT');
    const before = await counts();
    expect(before.onboarding_requests).toBe(1);
    expect(before.rm_capacity_reservations).toBe(1);
    await expectNoService();
    const otp = await challenge(winner.body.id);
    // The RM request and customer consent may reuse a key: actor/purpose/resource scope differs.
    const results = await Promise.all([confirm(winner.body.id, otp, winningKey), confirm(winner.body.id, otp, winningKey)]);
    expect(results.map(item => item.status)).toEqual([200, 200]);
    expect(results[0].body).toEqual(results[1].body);
    expectApiError(await confirm(winner.body.id, { ...otp, code: otp.code === '000000' ? '000001' : '000000' }, winningKey), 409, 'IDEMPOTENCY_CONFLICT');
    expectApiError(await confirm(winner.body.id, otp, 'fresh-replay'), 409, 'OTP_ALREADY_USED');
    expectApiError(await make('registered-again'), 409, 'SERVICE_EXISTS');
    const after = await counts();
    for (const table of ['wealth_services', 'investment_accounts', 'service_consents', 'rm_assignment_history', 'outbox_events']) expect(after[table], table).toBe(1);
  });

  test('AC03/AC08 OTP is bound to customer, purpose and immutable request; wrong/expired/exact72h OTP cannot register', async () => {
    const request = await createRequest();
    const otherRequest = await createRequest('other-cif-request', actors.otherCustomer.cifId);
    const foreign = await api.tokenFor(actors.otherCustomer.actorId);
    expectApiError(await api.request('/otp/challenges', { method: 'POST', token: foreign, body: { purpose: 'SERVICE_CONSENT', operationId: request.id } }), 403, 'FORBIDDEN');
    expectApiError(await api.request('/otp/challenges', { method: 'POST', token: await api.tokenFor(actors.customer.actorId), body: { purpose: 'RISK_ASSESSMENT_CONFIRM', operationId: request.id } }), 400, 'OTP_PURPOSE_MISMATCH');
    const otp = await challenge(request.id);
    const inboxPath = `/me/otp-challenges/${otp.challengeId}/demo-code`;
    const inbox = await api.request(inboxPath, { token: await api.tokenFor(actors.customer.actorId) });
    expect(inbox.status).toBe(200);
    expect(inbox.body).toEqual({ challengeId: otp.challengeId, code: otp.code, expiresAt: otp.expiresAt });
    expectApiError(await api.request(inboxPath, { token: await api.tokenFor() }), 403, 'FORBIDDEN');
    expectApiError(await api.request(inboxPath, { token: foreign }), 403, 'FORBIDDEN');
    const [storedOtp] = await api.dataSource.query('SELECT * FROM otp_challenges WHERE id=$1', [otp.challengeId]);
    expect(storedOtp.code_hash).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(storedOtp.code).toBeUndefined();
    expect(storedOtp.raw_code).toBeUndefined();
    let production: Fixture | undefined;
    try {
      production = await startApiFixture({ environment: 'production', mockEnabled: false });
      expect((await production.request(inboxPath)).status).toBe(404);
    } finally { await production?.stop(); }
    expectApiError(await api.request(`/me/onboarding-requests/${request.id}/confirm`, { method: 'POST', token: foreign, key: 'foreign-confirm', body: { challengeId: otp.challengeId, code: otp.code } }), 403, 'FORBIDDEN');
    expectApiError(await api.request(`/me/onboarding-requests/${otherRequest.id}/confirm`, { method: 'POST', token: foreign, key: 'wrong-operation', body: { challengeId: otp.challengeId, code: otp.code } }), 409, 'OTP_BINDING_MISMATCH');
    expectApiError(await confirm(request.id, { ...otp, code: otp.code === '000000' ? '000001' : '000000' }, 'wrong-otp'), 400, 'OTP_INVALID');
    await expectNoService();
    api.state.now = new Date(otp.expiresAt);
    expectApiError(await confirm(request.id, otp, 'expired-otp'), 410, 'OTP_EXPIRED');
    await expectNoService();
    api.state.now = new Date(new Date(request.expiresAt).getTime() - 1000);
    const nearExpiry = await challenge(request.id);
    api.state.now = new Date(request.expiresAt);
    expectApiError(await confirm(request.id, nearExpiry, 'exact-72'), 410, 'ONBOARDING_EXPIRED');
    await expectNoService();
    const replacement = await createRequest('replacement');
    expect(replacement.id).not.toBe(request.id);
    api.state.now = new Date(new Date(replacement.expiresAt).getTime() - 1000);
    const fresh = await challenge(replacement.id);
    expectApiError(await api.request(`/me/onboarding-requests/${replacement.id}/confirm`, { method: 'POST', token: await api.tokenFor(actors.customer.actorId), key: 'tampered-terms', body: { challengeId: fresh.challengeId, code: fresh.code, termsVersion: 'client-forged-version' } }), 400, 'VALIDATION_ERROR');
    await expectNoService();
    api.state.core!.kycVerified = false;
    expectApiError(await confirm(replacement.id, fresh, 'core-recheck'), 422, 'CUSTOMER_INELIGIBLE');
    await expectNoService();
    api.state.core!.kycVerified = true;
    expect((await confirm(replacement.id, fresh, 'valid-after-recheck')).status).toBe(200);
  });

  describe('local transaction rollback', () => {
    test.each(['investment_accounts', 'service_consents', 'rm_assignment_history', 'audit_events', 'outbox_events'] as const)('AC08 a real %s constraint failure rolls back every local consent write and permits safe retry', async table => {
      const request = await createRequest();
      const otp = await challenge(request.id);
      const before = await counts();
      // A genuine PostgreSQL constraint at the persisted boundary, not a private-method mock.
      await api.dataSource.query(`ALTER TABLE ${table} ADD CONSTRAINT s1_injected_failure CHECK (false) NOT VALID`);
      const response = await confirm(request.id, otp, 'rollback-confirm');
      expectApiError(response, 500, 'INTERNAL_ERROR');
      await expectNoService();
      const after = await counts();
      for (const name of TABLES.filter(name => name !== 'audit_events')) expect(after[name], `${name} rollback`).toBe(before[name]);
      expect((await api.dataSource.query("SELECT * FROM audit_events WHERE action='SERVICE_REGISTERED' AND outcome='SUCCESS'")).length).toBe(0);
      const [persisted] = await api.dataSource.query('SELECT status FROM onboarding_requests WHERE id=$1', [request.id]);
      const [reservation] = await api.dataSource.query('SELECT status FROM rm_capacity_reservations WHERE onboarding_request_id=$1', [request.id]);
      expect(persisted.status).toBe('PENDING_CONSENT');
      expect(reservation.status).toBe('ACTIVE');
      await api.dataSource.query(`ALTER TABLE ${table} DROP CONSTRAINT s1_injected_failure`);
      expect((await confirm(request.id, otp, 'rollback-confirm')).status).toBe(200);
      const completed = await counts();
      for (const name of ['wealth_services', 'investment_accounts', 'service_consents', 'rm_assignment_history', 'outbox_events']) expect(completed[name], `${name} safe retry`).toBe(1);
    });
  });
});

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { actors } from '../helpers/actors.js';
import { eligibleCustomer, expectApiError, startApiFixture, TEST_NOW } from '../helpers/application.js';

type Fixture = Awaited<ReturnType<typeof startApiFixture>>;
const HOUR = 3_600_000;
const DEVICE = 'WMS synthetic customer device';

function barrier() {
  let signalEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { signalEntered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  return { entered, release, async wait() { signalEntered(); await released; } };
}

describe('S1a AC03/AC08 complete onboarding contract', () => {
  let api: Fixture;
  beforeEach(async () => { api = await startApiFixture(); });
  afterEach(async () => { await api?.stop(); });

  async function create(key = 's1a-request', cifRef: string = actors.customer.cifId, requestId?: string) {
    return api.request('/onboarding/requests', { method: 'POST', token: await api.tokenFor(), key,
      headers: { 'user-agent': DEVICE, ...(requestId ? { 'x-request-id': requestId } : {}) },
      body: { cifRef, selectedAccountId: eligibleCustomer(cifRef).accounts[0].id } });
  }
  async function pending(key = 's1a-request', cifRef: string = actors.customer.cifId) {
    const response = await create(key, cifRef);
    expect(response.status).toBe(201);
    return response.body;
  }
  async function issue(id: string, requestId?: string) {
    return api.request('/otp/challenges', { method: 'POST', token: await api.tokenFor(actors.customer.actorId),
      headers: { 'user-agent': DEVICE, ...(requestId ? { 'x-request-id': requestId } : {}) },
      body: { purpose: 'SERVICE_CONSENT', operationId: id } });
  }
  async function otp(id: string) {
    const response = await issue(id);
    expect(response.status).toBe(201);
    const delivery = api.deliveries.find(item => item.challengeId === response.body.challengeId);
    expect(delivery).toBeDefined();
    return delivery!;
  }
  async function confirm(id: string, delivery: { challengeId: string; code: string }, requestId?: string) {
    return api.request(`/me/onboarding-requests/${id}/confirm`, {
      method: 'POST', token: await api.tokenFor(actors.customer.actorId), key: 's1a-confirm',
      headers: { 'user-agent': DEVICE, ...(requestId ? { 'x-request-id': requestId } : {}) },
      body: { challengeId: delivery.challengeId, code: delivery.code },
    });
  }
  async function count(table: string) {
    const [row] = await api.dataSource.query(`SELECT count(*)::integer AS count FROM ${table}`);
    return row.count as number;
  }
  async function noRegistration() {
    for (const table of ['wealth_services', 'investment_accounts', 'service_consents', 'rm_assignment_history']) {
      expect(await count(table), `${table} must remain empty`).toBe(0);
    }
  }

  describe('external waits release local database locks', () => {
    test.each(['create', 'confirm', 'OTP delivery'] as const)('AC08 %s waits on its external boundary without any local transaction or advisory lock', async operation => {
      const gate = barrier();
      let id: string | undefined;
      let delivery: Awaited<ReturnType<typeof otp>> | undefined;
      if (operation !== 'create') id = (await pending()).id;
      if (operation === 'confirm') delivery = await otp(id!);
      if (operation === 'OTP delivery') api.state.otpDelivery = async () => { await gate.wait(); };
      else api.state.coreLookup = async () => { await gate.wait(); return eligibleCustomer(); };
      const response = operation === 'create' ? create() : operation === 'confirm' ? confirm(id!, delivery!) : issue(id!);
      try {
        await gate.entered;
        const [locks] = await api.dataSource.query(`
          SELECT count(*)::integer AS count FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
          WHERE a.datname=current_database() AND l.locktype='advisory' AND l.granted`);
        expect(locks.count, 'external waiting must hold zero granted application advisory locks').toBe(0);
        const [transactions] = await api.dataSource.query(`
          SELECT count(*)::integer AS count FROM pg_stat_activity
          WHERE datname=current_database() AND pid<>pg_backend_pid() AND xact_start IS NOT NULL`);
        expect(transactions.count, 'external waiting must hold zero open application transactions').toBe(0);
      } finally {
        gate.release();
        // Drain the real HTTP request before fixture teardown even when a lock assertion fails.
        await response;
      }
      expect((await response).status).toBe(operation === 'confirm' ? 200 : 201);
    });
  });

  test('AC03 consent that reaches exact72h during Core lookup is refused using fresh return time', async () => {
    const request = await pending();
    api.state.now = new Date(new Date(request.expiresAt).getTime() - 1_000);
    const delivery = await otp(request.id);
    const gate = barrier();
    api.state.coreLookup = async () => { await gate.wait(); return eligibleCustomer(); };
    const response = confirm(request.id, delivery);
    try {
      await gate.entered;
      api.state.now = new Date(request.expiresAt);
    } finally { gate.release(); }
    expectApiError(await response, 410, 'ONBOARDING_EXPIRED');
    await noRegistration();
    expect((await api.dataSource.query("SELECT * FROM audit_events WHERE action='SERVICE_REGISTERED' AND outcome='SUCCESS'")).length).toBe(0);
    expect((await api.dataSource.query("SELECT * FROM outbox_events WHERE event_type='ServiceRegistered'")).length).toBe(0);
  });

  test('AC03 identity reference resolves to canonical CIF with DOB and active status and registers the canonical customer', async () => {
    const identityRef = 'synthetic-identity-reference-101';
    const references: string[] = [];
    api.state.coreLookup = async reference => { references.push(reference); return eligibleCustomer(); };
    const lookup = await api.request('/onboarding/customer-lookup', {
      method: 'POST', token: await api.tokenFor(), body: { cifRef: identityRef },
    });
    expect(lookup.status).toBe(200);
    expect(references).toContain(identityRef);
    expect(lookup.body).toMatchObject({ cifRef: actors.customer.cifId, name: eligibleCustomer().name,
      dateOfBirth: '2008-01-15', active: true, eligible: true });
    const created = await api.request('/onboarding/requests', { method: 'POST', token: await api.tokenFor(), key: 'identity-request',
      body: { cifRef: identityRef, selectedAccountId: lookup.body.accounts[0].id } });
    expect(created.status).toBe(201);
    const detail = await api.request(`/me/onboarding-requests/${created.body.id}`, { token: await api.tokenFor(actors.customer.actorId) });
    expect(detail.status).toBe(200);
    const registered = await confirm(created.body.id, await otp(created.body.id));
    expect(registered.status).toBe(200);
    const [customer] = await api.dataSource.query('SELECT * FROM customers WHERE id=$1', [registered.body.customerId]);
    expect(customer.cif_id).toBe(actors.customer.cifId);
    expect(JSON.stringify([detail.body, registered.body])).not.toContain(identityRef);
  });

  describe('safe audit records share the business commit', () => {
    test('AC08 request, OTP issue and consent persist actor/time/correlation/device and filtered before-after without authentication secrets', async () => {
      const created = await create('audited-request', actors.customer.cifId, 's1a-audit-request');
      expect(created.status).toBe(201);
      const issued = await issue(created.body.id, 's1a-audit-otp');
      expect(issued.status).toBe(201);
      const delivery = api.deliveries.find(item => item.challengeId === issued.body.challengeId)!;
      const customerToken = await api.tokenFor(actors.customer.actorId);
      const accepted = await api.request(`/me/onboarding-requests/${created.body.id}/confirm`, {
        method: 'POST', token: customerToken, key: 'audited-consent', headers: { 'user-agent': DEVICE, 'x-request-id': 's1a-audit-consent' },
        body: { challengeId: delivery.challengeId, code: delivery.code },
      });
      expect(accepted.status).toBe(200);
      const expected = [
        { action: 'ONBOARDING_REQUESTED', actor: actors.rm.actorId, requestId: 's1a-audit-request', before: null,
          after: { id: created.body.id, status: 'PENDING_CONSENT', termsVersion: created.body.termsVersion } },
        { action: 'OTP_ISSUED', actor: actors.customer.actorId, requestId: 's1a-audit-otp', before: null,
          after: { challengeId: issued.body.challengeId, purpose: 'SERVICE_CONSENT', operationId: created.body.id } },
        { action: 'SERVICE_REGISTERED', actor: actors.customer.actorId, requestId: 's1a-audit-consent',
          before: { requestId: created.body.id, status: 'PENDING_CONSENT' },
          after: { requestId: created.body.id, status: 'PENDING_RISK_ASSESSMENT', serviceId: accepted.body.serviceId } },
      ];
      for (const event of expected) {
        const rows = await api.dataSource.query('SELECT * FROM audit_events WHERE action=$1 AND outcome=$2', [event.action, 'SUCCESS']);
        expect(rows, `${event.action} must be audited exactly once`).toHaveLength(1);
        const row = rows[0];
        expect(row.actor_id).toBe(event.actor);
        expect(new Date(row.created_at).toISOString()).toBe(TEST_NOW);
        expect(row.metadata).toMatchObject({ requestId: event.requestId, ip: '127.0.0.1', device: DEVICE });
        expect(row.metadata.before).toEqual(event.before === null ? null : expect.objectContaining(event.before));
        expect(row.metadata.after).toEqual(expect.objectContaining(event.after));
        const serialized = JSON.stringify(row);
        for (const forbidden of [delivery.code, customerToken, eligibleCustomer().name, eligibleCustomer().dateOfBirth]) {
          expect(serialized, `${event.action} must filter sensitive boundary data`).not.toContain(forbidden);
        }
        expect(serialized).not.toMatch(/"(?:code|raw_code|code_hash|token|accessToken|authorization|accounts)"\s*:/);
      }
      expect(JSON.stringify(api.logs)).not.toContain(delivery.code);
      expect(JSON.stringify(api.logs)).not.toContain(customerToken);
    });

    test.each(['request', 'OTP'] as const)('AC08 %s audit failure rolls back its business writes and permits the same operation to retry', async operation => {
      const request = operation === 'OTP' ? await pending() : undefined;
      const tables = operation === 'request' ? ['onboarding_requests', 'rm_capacity_reservations'] : ['otp_challenges'];
      const before = await Promise.all(tables.map(table => count(table)));
      const deliveriesBefore = api.deliveries.length;
      await api.dataSource.query('ALTER TABLE audit_events ADD CONSTRAINT s1a_audit_failure CHECK (false) NOT VALID');
      try {
        const response = operation === 'request' ? await create('audit-rollback') : await issue(request!.id);
        expectApiError(response, 500, 'INTERNAL_ERROR');
        for (let index = 0; index < tables.length; index++) expect(await count(tables[index]), `${tables[index]} atomic rollback`).toBe(before[index]);
        expect(api.deliveries.length).toBe(deliveriesBefore);
        await noRegistration();
      } finally { await api.dataSource.query('ALTER TABLE audit_events DROP CONSTRAINT s1a_audit_failure'); }
      const retried = operation === 'request' ? await create('audit-rollback') : await issue(request!.id);
      expect(retried.status).toBe(201);
      for (let index = 0; index < tables.length; index++) expect(await count(tables[index]), `${tables[index]} retry writes once`).toBe(before[index] + 1);
    });
  });

  test('AC03 customer invitation list discovers only own CIF and projects effective expired status at exact72h', async () => {
    const own = await pending();
    const other = await pending('other-request', actors.otherCustomer.cifId);
    // Obtain a fresh trusted token explicitly on each clock step.
    const current = await api.request('/me/onboarding-requests', { token: await api.tokenFor(actors.customer.actorId) });
    expect(current.status).toBe(200);
    expect(current.body.items).toContainEqual(expect.objectContaining({ id: own.id, status: 'PENDING_CONSENT', expiresAt: own.expiresAt, termsVersion: own.termsVersion }));
    expect(JSON.stringify(current.body)).not.toContain(other.id);
    expect(JSON.stringify(current.body)).not.toContain(actors.otherCustomer.cifId);
    const foreign = await api.request('/me/onboarding-requests', { token: await api.tokenFor(actors.otherCustomer.actorId) });
    expect(foreign.status).toBe(200);
    expect(foreign.body.items).toContainEqual(expect.objectContaining({ id: other.id }));
    expect(JSON.stringify(foreign.body)).not.toContain(own.id);
    expectApiError(await api.request('/me/onboarding-requests', { token: await api.tokenFor() }), 403, 'FORBIDDEN');
    expectApiError(await api.request('/me/onboarding-requests', { token: await api.tokenFor(actors.leader.actorId) }), 403, 'FORBIDDEN');
    api.state.now = new Date(own.expiresAt);
    const expired = await api.request('/me/onboarding-requests', { token: await api.tokenFor(actors.customer.actorId) });
    expect(expired.status).toBe(200);
    expect(expired.body.items).toContainEqual(expect.objectContaining({ id: own.id, status: 'EXPIRED', expiresAt: own.expiresAt }));
    expect(JSON.stringify(expired.body)).not.toContain(other.id);
  });
});

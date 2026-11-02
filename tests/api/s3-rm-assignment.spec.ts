import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { actors, insertStaff, staff, staffIdOf, viaDataSource } from '../helpers/actors.js';
import { eligibleCustomer, expectApiError, startApiFixture } from '../helpers/application.js';
import { executeProposal, insertActiveCustomer, insertProposal, rid } from '../helpers/wms.js';

type Fixture = Awaited<ReturnType<typeof startApiFixture>>;
type Actor = { actorId: string; subjectId: string; role: 'RM' | 'LEADER' | 'CUSTOMER'; cifId: string | null; rmId: string | null; teamId: string | null };
type Identity = { id: string; cif_id: string };
type Eligibility = { profileId: string; version: number; category: string; maxProductRisk: number; allocation: Record<string, number>; expiresAt: string; validAt: string; valid: boolean };
type AccessPort = { withAccessTransaction<T>(actor: Actor, customerId: string, work: (manager: EntityManager, customer: Identity) => Promise<T>): Promise<T> };
type RiskPort = { eligibility(actor: Actor, customerId: string, manager: EntityManager, validAt: Date): Promise<Eligibility> };
const replacement = staff.replacement;
const third = staff.third;
const foreign = staff.foreign;
const inactive = staff.inactive;
const terminalStates = ['EXECUTED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED'] as const;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

describe('S3 AC05/AC08/AC12 RM transfer on real PostgreSQL', () => {
  let api: Fixture;
  beforeEach(async () => {
    api = await startApiFixture();
    const sql = viaDataSource(api.dataSource);
    for (const actor of [replacement, third, foreign, inactive]) await insertStaff(sql, actor, { active: actor !== inactive });
    await insertStaff(sql, staff.foreignLeader);
  });
  afterEach(async () => { await api?.stop(); });

  async function register(cifId: string = actors.customer.cifId, actorId: string = actors.customer.actorId, activate = true) {
    const created = await api.request('/onboarding/requests', { method: 'POST', token: await api.tokenFor(), key: `onboard-${cifId}`,
      body: { cifRef: cifId, selectedCasaNo: eligibleCustomer(cifId).accounts[0].id } });
    expect(created.status).toBe(201);
    const customerToken = await api.tokenFor(actorId);
    const challenge = await api.request('/otp/challenges', { method: 'POST', token: customerToken, body: { purpose: 'SERVICE_CONSENT', operationId: created.body.requestId } });
    expect(challenge.status).toBe(201);
    const otp = api.deliveries.find(item => item.challengeId === challenge.body.challengeId)!;
    const accepted = await api.request(`/me/onboarding-requests/${created.body.requestId}/confirm`, { method: 'POST', token: customerToken, key: `consent-${cifId}`, body: { challengeId: otp.challengeId, code: otp.code } });
    expect(accepted.status).toBe(200);
    if (activate) {
      const questionnaire = await api.request('/risk-questionnaires/current', { token: customerToken });
      expect(questionnaire.status).toBe(200);
      const preview = await api.request('/me/risk-assessments', { method: 'POST', token: customerToken, key: `risk-${cifId}`, body: {
        questionnaireVersion: questionnaire.body.version,
        answers: questionnaire.body.questions.map((question: any) => ({ questionId: question.id, optionId: question.options[2].id })),
      } });
      expect(preview.status).toBe(201);
      const riskChallenge = await api.request('/otp/challenges', { method: 'POST', token: customerToken, body: { purpose: 'RISK_PROFILE_CONFIRM', operationId: preview.body.draftId } });
      expect(riskChallenge.status).toBe(201);
      const riskOtp = api.deliveries.find(item => item.challengeId === riskChallenge.body.challengeId)!;
      const confirmed = await api.request(`/me/risk-assessments/${preview.body.draftId}/confirm`, { method: 'POST', token: customerToken, key: `risk-confirm-${cifId}`,
        body: { challengeId: riskOtp.challengeId, code: riskOtp.code, expectedCurrentProfileVersion: 0 } });
      expect(confirmed.status).toBe(200);
      api.tick(); // category 4: chk_rma_period needs valid_to > valid_from for the later transfer
      return { ...accepted.body, profile: confirmed.body };
    }
    api.tick();
    return accepted.body;
  }
  async function transfer(customerId: string, targetRmId = replacement.rmId, expectedAssignmentVersion = 1, key = randomUUID(), actorId: string = actors.leader.actorId,
    extra: Record<string, unknown> = {}) {
    return api.request(`/customers/${customerId}/rm-assignment`, { method: 'POST', token: await api.tokenFor(actorId), key,
      headers: { 'x-request-id': rid(51), 'user-agent': 'Synthetic assignment device' },
      body: { targetRmId, reason: 'Synthetic coverage change', expectedAssignmentVersion, ...extra } });
  }
  // Every group reaches the existing HTTP signature before touching any proposed table or port.
  async function assignmentAvailable(customerId: string) {
    const response = await transfer(customerId, actors.rm.rmId, 1, 'same-rm-probe');
    expect(response.status, 'UC03 same-RM request must return the current assignment rather than NOT_IMPLEMENTED').toBe(200);
    expect(response.body).toMatchObject({ customerId, rmId: actors.rm.rmId, teamId: actors.rm.teamId, version: 1, changed: false });
    return response.body;
  }
  async function assignments(customerId: string) { return api.dataSource.query('SELECT * FROM wms.rm_assignments WHERE customer_id=$1 ORDER BY version', [customerId]); }
  async function proposals(customerId: string) { return api.dataSource.query('SELECT * FROM wms.proposals WHERE customer_id=$1 ORDER BY proposal_id', [customerId]); }
  // Category 6: team proposals need the customer's account and profile; at most one PENDING_APPROVAL per customer.
  async function seedProposal(customerId: string, authorRmId: string, status = 'PENDING_APPROVAL') {
    return insertProposal(viaDataSource(api.dataSource), { customerId, authorRmId, status, now: api.state.now });
  }
  async function transferEffects() {
    return { audits: await api.dataSource.query("SELECT * FROM wms.audit_logs WHERE action='RM_ASSIGNMENT_CHANGED' ORDER BY log_id"),
      events: await api.dataSource.query("SELECT * FROM wms.outbox_events WHERE event_type='RmAssignmentChanged' ORDER BY created_at, event_id"),
      idempotency: await api.dataSource.query("SELECT * FROM wms.idempotency_records WHERE scope_purpose LIKE '%RM_ASSIGNMENT%' ORDER BY idem_key") };
  }
  async function ports(): Promise<{ access: AccessPort; risk: RiskPort }> {
    const accessModule = await import(/* @vite-ignore */ new URL('../../apps/api/dist/modules/customer-risk/customer-access.service.js', import.meta.url).href);
    const riskModule = await import(/* @vite-ignore */ new URL('../../apps/api/dist/modules/customer-risk/risk.service.js', import.meta.url).href);
    const access = api.app.get(accessModule.CustomerAccess) as AccessPort;
    const risk = api.app.get(riskModule.RiskService) as RiskPort;
    expect(typeof access.withAccessTransaction, 'exported CustomerAccess port must expose a transaction-scoped consumer callback').toBe('function');
    expect(typeof risk.eligibility, 'exported RiskEligibility port must accept the same caller EntityManager').toBe('function');
    return { access, risk };
  }
  // This is a local P4 integration consumer, not a trading engine or a lock mock.
  async function executeConsumer(customerId: string, proposalId: string, actor: Actor, hook?: () => Promise<void>) {
    const { access, risk } = await ports();
    return access.withAccessTransaction(actor, customerId, async (manager, identity) => {
      expect(identity.id).toBe(customerId);
      const eligibility = await risk.eligibility(actor, customerId, manager, api.state.now);
      expect(eligibility).toMatchObject({ profileId: expect.any(String), version: 1, category: 'BALANCED', maxProductRisk: 3,
        allocation: { cash: 5, deposit: 30, bond: 30, fund: 35 }, validAt: api.state.now.toISOString(), valid: true, expiresAt: expect.any(String) });
      const [proposal] = await manager.query('SELECT * FROM wms.proposals WHERE proposal_id=$1 AND customer_id=$2', [proposalId, customerId]);
      if (!proposal || proposal.rm_id !== actor.rmId || proposal.status !== 'PENDING_APPROVAL') throw Object.assign(new Error('Proposal unavailable'), { code: 'PROPOSAL_NOT_PENDING' });
      await hook?.();
      await executeProposal((text, params) => manager.query(text, params), proposalId, api.state.now); // category 6: APPROVED -> EXECUTING -> EXECUTED
      return { id: proposalId, status: 'EXECUTED', eligibility };
    });
  }
  async function waitForBlockedAdvisory(minWaiting = 1) {
    // Round-trip polling observes real PG blocking; no timer guesses or in-memory lock substitutes.
    for (let attempt = 0; attempt < 500; attempt++) {
      const [row] = await api.dataSource.query("SELECT count(*)::integer AS waiting FROM pg_locks WHERE locktype='advisory' AND NOT granted AND pid IN (SELECT pid FROM pg_stat_activity WHERE datname=current_database())");
      if (row.waiting >= minWaiting) return;
    }
    throw new Error('Expected competing real PostgreSQL transaction to wait on the held barrier');
  }

  test('AC05 leader scope, active service/RM, same-RM no-op and version/body guards are enforced from trusted current data', async () => {
    const customer = await register();
    const original = await assignmentAvailable(customer.customerId);
    const before = await assignments(customer.customerId);
    const effectsBefore = await transferEffects();
    const directory = await api.request('/team/rms', { token: await api.tokenFor(actors.leader.actorId) });
    expect(directory.status).toBe(200);
    expect(directory.body.items).toContainEqual(expect.objectContaining({ rmId: replacement.rmId, teamId: actors.rm.teamId, active: true, assigned: 0, reserved: 0, capacityLimit: 80 }));
    expect(directory.body.items).toContainEqual(expect.objectContaining({ rmId: inactive.rmId, active: false }));
    expect(directory.body.items.map((item: any) => item.rmId)).not.toContain(foreign.rmId);
    for (const actorId of [actors.rm.actorId, actors.customer.actorId, staff.foreignLeader.actorId]) expectApiError(await transfer(customer.customerId, replacement.rmId, 1, `forbidden-${actorId}`, actorId), 403, 'FORBIDDEN');
    expectApiError(await transfer(customer.customerId, foreign.rmId), 403, 'FORBIDDEN');
    expectApiError(await transfer(customer.customerId, inactive.rmId), 422, 'RM_INACTIVE');
    for (const invalid of [{ expectedAssignmentVersion: 0 }, { expectedAssignmentVersion: 1.5 }, { reason: '' }, { targetRmId: 'not-a-uuid' }, { rmId: actors.rm.rmId }, { role: 'LEADER' }]) {
      expectApiError(await transfer(customer.customerId, replacement.rmId, 1, randomUUID(), actors.leader.actorId, invalid), 400, 'VALIDATION_ERROR');
    }
    const missingKey = await api.request(`/customers/${customer.customerId}/rm-assignment`, { method: 'POST', token: await api.tokenFor(actors.leader.actorId), body: { targetRmId: replacement.rmId, reason: 'Coverage', expectedAssignmentVersion: 1 } });
    expectApiError(missingKey, 400, 'VALIDATION_ERROR');
    const ownPending = await seedProposal(customer.customerId, actors.rm.rmId);
    expect((await transfer(customer.customerId, actors.rm.rmId, 1, 'same-rm-second')).body).toEqual(original);
    expect(await assignments(customer.customerId)).toEqual(before);
    expect((await proposals(customer.customerId)).find((row: any) => row.proposal_id === ownPending).status).toBe('PENDING_APPROVAL');
    expect((await transferEffects()).audits).toEqual(effectsBefore.audits);
    expect((await transferEffects()).events).toEqual(effectsBefore.events);
    expectApiError(await transfer(customer.customerId, actors.rm.rmId, 2), 409, 'RM_ASSIGNMENT_STALE');
    const pending = await register(actors.otherCustomer.cifId, actors.otherCustomer.actorId, false);
    expectApiError(await transfer(pending.customerId), 422, 'SERVICE_INACTIVE');
    expect((await assignments(pending.customerId)).filter((row: any) => row.valid_to === null)[0].rm_id).toBe(actors.rm.rmId);
    // Customer scope comes from the CURRENT assignment, not merely the destination team.
    await api.dataSource.query('UPDATE wms.rm_assignments SET team_id=$2 WHERE customer_id=$1 AND valid_to IS NULL', [customer.customerId, foreign.teamId]);
    expectApiError(await transfer(customer.customerId), 403, 'FORBIDDEN');
  });

  test('AC05/AC08 capacity eighty includes live reservations and two real customers compete safely for the final slot', async () => {
    const first = await register();
    const second = await register(actors.otherCustomer.cifId, actors.otherCustomer.actorId);
    await assignmentAvailable(first.customerId);
    // Seed 79 genuine customer/service/assignment tuples; do not create 79 HTTP apps.
    const [consent] = await api.dataSource.query('SELECT * FROM wms.service_consents WHERE customer_id=$1', [first.customerId]);
    for (let index = 0; index < 79; index++) {
      await api.dataSource.transaction(async manager => {
        await insertActiveCustomer((text, params) => manager.query(text, params), { index, rmId: replacement.rmId, teamId: replacement.teamId!, now: api.state.now,
          template: { consentId: consent.consent_id, draftId: first.profile.draftId, profileId: first.profile.riskProfileId } });
      });
    }
    // Category 4: chk_onb_ttl fixes the request at created_at + 72 h; the reservation keeps its own 1 s expiry below.
    const reservationRequest = randomUUID();
    await api.dataSource.query(`INSERT INTO wms.onboarding_requests(request_id,cif_id,customer_name,selected_casa_no,rm_id,team_id,status,terms_version,terms_hash,created_at,expires_at)
      VALUES($1,'capacity-reservation','Synthetic reservation','synthetic-account',$2,$3,'PENDING_CONSENT',$4,$5,$6,$7)`, [reservationRequest, replacement.rmId, replacement.teamId, consent.terms_version, consent.terms_hash, api.state.now, new Date(api.state.now.getTime() + 72 * 3_600_000)]);
    await api.dataSource.query("INSERT INTO wms.rm_capacity_reservations(request_id,rm_id,status,created_at,expires_at) VALUES($1,$2,'ACTIVE',$3,$4)", [reservationRequest, replacement.rmId, api.state.now, new Date(api.state.now.getTime() + 1000)]);
    const before = await assignments(first.customerId);
    expectApiError(await transfer(first.customerId, replacement.rmId, 1, 'live-reservation-full'), 409, 'RM_CAPACITY_EXCEEDED');
    expect(await assignments(first.customerId)).toEqual(before);
    const directory = await api.request('/team/rms', { token: await api.tokenFor(actors.leader.actorId) });
    expect(directory.body.items).toContainEqual(expect.objectContaining({ rmId: replacement.rmId, assigned: 79, reserved: 1, available: 0 }));
    api.state.now = new Date(api.state.now.getTime() + 1000); // Exact expiry excludes still-ACTIVE reservation without a sweeper.
    // Queue BOTH requests behind an exported transaction-lock boundary, then release together.
    const lockModule = await import(/* @vite-ignore */ new URL('../../apps/api/dist/platform/transactions.js', import.meta.url).href);
    const gate = api.dataSource.createQueryRunner();
    await gate.connect(); await gate.startTransaction();
    let competing: Array<ReturnType<typeof transfer>> = [];
    let results: Awaited<ReturnType<typeof transfer>>[] = [];
    try {
      await lockModule.lockCustomer(gate.manager, 'synthetic-capacity-race-barrier', [replacement.rmId]);
      competing = [transfer(first.customerId, replacement.rmId, 1, 'capacity-first'), transfer(second.customerId, replacement.rmId, 1, 'capacity-second')];
      await waitForBlockedAdvisory(2);
      await gate.commitTransaction();
      results = await Promise.all(competing);
    } finally {
      if (gate.isTransactionActive) await gate.rollbackTransaction();
      await gate.release();
      await Promise.allSettled(competing);
    }
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    expect(results.find(result => result.status === 409)!.body.code).toBe('RM_CAPACITY_EXCEEDED');
    const [count] = await api.dataSource.query('SELECT count(*)::integer AS assigned FROM wms.rm_assignments WHERE rm_id=$1 AND valid_to IS NULL', [replacement.rmId]);
    expect(count.assigned).toBe(80);
    const winner = results.find(result => result.status === 200)!.body;
    const loserId = winner.customerId === first.customerId ? second.customerId : first.customerId;
    expect((await assignments(winner.customerId)).filter((row: any) => row.valid_to === null)).toHaveLength(1);
    expect((await assignments(loserId)).filter((row: any) => row.valid_to === null)[0]).toMatchObject({ rm_id: actors.rm.rmId, version: 1 });
    expect((await transferEffects()).events).toHaveLength(1);
  });

  test('AC05/AC08 two transfers sharing a base version leave one current history row and replay cannot overwrite the winner', async () => {
    const customer = await register();
    await assignmentAvailable(customer.customerId);
    const results = await Promise.all([transfer(customer.customerId, replacement.rmId, 1, 'version-first'), transfer(customer.customerId, third.rmId, 1, 'version-second')]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    expect(results.find(result => result.status === 409)!.body.code).toBe('RM_ASSIGNMENT_STALE');
    const winner = results.find(result => result.status === 200)!.body;
    expect(winner).toMatchObject({ customerId: customer.customerId, version: 2, changed: true });
    const rows = await assignments(customer.customerId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ rm_id: actors.rm.rmId, version: 1, valid_to: api.state.now });
    expect(rows[1]).toMatchObject({ rm_id: winner.rmId, version: 2, valid_to: null, provisional: false, assigned_by: staffIdOf(actors.leader), reason: 'Synthetic coverage change' });
    const winningKey = winner.rmId === replacement.rmId ? 'version-first' : 'version-second';
    const replay = await transfer(customer.customerId, winner.rmId, 1, winningKey);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(winner);
    expectApiError(await transfer(customer.customerId, winner.rmId, 1, winningKey, actors.leader.actorId, { reason: 'Changed reason' }), 409, 'IDEMPOTENCY_CONFLICT');
    expectApiError(await transfer(customer.customerId, winner.rmId, 1, 'stale-noop'), 409, 'RM_ASSIGNMENT_STALE');
    expect(await assignments(customer.customerId)).toEqual(rows);
    const effects = await transferEffects();
    expect(effects.audits).toHaveLength(1);
    expect(effects.events).toHaveLength(1);
    expect(effects.audits[0]).toMatchObject({ actor_id: actors.leader.actorId, actor_role: 'LEADER', reference_id: customer.customerId, created_at: api.state.now,
      request_id: rid(51), ip_address: '127.0.0.1', user_agent: 'Synthetic assignment device', old_value: { rmId: actors.rm.rmId, version: 1 }, new_value: { rmId: winner.rmId, version: 2 } });
    expect(effects.events[0]).toMatchObject({ aggregate_id: customer.customerId, published_at: null, payload: { customerId: customer.customerId, previousRmId: actors.rm.rmId, rmId: winner.rmId, version: 2 } });
    expect(JSON.stringify(effects.audits)).not.toContain('Bearer');
    expect(JSON.stringify(effects.audits)).not.toContain(await api.tokenFor(actors.leader.actorId));
    expect(effects.audits[0].new_value).not.toHaveProperty('authorization');
    expect(effects.audits[0].new_value).not.toHaveProperty('code');
  });

  test('AC05/AC08 real P4 cancellation failure rolls back every local write and success cancels only former author pending proposals', async () => {
    const customer = await register();
    const other = await register(actors.otherCustomer.cifId, actors.otherCustomer.actorId);
    await assignmentAvailable(customer.customerId);
    // Category 6 (ux_proposal_single_pending): one pending proposal per customer. `customer` has the former RM's own pending
    // proposal (CANCELLED by its transfer); `other` has a pending proposal authored by a DIFFERENT RM (untouched by its transfer).
    const oldPending = await seedProposal(customer.customerId, actors.rm.rmId);
    const foreignAuthorPending = await seedProposal(other.customerId, third.rmId);
    for (const status of terminalStates) await seedProposal(customer.customerId, actors.rm.rmId, status);
    await expect(seedProposal(customer.customerId, actors.rm.rmId, 'DRAFT')).rejects.toThrow();
    const historyBefore = await assignments(customer.customerId);
    const proposalsBefore = await proposals(customer.customerId);
    const effectsBefore = await transferEffects();
    // NOT VALID permits existing terminal rows; enforced on the actual cancellation UPDATE.
    await api.dataSource.query("ALTER TABLE wms.proposals ADD CONSTRAINT s3_fail_cancellation CHECK(status <> 'CANCELLED') NOT VALID");
    try { expectApiError(await transfer(customer.customerId, replacement.rmId, 1, 'atomic-transfer'), 500, 'INTERNAL_ERROR'); }
    finally { await api.dataSource.query('ALTER TABLE wms.proposals DROP CONSTRAINT s3_fail_cancellation'); }
    expect(await assignments(customer.customerId)).toEqual(historyBefore);
    expect(await proposals(customer.customerId)).toEqual(proposalsBefore);
    expect(await transferEffects()).toEqual(effectsBefore);
    const accepted = await transfer(customer.customerId, replacement.rmId, 1, 'atomic-transfer');
    expect(accepted.status).toBe(200);
    const after = await proposals(customer.customerId);
    expect(after.find((row: any) => row.proposal_id === oldPending)).toMatchObject({ status: 'CANCELLED', cancel_reason: 'RM_TRANSFER' });
    for (const state of terminalStates) expect(after.find((row: any) => row.proposal_id === proposalsBefore.find((prior: any) => prior.status === state).proposal_id)).toEqual(proposalsBefore.find((prior: any) => prior.status === state));
    expect((await proposals(other.customerId)).find((row: any) => row.proposal_id === foreignAuthorPending).status).toBe('PENDING_APPROVAL');
    expect((await transferEffects()).audits).toHaveLength(1);
    expect((await transferEffects()).events).toHaveLength(1);
    // The other customer's transfer leaves the other author's pending proposal untouched (only the former RM's own are cancelled).
    const otherBefore = await proposals(other.customerId);
    api.tick();
    expect((await transfer(other.customerId, replacement.rmId, 1, 'other-customer-transfer')).status).toBe(200);
    expect(await proposals(other.customerId)).toEqual(otherBefore);
    const replay = await transfer(customer.customerId, replacement.rmId, 1, 'atomic-transfer');
    expect(replay.body).toEqual(accepted.body);
    expect(await proposals(customer.customerId)).toEqual(after);
  });

  test('AC12 shared real PG consumer locks obey both commit orders and revoke old RM risk/history/P4 access immediately', async () => {
    const first = await register();
    const second = await register(actors.otherCustomer.cifId, actors.otherCustomer.actorId);
    await assignmentAvailable(first.customerId);
    const firstPending = await seedProposal(first.customerId, actors.rm.rmId);
    const secondPending = await seedProposal(second.customerId, actors.rm.rmId);
    const oldRmToken = await api.tokenFor(); // Keep the same token across committed transfer.
    const { access, risk } = await ports();
    const readConsumer = (customerId: string, actor: Actor) => access.withAccessTransaction(actor, customerId,
      async manager => ({ rows: await manager.query('SELECT * FROM wms.proposals WHERE customer_id=$1', [customerId]),
        risk: await risk.eligibility(actor, customerId, manager, api.state.now) }));
    expect((await readConsumer(first.customerId, actors.rm)).rows.map((row: any) => row.proposal_id)).toContain(firstPending);
    expect((await readConsumer(first.customerId, actors.customer)).risk).toMatchObject({ profileId: first.profile.riskProfileId, version: 1, valid: true });
    expect((await readConsumer(first.customerId, actors.leader)).risk.profileId).toBe(first.profile.riskProfileId);
    await expect(readConsumer(first.customerId, actors.otherCustomer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(readConsumer(first.customerId, staff.foreignLeader)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Transfer-first: a database trigger barrier holds transfer AFTER it owns shared locks.
    const gate = api.dataSource.createQueryRunner();
    await gate.connect(); await gate.startTransaction();
    await gate.query('SELECT pg_advisory_xact_lock(734031)');
    await api.dataSource.query(`CREATE FUNCTION s3_transfer_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.customer_id='${first.customerId}'::uuid AND NEW.rm_id='${replacement.rmId}'::uuid THEN PERFORM pg_advisory_xact_lock(734031); END IF; RETURN NEW; END $$;
      CREATE TRIGGER s3_transfer_barrier BEFORE INSERT ON wms.rm_assignments FOR EACH ROW EXECUTE FUNCTION s3_transfer_barrier();`);
    let transferFirst: ReturnType<typeof transfer> | undefined;
    let blockedConsumer: Promise<any> | undefined;
    try {
      transferFirst = transfer(first.customerId, replacement.rmId, 1, 'transfer-first');
      await waitForBlockedAdvisory();
      blockedConsumer = executeConsumer(first.customerId, firstPending, actors.rm).then(value => ({ value }), error => ({ error }));
      await waitForBlockedAdvisory(2);
      await gate.commitTransaction();
      expect((await transferFirst).status).toBe(200);
      expect((await blockedConsumer).error).toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      if (gate.isTransactionActive) await gate.rollbackTransaction();
      await gate.release();
      await Promise.allSettled([transferFirst, blockedConsumer].filter(Boolean));
      await api.dataSource.query('DROP TRIGGER s3_transfer_barrier ON wms.rm_assignments; DROP FUNCTION s3_transfer_barrier()');
    }
    expect((await proposals(first.customerId)).find((row: any) => row.proposal_id === firstPending)).toMatchObject({ status: 'CANCELLED', cancel_reason: 'RM_TRANSFER' });
    for (const suffix of ['', '/history']) expectApiError(await api.request(`/customers/${first.customerId}/risk-profile${suffix}`, { token: oldRmToken }), 403, 'FORBIDDEN');
    await expect(readConsumer(first.customerId, actors.rm)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const replacementRead = await readConsumer(first.customerId, replacement);
    expect(replacementRead.risk).toMatchObject({ profileId: first.profile.riskProfileId, version: 1, valid: true });
    expect(replacementRead.rows.find((row: any) => row.proposal_id === firstPending).status).toBe('CANCELLED');
    await expect(executeConsumer(first.customerId, firstPending, replacement)).rejects.toMatchObject({ code: 'PROPOSAL_NOT_PENDING' });
    // Approval-first: callback writes are inside the actual port's transaction and locks.
    const entered = deferred(); const release = deferred();
    const consumerFirst = executeConsumer(second.customerId, secondPending, actors.rm, async () => { entered.resolve(); await release.promise; });
    let transferSecond: ReturnType<typeof transfer> | undefined;
    try {
      await Promise.race([entered.promise, consumerFirst.then(() => { throw new Error('Consumer completed before its barrier'); })]);
      transferSecond = transfer(second.customerId, replacement.rmId, 1, 'consumer-first');
      await waitForBlockedAdvisory();
      release.resolve();
      expect(await consumerFirst).toMatchObject({ id: secondPending, status: 'EXECUTED' });
      expect((await transferSecond).status).toBe(200);
    } finally { release.resolve(); await Promise.allSettled([consumerFirst, transferSecond].filter(Boolean)); }
    expect((await proposals(second.customerId)).find((row: any) => row.proposal_id === secondPending)).toMatchObject({ status: 'EXECUTED', cancel_reason: null });
    const current = (await assignments(second.customerId)).filter((row: any) => row.valid_to === null);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ rm_id: replacement.rmId, version: 2 });
    // An aborted consumer proves that provider risk/access and local P4 work share caller Tx.
    const replacementPending = await seedProposal(second.customerId, replacement.rmId);
    await expect(access.withAccessTransaction(replacement, second.customerId, async manager => {
      await risk.eligibility(replacement, second.customerId, manager, api.state.now);
      await executeProposal((text, params) => manager.query(text, params), replacementPending, api.state.now); // category 6
      throw new Error('Synthetic consumer rollback');
    })).rejects.toThrow('Synthetic consumer rollback');
    expect((await proposals(second.customerId)).find((row: any) => row.proposal_id === replacementPending).status).toBe('PENDING_APPROVAL');
  });
});

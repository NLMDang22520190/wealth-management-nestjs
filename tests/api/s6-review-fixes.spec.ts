import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { actors } from '../helpers/actors.js';
import { eligibleCustomer, expectApiError, startApiFixture } from '../helpers/application.js';

type Fixture = Awaited<ReturnType<typeof startApiFixture>>;
type Registered = { customerId: string; serviceId: string; accountId: string };

const replacementRm = '22222222-2222-4222-8222-222222222222';
const foreignRm = { actorId: 'rm-s6-foreign', rmId: '44444444-4444-4444-8444-444444444444', teamId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
const gamma = { actorId: 'customer-gamma', cifId: '00000103' };

/** S6 review round 1 (05-review.md F2, F3, F4, F5, F7): API contract fixes, real PostgreSQL. */
describe('S6 review fixes over HTTP and real PostgreSQL', () => {
  let api: Fixture;

  beforeEach(async () => {
    api = await startApiFixture();
    await api.dataSource.query('INSERT INTO mock_actors(actor_id,subject_id,role,cif_id,active) VALUES($1,$2,$3,$4,true)',
      [gamma.actorId, `mock-${gamma.actorId}`, 'CUSTOMER', gamma.cifId]);
    await api.dataSource.query('INSERT INTO mock_actors(actor_id,subject_id,role,rm_id,team_id,active) VALUES($1,$2,$3,$4,$5,true)',
      ['rm-s6-replacement', 'mock-rm-s6-replacement', 'RM', replacementRm, actors.rm.teamId]);
    await api.dataSource.query('INSERT INTO mock_actors(actor_id,subject_id,role,rm_id,team_id,active) VALUES($1,$2,$3,$4,$5,true)',
      [foreignRm.actorId, `mock-${foreignRm.actorId}`, 'RM', foreignRm.rmId, foreignRm.teamId]);
    await api.dataSource.query("INSERT INTO mock_actors(actor_id,subject_id,role,team_id,active) VALUES('leader-s6-foreign','mock-leader-s6-foreign','LEADER',$1,true)", [foreignRm.teamId]);
  });
  afterEach(async () => { await api?.stop(); });

  async function register(cifId: string = actors.customer.cifId, actorId: string = actors.customer.actorId, rmActorId: string = actors.rm.actorId): Promise<Registered> {
    if (cifId === gamma.cifId) api.state.core = eligibleCustomer(cifId);
    const created = await api.request('/onboarding/requests', {
      method: 'POST', token: await api.tokenFor(rmActorId), key: `s6-register-${cifId}`,
      body: { cifRef: cifId, selectedAccountId: eligibleCustomer(cifId).accounts[0].id },
    });
    expect(created.status).toBe(201);
    const challenge = await api.request('/otp/challenges', {
      method: 'POST', token: await api.tokenFor(actorId), body: { purpose: 'SERVICE_CONSENT', operationId: created.body.id },
    });
    expect(challenge.status).toBe(201);
    const delivery = api.deliveries.find(item => item.challengeId === challenge.body.challengeId)!;
    const accepted = await api.request(`/me/onboarding-requests/${created.body.id}/confirm`, {
      method: 'POST', token: await api.tokenFor(actorId), key: `s6-consent-${cifId}`,
      body: { challengeId: delivery.challengeId, code: delivery.code },
    });
    expect(accepted.status).toBe(200);
    return accepted.body;
  }

  /** Every question answered with the same option index (0 => score 10 CONSERVATIVE, 4 => score 50 GROWTH). */
  async function confirmRisk(actorId: string, customerId: string, optionIndex: number, expectedVersion: number) {
    const questionnaire = await api.request('/risk-questionnaires/current', { token: await api.tokenFor(actorId) });
    expect(questionnaire.status).toBe(200);
    const answers = questionnaire.body.questions.map((question: any) => ({ questionId: question.id, optionId: question.options[optionIndex].id }));
    const draft = await api.request('/me/risk-assessments', {
      method: 'POST', token: await api.tokenFor(actorId), key: `s6-draft-${customerId}-${expectedVersion}`,
      body: { questionnaireVersion: questionnaire.body.version, answers },
    });
    expect(draft.status).toBe(201);
    const challenge = await api.request('/otp/challenges', {
      method: 'POST', token: await api.tokenFor(actorId), body: { purpose: 'RISK_PROFILE_CONFIRM', operationId: draft.body.id },
    });
    expect(challenge.status).toBe(201);
    const delivery = api.deliveries.find(item => item.challengeId === challenge.body.challengeId)!;
    const confirmed = await api.request(`/me/risk-assessments/${draft.body.id}/confirm`, {
      method: 'POST', token: await api.tokenFor(actorId), key: `s6-confirm-${customerId}-${expectedVersion}`,
      body: { challengeId: delivery.challengeId, code: delivery.code, expectedCurrentProfileVersion: expectedVersion },
    });
    expect(confirmed.status).toBe(200);
    return confirmed.body;
  }

  async function addHolding(customerId: string, productId: string, productRisk: number, marketValue: string, asOf: string) {
    await api.dataSource.query(`INSERT INTO holdings_read_snapshots
      (id,customer_id,product_id,product_risk,asset_class,quantity,market_value,as_of,provenance)
      VALUES($1,$2,$3,$4,'FUND',1,$5,$6,'SYNTHETIC_P3_READ_BRIDGE')`, [randomUUID(), customerId, productId, productRisk, marketValue, asOf]);
  }

  async function addProposal(customerId: string, authorRmId: string, status = 'PENDING_APPROVAL') {
    await api.dataSource.query(`INSERT INTO proposals(id,customer_id,author_rm_id,status,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$5)`, [randomUUID(), customerId, authorRmId, status, api.state.now]);
  }

  async function transfer(customerId: string, targetRmId: string, expectedAssignmentVersion: number, key: string) {
    return api.request(`/customers/${customerId}/rm-assignment`, {
      method: 'POST', token: await api.tokenFor(actors.leader.actorId), key,
      body: { targetRmId, reason: 'S6 transfer', expectedAssignmentVersion },
    });
  }

  const rmList = async (query = '') => {
    const response = await api.request(`/rm/customers${query}`, { token: await api.tokenFor() });
    expect(response.status).toBe(200);
    return response.body;
  };
  const ids = (body: any) => body.items.map((item: any) => item.customerId);
  const byId = (a: string, b: string) => a.localeCompare(b);

  // F2
  test('F2 drift alert count is the exact number of open risk-holdings checks on list and detail (0 fresh, 1 after a downgrade over a risky holding)', async () => {
    const first = await register();
    const second = await register(actors.otherCustomer.cifId, actors.otherCustomer.actorId);
    const initial = await confirmRisk(actors.customer.actorId, first.customerId, 4, 0); // GROWTH, max product risk 5
    expect(initial.category).toBe('GROWTH');
    await addHolding(first.customerId, 's6-risk-5-fund', 5, '1000000', '2026-01-15T04:00:00.000Z');

    const driftOf = async (customerId: string) => {
      const detail = await api.request(`/customers/${customerId}`, { token: await api.tokenFor() });
      expect(detail.status).toBe(200);
      const listed = (await rmList('?page=1&pageSize=100')).items.find((item: any) => item.customerId === customerId);
      expect(listed, 'customer must be on the list').toBeDefined();
      return { detail: detail.body.driftAlerts.count, list: listed.driftAlerts.count };
    };
    expect(await driftOf(first.customerId)).toEqual({ detail: 0, list: 0 }); // fresh profile, no check requested
    expect(await driftOf(second.customerId)).toEqual({ detail: 0, list: 0 });

    const downgraded = await confirmRisk(actors.customer.actorId, first.customerId, 0, 1); // CONSERVATIVE, max 2 < holding risk 5
    expect(downgraded.category).toBe('CONSERVATIVE');
    expect(await driftOf(first.customerId)).toEqual({ detail: 1, list: 1 });
    expect(await driftOf(second.customerId)).toEqual({ detail: 0, list: 0 }); // other customer unaffected
    // A check that P3 already processed is no longer open.
    await api.dataSource.query("UPDATE outbox_events SET published_at=$1 WHERE event_type='RiskHoldingsCheckRequested' AND aggregate_id=$2", [api.state.now, first.customerId]);
    expect(await driftOf(first.customerId)).toEqual({ detail: 0, list: 0 });
  });

  // F3
  test('F3 leader team customer list is team scoped, supports name filter and bounded paging, and is LEADER only', async () => {
    const first = await register();
    const second = await register(actors.otherCustomer.cifId, actors.otherCustomer.actorId);
    const foreign = await register(gamma.cifId, gamma.actorId, foreignRm.actorId);
    await api.dataSource.query('UPDATE customers SET name=$2 WHERE id=$1', [first.customerId, 'Alpha Leader Test']);
    await api.dataSource.query('UPDATE customers SET name=$2 WHERE id=$1', [second.customerId, 'Beta Leader Test']);
    await api.dataSource.query('UPDATE customers SET name=$2 WHERE id=$1', [foreign.customerId, 'Gamma Foreign Team']);

    const leaderToken = await api.tokenFor(actors.leader.actorId);
    const list = await api.request('/team/customers', { token: leaderToken });
    expect(list.status, 'GET /team/customers must exist for the leader').toBe(200);
    expect(list.body).toMatchObject({ page: 1, pageSize: 10, total: 2, items: expect.any(Array) });
    expect(ids(list.body).sort(byId)).toEqual([first.customerId, second.customerId].sort(byId));
    expect(ids(list.body)).not.toContain(foreign.customerId);
    expect(list.body.items.find((item: any) => item.customerId === first.customerId))
      .toEqual({ customerId: first.customerId, name: 'Alpha Leader Test', rmId: actors.rm.rmId, assignmentVersion: 1 });

    const filtered = await api.request('/team/customers?name=beta', { token: leaderToken });
    expect(filtered.status).toBe(200);
    expect(ids(filtered.body)).toEqual([second.customerId]);
    expect(filtered.body.total).toBe(1);

    const page = await api.request('/team/customers?page=2&pageSize=1', { token: leaderToken });
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ page: 2, pageSize: 1, total: 2 });
    expect(page.body.items).toHaveLength(1);
    expectApiError(await api.request('/team/customers?pageSize=101', { token: leaderToken }), 400, 'VALIDATION_ERROR');
    expectApiError(await api.request('/team/customers?page=0', { token: leaderToken }), 400, 'VALIDATION_ERROR');

    // The foreign leader sees only the foreign team's customer.
    const foreignList = await api.request('/team/customers', { token: await api.tokenFor('leader-s6-foreign') });
    expect(foreignList.status).toBe(200);
    expect(ids(foreignList.body)).toEqual([foreign.customerId]);

    expectApiError(await api.request('/team/customers', { token: await api.tokenFor() }), 403, 'FORBIDDEN');
    expectApiError(await api.request('/team/customers', { token: await api.tokenFor(actors.customer.actorId) }), 403, 'FORBIDDEN');
  });

  test('F3 team list follows the CURRENT assignment: a customer moved to another RM of the team shows the new rmId and version', async () => {
    const first = await register();
    await confirmRisk(actors.customer.actorId, first.customerId, 2, 0); // transfer needs an ACTIVE service
    expect((await transfer(first.customerId, replacementRm, 1, 's6-f3-move')).status).toBe(200);
    const list = await api.request('/team/customers', { token: await api.tokenFor(actors.leader.actorId) });
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([{ customerId: first.customerId, name: expect.any(String), rmId: replacementRm, assignmentVersion: 2 }]);
  });

  // F4
  test('F4 transfer response reports the exact number of the old RM pending proposals it cancelled; same-RM no-op reports 0', async () => {
    const first = await register();
    await confirmRisk(actors.customer.actorId, first.customerId, 2, 0);
    await addProposal(first.customerId, actors.rm.rmId);
    await addProposal(first.customerId, actors.rm.rmId);
    await addProposal(first.customerId, actors.rm.rmId, 'EXECUTED'); // terminal: not counted
    await addProposal(first.customerId, replacementRm); // other author: not cancelled by this transfer

    const noop = await transfer(first.customerId, actors.rm.rmId, 1, 's6-f4-noop');
    expect(noop.status).toBe(200);
    expect(noop.body).toMatchObject({ changed: false, cancelledProposals: 0 });

    const moved = await transfer(first.customerId, replacementRm, 1, 's6-f4-move');
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ customerId: first.customerId, rmId: replacementRm, version: 2, changed: true, cancelledProposals: 2 });
    const cancelled = await api.dataSource.query("SELECT id FROM proposals WHERE customer_id=$1 AND status='CANCELLED'", [first.customerId]);
    expect(cancelled).toHaveLength(2); // the number reported equals the rows really cancelled

    // Idempotent replay returns the same stored answer, not a recount.
    const replay = await transfer(first.customerId, replacementRm, 1, 's6-f4-move');
    expect(replay.status).toBe(200);
    expect(replay.body.cancelledProposals).toBe(2);
  });

  // F5
  test('F5 AUM asOf is the OLDEST holding snapshot as_of on list and detail', async () => {
    const first = await register();
    await addHolding(first.customerId, 's6-old', 3, '100.00', '2026-01-10T04:00:00.000Z');
    await addHolding(first.customerId, 's6-new', 3, '200.00', '2026-01-15T04:00:00.000Z');
    const detail = await api.request(`/customers/${first.customerId}`, { token: await api.tokenFor() });
    expect(detail.status).toBe(200);
    expect(detail.body.aum).toMatchObject({ value: '300.00', asOf: '2026-01-10T04:00:00.000Z', dataStatus: 'AVAILABLE' });
    const listed = (await rmList()).items.find((item: any) => item.customerId === first.customerId);
    expect(listed.aum.asOf).toBe('2026-01-10T04:00:00.000Z');
  });

  // F7 (coverage of already implemented behaviour; these pin it so mutants die)
  describe('F7 filters and sorts', () => {
    let a: Registered; let b: Registered; let c: Registered; // a VALID, b EXPIRED, c MISSING risk
    beforeEach(async () => {
      a = await register();
      b = await register(actors.otherCustomer.cifId, actors.otherCustomer.actorId);
      c = await register(gamma.cifId, gamma.actorId);
      // Risk profiles are immutable: b's profile expires because the clock moves past it before a confirms.
      const expired = await confirmRisk(actors.otherCustomer.actorId, b.customerId, 2, 0);
      api.state.now = new Date(new Date(expired.expiresAt).getTime() + 3_600_000);
      await confirmRisk(actors.customer.actorId, a.customerId, 2, 0);
      await addProposal(a.customerId, actors.rm.rmId);
      await addProposal(a.customerId, actors.rm.rmId);
      await addProposal(b.customerId, actors.rm.rmId);
      await addProposal(b.customerId, actors.rm.rmId);
    });

    test('F7 riskExpiry=VALID|EXPIRED|MISSING returns exactly the matching customers and rejects other values', async () => {
      expect(ids(await rmList('?riskExpiry=VALID'))).toEqual([a.customerId]);
      expect(ids(await rmList('?riskExpiry=EXPIRED'))).toEqual([b.customerId]);
      expect(ids(await rmList('?riskExpiry=MISSING'))).toEqual([c.customerId]);
      expect((await rmList('?riskExpiry=MISSING')).total).toBe(1);
      expectApiError(await api.request('/rm/customers?riskExpiry=SOON', { token: await api.tokenFor() }), 400, 'VALIDATION_ERROR');
    });

    test('F7 serviceStatus filter returns exactly the matching customers', async () => {
      const cDetail = await api.request(`/customers/${c.customerId}`, { token: await api.tokenFor() });
      expect(cDetail.body.serviceStatus).not.toBe('ACTIVE');
      expect(ids(await rmList('?serviceStatus=ACTIVE')).sort(byId)).toEqual([a.customerId, b.customerId].sort(byId));
      expect(ids(await rmList(`?serviceStatus=${cDetail.body.serviceStatus}`))).toEqual([c.customerId]);
      expect(ids(await rmList('?serviceStatus=SUSPENDED'))).toEqual([]);
    });

    test('F7 sort=riskExpiresAt orders by expiry (missing last) and sort=pendingProposals orders by count with customer-id tie-break', async () => {
      expect(ids(await rmList('?sort=riskExpiresAt&direction=asc'))).toEqual([b.customerId, a.customerId, c.customerId]);
      expect(ids(await rmList('?sort=riskExpiresAt&direction=desc'))).toEqual([a.customerId, b.customerId, c.customerId]);
      const tied = [a.customerId, b.customerId].sort(byId); // both have 2 pending proposals
      expect(ids(await rmList('?sort=pendingProposals&direction=desc'))).toEqual([...tied, c.customerId]);
      expect(ids(await rmList('?sort=pendingProposals&direction=asc'))).toEqual([c.customerId, ...tied]);
      // Sorting happens before paging: page 2 of size 1 is the second element of the full order.
      expect(ids(await rmList('?sort=pendingProposals&direction=desc&page=2&pageSize=1'))).toEqual([tied[1]]);
    });
  });
});

import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { actors, insertStaff, staff, viaDataSource } from '../helpers/actors.js';
import { eligibleCustomer, expectApiError, startApiFixture, TEST_NOW } from '../helpers/application.js';
import { confirmRisk, createDraft, registerCustomer, wrongCode } from '../helpers/flows.js';
import { DAY, HOUR, insertAsset, insertHolding, insertSnapshot, rid } from '../helpers/wms.js';

type Fixture = Awaited<ReturnType<typeof startApiFixture>>;
const JWT_SECRET = 'wms-test-only-secret-at-least-32-characters';
const subOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).sub as string;
function signed(sub: string) {
  const seconds = Math.floor(new Date(TEST_NOW).getTime() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub, iss: 'wealth-management-mock', aud: 'wealth-management-api', iat: seconds, exp: seconds + 3600 })).toString('base64url');
  return `${header}.${payload}.${createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url')}`;
}

describe('S20 AC4 demo login by employee_code / CIF on wms rows', () => {
  let api: Fixture;
  beforeEach(async () => { api = await startApiFixture(); });
  afterEach(async () => { await api?.stop(); });
  const sql = () => viaDataSource(api.dataSource);
  const issue = (actorId: string) => api.request('/mock-auth/token', { method: 'POST', body: { actorId } });

  test.each([['RM', actors.rm], ['LEADER', actors.leader]] as const)('AC4 an active %s logs in by employee_code; JWT sub is staff_users.iam_subject', async (_role, actor) => {
    const response = await issue(actor.actorId);
    expect(response.status).toBe(200);
    expect(subOf(response.body.accessToken)).toBe(actor.subjectId);
    const me = await api.request('/auth/me', { token: response.body.accessToken });
    expect(me.body).toEqual(actor);
  });

  test('AC4 BACK_OFFICE, BACK_OFFICE_MANAGER, inactive staff and unknown ids are 401 UNAUTHORIZED', async () => {
    await sql()("INSERT INTO wms.staff_users(iam_subject,employee_code,full_name,role) VALUES('iam.bo','NV0190','Back office','BACK_OFFICE'),('iam.bom','NV0191','BO manager','BACK_OFFICE_MANAGER')");
    await insertStaff(sql(), staff.inactive, { active: false });
    for (const id of ['NV0190', 'NV0191', staff.inactive.actorId, 'NV0000', 'rm-alpha']) expectApiError(await issue(id), 401, 'UNAUTHORIZED');
    // A valid token of an inactive or back-office subject is refused as well.
    for (const sub of ['iam.bo', 'iam.bom', staff.inactive.subjectId]) expectApiError(await api.request('/auth/me', { token: signed(sub) }), 401, 'UNAUTHORIZED');
  });

  test('AC4 a customer in wms.customers logs in by CIF; sub is customers.iam_subject, resolved from the row', async () => {
    await sql()("INSERT INTO wms.customers(cif_id,iam_subject,full_name) VALUES('CIF100801','custom.subject.801','Synthetic Eight')");
    const response = await issue('CIF100801');
    expect(response.status).toBe(200);
    expect(subOf(response.body.accessToken)).toBe('custom.subject.801');
    const me = await api.request('/auth/me', { token: response.body.accessToken });
    expect(me.body).toMatchObject({ actorId: 'CIF100801', subjectId: 'custom.subject.801', role: 'CUSTOMER', cifId: 'CIF100801', rmId: null, teamId: null });
  });

  test('AC4 before onboarding, an invitation lets the CIF log in with sub cust.<lower cif>; CIFs are compared exactly; no invitation is 401', async () => {
    expectApiError(await issue('CIF100802'), 401, 'UNAUTHORIZED');
    api.state.core = eligibleCustomer('CIF100802');
    const created = await api.request('/onboarding/requests', { method: 'POST', token: await api.tokenFor(), key: 's20-invite',
      body: { cifRef: 'CIF100802', selectedCasaNo: eligibleCustomer('CIF100802').accounts[0].id } });
    expect(created.status).toBe(201);
    const response = await issue('CIF100802');
    expect(response.status).toBe(200);
    expect(subOf(response.body.accessToken)).toBe('cust.cif100802');
    expect((await api.request('/auth/me', { token: response.body.accessToken })).body).toMatchObject({ role: 'CUSTOMER', cifId: 'CIF100802' });
    expectApiError(await issue('cif100802'), 401, 'UNAUTHORIZED');
    expectApiError(await api.request('/auth/me', { token: signed('cust.cif100803') }), 401, 'UNAUTHORIZED');
  });

  test('AC4 a sub that matches both a staff row and a customer row is 401', async () => {
    await sql()("INSERT INTO wms.customers(cif_id,iam_subject,full_name) VALUES('CIF100804','shared.subject','Shared')");
    await sql()('UPDATE wms.staff_users SET iam_subject=$2 WHERE employee_code=$1', [actors.rm.actorId, 'shared.subject']);
    expectApiError(await api.request('/auth/me', { token: signed('shared.subject') }), 401, 'UNAUTHORIZED');
  });
});

describe('S20 AC6/AC7/AC8/AC9 UC-01, OTP, audit and idempotency on wms', () => {
  let api: Fixture;
  beforeEach(async () => { api = await startApiFixture(); });
  afterEach(async () => { await api?.stop(); });
  const q = (text: string, params?: unknown[]) => api.dataSource.query(text, params);

  test('AC6 UC-01 writes team rows: invitation casa/rm/team, customer identity, WM-numbered account and its ledger account', async () => {
    const first = await registerCustomer(api);
    const second = await registerCustomer(api, { cifId: actors.otherCustomer.cifId, actorId: actors.otherCustomer.actorId });
    const [request] = await q('SELECT * FROM wms.onboarding_requests WHERE request_id=$1', [first.request.requestId]);
    expect(request).toMatchObject({ cif_id: actors.customer.cifId, selected_casa_no: eligibleCustomer().accounts[0].id, rm_id: actors.rm.rmId, team_id: actors.rm.teamId, status: 'CONFIRMED' });
    const [customer] = await q("SELECT cif_id,iam_subject,full_name,to_char(date_of_birth,'YYYY-MM-DD') AS dob FROM wms.customers WHERE customer_id=$1", [first.customerId]);
    expect(customer).toEqual({ cif_id: actors.customer.cifId, iam_subject: `cust.${actors.customer.cifId.toLowerCase()}`, full_name: 'Synthetic Customer', dob: '2008-01-15' });
    const [account] = await q('SELECT * FROM wms.investment_accounts WHERE account_id=$1', [first.accountId]);
    expect(account).toMatchObject({ account_no: 'WM0000000001', customer_id: first.customerId, cif_id: actors.customer.cifId });
    expect((await q('SELECT account_no FROM wms.investment_accounts WHERE account_id=$1', [second.accountId]))[0].account_no).toBe('WM0000000002');
    const [ledger] = await q("SELECT * FROM wms.ledger_accounts WHERE investment_account_id=$1", [first.accountId]);
    expect(ledger).toMatchObject({ type: 'CUSTOMER_INVESTMENT', code: 'CI-WM0000000001' }); // team seed pattern CI-<account_no>
    const [service] = await q('SELECT * FROM wms.wealth_services WHERE service_id=$1', [first.serviceId]);
    expect(service).toMatchObject({ linked_payment_account_no: eligibleCustomer().accounts[0].id, status: 'PENDING_RISK_ASSESSMENT' });
    const [assignment] = await q('SELECT * FROM wms.rm_assignments WHERE customer_id=$1', [first.customerId]);
    expect(assignment).toMatchObject({ rm_id: actors.rm.rmId, team_id: actors.rm.teamId, provisional: true, version: 1, valid_to: null });
  });

  test('AC7 a wrong code increments attempt_count (status ISSUED, challenge stays usable); success sets VERIFIED, consumed_at and receipt_ref', async () => {
    const created = await api.request('/onboarding/requests', { method: 'POST', token: await api.tokenFor(), key: 's20-otp',
      body: { cifRef: actors.customer.cifId, selectedCasaNo: eligibleCustomer().accounts[0].id } });
    const token = await api.tokenFor(actors.customer.actorId);
    const issued = await api.request('/otp/challenges', { method: 'POST', token, body: { purpose: 'SERVICE_CONSENT', operationId: created.body.requestId } });
    const otp = api.deliveries.find(item => item.challengeId === issued.body.challengeId)!;
    const row = async () => (await q('SELECT * FROM wms.otp_challenges WHERE challenge_id=$1', [otp.challengeId]))[0];
    expect(await row()).toMatchObject({ status: 'ISSUED', attempt_count: 0, consumed_at: null, receipt_ref: null, actor_id: actors.customer.actorId, purpose: 'SERVICE_CONSENT' });
    expect(new Date((await row()).issued_at).toISOString()).toBe(TEST_NOW);
    expect(new Date((await row()).expires_at).getTime() - new Date(TEST_NOW).getTime()).toBe(120_000);
    for (const attempt of [1, 2]) {
      expectApiError(await api.request(`/me/onboarding-requests/${created.body.requestId}/confirm`, { method: 'POST', token, key: `s20-wrong-${attempt}`,
        body: { challengeId: otp.challengeId, code: wrongCode(otp.code) } }), 400, 'OTP_INVALID');
      expect(await row()).toMatchObject({ status: 'ISSUED', attempt_count: attempt, consumed_at: null });
    }
    expect((await api.request(`/me/onboarding-requests/${created.body.requestId}/confirm`, { method: 'POST', token, key: 's20-right',
      body: { challengeId: otp.challengeId, code: otp.code } })).status).toBe(200);
    const done = await row();
    expect(done).toMatchObject({ status: 'VERIFIED', attempt_count: 2 });
    expect(done.consumed_at).not.toBeNull();
    expect(done.receipt_ref).toEqual(expect.any(String));
  });

  test('AC8 audit rows carry actor, role, outcome, reference and request metadata, and never an OTP code or token', async () => {
    const created = await api.request('/onboarding/requests', { method: 'POST', token: await api.tokenFor(), key: 's20-audit',
      headers: { 'x-request-id': rid(61), 'x-device-id': 'dev-s20', 'user-agent': 'S20 agent' },
      body: { cifRef: actors.customer.cifId, selectedCasaNo: eligibleCustomer().accounts[0].id } });
    expect(created.status).toBe(201);
    const [row] = await q("SELECT * FROM wms.audit_logs WHERE action='ONBOARDING_REQUESTED'");
    expect(row).toMatchObject({ actor_id: actors.rm.actorId, actor_role: 'RM', outcome: 'SUCCESS', reference_type: 'ONBOARDING_REQUEST', reference_id: created.body.requestId,
      request_id: rid(61), device_id: 'dev-s20', user_agent: 'S20 agent', ip_address: '127.0.0.1' });
    const token = await api.tokenFor(actors.customer.actorId);
    const issued = await api.request('/otp/challenges', { method: 'POST', token, body: { purpose: 'SERVICE_CONSENT', operationId: created.body.requestId } });
    const otp = api.deliveries.find(item => item.challengeId === issued.body.challengeId)!;
    expect(JSON.stringify(await q('SELECT * FROM wms.audit_logs'))).not.toContain(otp.code);
    expect(JSON.stringify(await q('SELECT * FROM wms.audit_logs'))).not.toContain(token);
  });

  test('AC9 idempotency_records keep a 24 h expiry; a replay before expiry returns the stored result, after expiry the key is new', async () => {
    await registerCustomer(api);
    const token = await api.tokenFor(actors.customer.actorId);
    const first = await createDraft(api, actors.customer.actorId, 0, 's20-idem');
    const [record] = await q("SELECT * FROM wms.idempotency_records WHERE idem_key='s20-idem'");
    expect(record).toMatchObject({ scope_actor: actors.customer.actorId, scope_purpose: 'RISK_ASSESSMENT_DRAFT', response_status: 201 });
    expect(new Date(record.expires_at).getTime() - new Date(record.created_at).getTime()).toBe(24 * HOUR);
    const questionnaire = await api.request('/risk-questionnaires/current', { token });
    const body = { questionnaireVersion: questionnaire.body.version,
      answers: questionnaire.body.questions.map((question: any) => ({ questionId: question.id, optionId: question.options[0].id })) };
    // the JWT lifetime is 3600 s (s0), so a token issued at TEST_NOW is expired after the clock moves; issue a fresh one per replay
    const again = async () => api.request('/me/risk-assessments', { method: 'POST', token: await api.tokenFor(actors.customer.actorId), key: 's20-idem', body });
    api.state.now = new Date(new Date(TEST_NOW).getTime() + 24 * HOUR - 1000);
    const replay = await again();
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first);
    api.state.now = new Date(new Date(TEST_NOW).getTime() + 24 * HOUR + 1000);
    const fresh = await again();
    expect(fresh.status).toBe(201);
    expect(fresh.body.draftId, 'after expiry the key starts a new operation').not.toBe(first.draftId);
    expect(fresh.body.expiresAt).toBe(new Date(api.state.now.getTime() + DAY).toISOString());
  });
});

describe('S20 AC10/AC11 capacity from staff_users and the P2/P3/P4 bridges', () => {
  let api: Fixture;
  beforeEach(async () => { api = await startApiFixture(); });
  afterEach(async () => { await api?.stop(); });
  const sql = () => viaDataSource(api.dataSource);

  test('AC10 the RM capacity limit is staff_users.max_customers', async () => {
    await insertStaff(sql(), staff.replacement, { maxCustomers: 1 });
    const first = await registerCustomer(api);
    const second = await registerCustomer(api, { cifId: actors.otherCustomer.cifId, actorId: actors.otherCustomer.actorId });
    await confirmRisk(api, actors.customer.actorId, 2, 0, 's20-cap-a');
    await confirmRisk(api, actors.otherCustomer.actorId, 2, 0, 's20-cap-b');
    api.tick();
    const transfer = async (customerId: string, key: string) => api.request(`/customers/${customerId}/rm-assignment`, { method: 'POST', token: await api.tokenFor(actors.leader.actorId), key,
      body: { targetRmId: staff.replacement.rmId, reason: 'S20 capacity', expectedAssignmentVersion: 1 } });
    const directory = await api.request('/team/rms', { token: await api.tokenFor(actors.leader.actorId) });
    expect(directory.body.items.find((item: any) => item.rmId === staff.replacement.rmId)).toMatchObject({ capacityLimit: 1, available: 1 });
    expect((await transfer(first.customerId, 's20-cap-1')).status).toBe(200);
    expectApiError(await transfer(second.customerId, 's20-cap-2'), 409, 'RM_CAPACITY_EXCEEDED');
  });

  test('AC11 cash is v_account_balance.available_balance (balance minus held amount)', async () => {
    const registered = await registerCustomer(api);
    await sql()('UPDATE wms.investment_accounts SET balance=$2, held_amount=$3 WHERE customer_id=$1', [registered.customerId, '1000.00', '250.25']);
    const detail = await api.request(`/customers/${registered.customerId}`, { token: await api.tokenFor() });
    expect(detail.body.cash).toMatchObject({ value: '749.75', dataStatus: 'AVAILABLE' });
  });

  test('AC11 AUM is the latest portfolio snapshot, cash is not folded in, no snapshot is UNAVAILABLE', async () => {
    const registered = await registerCustomer(api);
    const none = await api.request(`/customers/${registered.customerId}`, { token: await api.tokenFor() });
    expect(none.body.aum).toMatchObject({ value: null, dataStatus: 'UNAVAILABLE' });
    await insertSnapshot(sql(), { customerId: registered.customerId, date: '2026-01-12', aum: '111.00' });
    await insertSnapshot(sql(), { customerId: registered.customerId, date: '2026-01-13', aum: '222.00' });
    const detail = await api.request(`/customers/${registered.customerId}`, { token: await api.tokenFor() });
    expect(detail.body.aum).toMatchObject({ value: '222.00', asOf: expect.stringMatching(/^2026-01-13/), dataStatus: 'AVAILABLE' });
  });

  test('AC11 the holdings check reads OPEN holdings only, with assets.risk_level', async () => {
    const registered = await registerCustomer(api);
    await confirmRisk(api, actors.customer.actorId, 4, 0, 's20-hold-a');
    const risky = await insertAsset(sql(), { code: 's20-fund-5', risk: 5, assetClass: 'MUTUAL_FUND' });
    const riskyClosed = await insertAsset(sql(), { code: 's20-fund-5-closed', risk: 5, assetClass: 'MUTUAL_FUND' });
    await insertHolding(sql(), { customerId: registered.customerId, assetId: riskyClosed, updatedAt: new Date(TEST_NOW), status: 'CLOSED' });
    await confirmRisk(api, actors.customer.actorId, 0, 1, 's20-hold-b');
    const token = await api.tokenFor(actors.customer.actorId);
    expect((await api.request('/me/risk-profile', { token })).body.holdingsCheck.incompatibleHoldings, 'CLOSED holding is ignored').toEqual([]);
    await insertHolding(sql(), { customerId: registered.customerId, assetId: risky, updatedAt: new Date(TEST_NOW) });
    const check = (await api.request('/me/risk-profile', { token })).body.holdingsCheck;
    expect(check.incompatibleHoldings).toHaveLength(1);
    expect(check.incompatibleHoldings[0]).toMatchObject({ productRisk: 5, maxProductRisk: 2 });
    const outbox = await sql()("SELECT aggregate_type FROM wms.outbox_events WHERE event_type='RiskHoldingsCheckRequested'");
    expect(outbox.length).toBeGreaterThan(0);
    for (const row of outbox) expect(row.aggregate_type).toEqual(expect.stringMatching(/\S/));
  });
});

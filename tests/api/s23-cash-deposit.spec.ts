import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { actors } from '../helpers/actors.js';
import { eligibleCustomer, expectApiError, startApiFixture } from '../helpers/application.js';
import { account, activeCustomer, audit, CASA, confirmOrder, createOrder, CUSTOMER, expectBalanceMatchesLedger, ledger, placeOrder, txn, wrongOtp } from '../helpers/cash.js';
import type { Api } from '../helpers/cash.js';
import { confirmRisk, registerCustomer } from '../helpers/flows.js';

describe('S23 UC-05 deposit into the investment account', () => {
  let api: Api;
  beforeEach(async () => { api = await startApiFixture(); });
  afterEach(async () => { await api?.stop(); });

  test('the account view shows balances, the remaining daily limits and own VND CASA accounts', async () => {
    await activeCustomer(api);
    const view = await api.request('/me/investment-account', { token: await api.tokenFor(CUSTOMER) });
    expect(view.status).toBe(200);
    expect(view.body).toEqual(expect.objectContaining({ balance: '0.00', heldAmount: '0.00', availableBalance: '0.00', status: 'ACTIVE',
      remainingDepositLimit: '2000000000.00', remainingWithdrawalLimit: '2000000000.00',
      casaAccounts: [{ casaNo: CASA, balance: '10000000000.00' }] }));
    expect(view.body.accountNo).toMatch(/^WM\d{10}$/);
  });

  test('a registered customer without an account row is 404 ACCOUNT_NOT_FOUND; an invited one too', async () => {
    const created = await api.request('/onboarding/requests', { method: 'POST', token: await api.tokenFor(), key: 'invite',
      body: { cifRef: CUSTOMER, selectedCasaNo: CASA } });
    expect(created.status).toBe(201);
    expectApiError(await api.request('/me/investment-account', { token: await api.tokenFor(CUSTOMER) }), 404, 'ACCOUNT_NOT_FOUND');
  });

  test('success: INIT with a DEPOSIT OTP, then Core debit, two balanced entries, balance credited, audit and outbox', async () => {
    await activeCustomer(api);
    const created = await createOrder(api, 'deposits', '5000000');
    expect(created.status).toBe(201);
    expect(created.body).toEqual(expect.objectContaining({ status: 'INIT', amount: '5000000.00', txnId: expect.any(String), challengeId: expect.any(String), expiresAt: expect.any(String) }));
    expect(created.body.refNo).toMatch(/^DEP-20260115-\d{4}$/);
    expect(await ledger(api, created.body.txnId)).toEqual([]);
    const delivery = api.deliveries.find(item => item.challengeId === created.body.challengeId)!;
    expect(delivery.purpose).toBe('DEPOSIT');
    const confirmed = await confirmOrder(api, 'deposits', created.body);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toEqual(expect.objectContaining({ txnId: created.body.txnId, status: 'SUCCESS', failureReason: null, balance: '5000000.00', availableBalance: '5000000.00' }));
    expect(api.state.coreCalls.filter(call => call.kind === 'DEBIT')).toEqual([{ kind: 'DEBIT', request: { refNo: created.body.refNo, casaNo: CASA, amount: '5000000.00' } }]);
    const entries = await ledger(api, created.body.txnId);
    expect(entries.map(entry => [entry.account_type, entry.side, entry.amount])).toEqual(expect.arrayContaining([
      ['CUSTOMER_INVESTMENT', 'CREDIT', '5000000.00'], ['CORE_CLEARING', 'DEBIT', '5000000.00']]));
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map(entry => entry.journal_id)).size).toBe(1);
    expect(entries.find(entry => entry.account_type === 'CUSTOMER_INVESTMENT')!.balance_after).toBe('5000000.00');
    expect((await account(api)).balance).toBe('5000000.00');
    expect((await txn(api, created.body.txnId)).core_ref).toBe(`CORE-${created.body.refNo}`);
    await expectBalanceMatchesLedger(api);
    const rows = await audit(api, 'CASH_DEPOSIT_SUCCEEDED');
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(delivery.code);
    expect(await api.dataSource.query("SELECT 1 FROM wms.outbox_events WHERE event_type='CashTransactionCompleted' AND aggregate_id=$1", [created.body.txnId])).toHaveLength(1);
  });

  test('ledger rows cannot be updated or deleted', async () => {
    await activeCustomer(api);
    const { created } = await placeOrder(api, 'deposits', '1000000');
    await expect(api.dataSource.query('UPDATE wms.ledger_entries SET amount=1 WHERE cash_txn_id=$1', [created.txnId])).rejects.toThrow(/append-only/);
    await expect(api.dataSource.query('DELETE FROM wms.ledger_entries WHERE cash_txn_id=$1', [created.txnId])).rejects.toThrow(/append-only/);
  });

  test('validation: bad formats are 400, below the minimum 422 with a FAILURE audit, foreign CASA 422', async () => {
    await activeCustomer(api);
    for (const amount of ['abc', '-1', '1.234', '']) expectApiError(await createOrder(api, 'deposits', amount), 400, 'VALIDATION_ERROR');
    expectApiError(await createOrder(api, 'deposits', '999999.99'), 422, 'AMOUNT_BELOW_MINIMUM');
    expect((await audit(api, 'CASH_DEPOSIT_REQUEST')).map(row => row.outcome)).toEqual(['FAILURE']);
    expectApiError(await createOrder(api, 'deposits', '1000000', { casa: eligibleCustomer(actors.otherCustomer.cifId).accounts[0]!.id }), 422, 'CASA_NOT_ELIGIBLE');
    const missingKey = await api.request('/me/deposits', { method: 'POST', token: await api.tokenFor(CUSTOMER), body: { sourceCasaNo: CASA, amount: '1000000' } });
    expectApiError(missingKey, 400, 'VALIDATION_ERROR');
  });

  test('CASA that is inactive or not VND is not eligible; Core unavailable is 503 and creates nothing', async () => {
    await activeCustomer(api);
    api.state.core = { ...eligibleCustomer(CUSTOMER), accounts: [{ id: CASA, ownerCifId: CUSTOMER, currency: 'VND', active: false }] };
    expectApiError(await createOrder(api, 'deposits', '1000000'), 422, 'CASA_NOT_ELIGIBLE');
    api.state.coreFailure = true;
    expectApiError(await createOrder(api, 'deposits', '1000000'), 503, 'CORE_UNAVAILABLE');
    expect(await api.dataSource.query('SELECT 1 FROM wms.cash_transactions')).toEqual([]);
  });

  test('the service must be ACTIVE and the account ACTIVE', async () => {
    await registerCustomer(api);
    expectApiError(await createOrder(api, 'deposits', '1000000'), 422, 'SERVICE_INACTIVE');
  });

  test('a FROZEN account refuses new orders; frozen before confirm the order fails and Core is not called', async () => {
    await activeCustomer(api);
    const created = await createOrder(api, 'deposits', '1000000');
    await api.dataSource.query("UPDATE wms.investment_accounts SET status='FROZEN' WHERE cif_id=$1", [CUSTOMER]);
    expectApiError(await createOrder(api, 'deposits', '1000000'), 422, 'ACCOUNT_NOT_ACTIVE');
    expectApiError(await confirmOrder(api, 'deposits', created.body), 422, 'ACCOUNT_NOT_ACTIVE');
    expect((await txn(api, created.body.txnId)).status).toBe('FAILED');
    expect(api.state.coreCalls).toEqual([]);
  });

  test('the daily limit counts non-failed orders of the Vietnam day and reports what remains', async () => {
    await activeCustomer(api);
    expect((await createOrder(api, 'deposits', '1999000000')).status).toBe(201);
    const over = await createOrder(api, 'deposits', '1000001');
    expectApiError(over, 422, 'DAILY_LIMIT_EXCEEDED');
    expect(over.body.details).toEqual({ remaining: '1000000.00' });
    expect((await createOrder(api, 'deposits', '1000000')).status).toBe(201);
    // 2026-01-15 17:00Z is already 2026-01-16 in Vietnam: a new limit day.
    api.state.now = new Date('2026-01-15T17:00:00.000Z');
    expect((await createOrder(api, 'deposits', '1000000')).status).toBe(201);
  });

  test('concurrent orders cannot exceed the daily limit together', async () => {
    await activeCustomer(api);
    const results = await Promise.all([createOrder(api, 'deposits', '1500000000'), createOrder(api, 'deposits', '1500000000')]);
    expect(results.map(result => result.status).sort()).toEqual([201, 422]);
    expect(results.find(result => result.status === 422)!.body.code).toBe('DAILY_LIMIT_EXCEEDED');
  });

  test('the same key and body replays the first result; another body is 409; no second order or OTP', async () => {
    await activeCustomer(api);
    const first = await createOrder(api, 'deposits', '1000000', { key: 'same' });
    const otpCount = api.deliveries.length;
    const replay = await createOrder(api, 'deposits', '1000000', { key: 'same' });
    expect(replay.body).toEqual(first.body);
    expect(api.deliveries).toHaveLength(otpCount);
    expectApiError(await createOrder(api, 'deposits', '2000000', { key: 'same' }), 409, 'IDEMPOTENCY_CONFLICT');
    expect(await api.dataSource.query('SELECT 1 FROM wms.cash_transactions')).toHaveLength(1);
    const confirmed = await confirmOrder(api, 'deposits', first.body, { key: 'confirm-same' });
    const replayed = await confirmOrder(api, 'deposits', first.body, { key: 'confirm-same' });
    expect(replayed.status).toBe(200);
    expect(replayed.body).toEqual(confirmed.body);
    expect(api.state.coreCalls.filter(call => call.kind === 'DEBIT')).toHaveLength(1);
  });

  test('a key another customer already used does not block this customer (the team index on the key is global)', async () => {
    await activeCustomer(api);
    expect((await createOrder(api, 'deposits', '1000000', { key: 'shared-key' })).status).toBe(201);
    await registerCustomer(api, { cifId: actors.otherCustomer.cifId, actorId: actors.otherCustomer.actorId, key: 'other-invite' });
    await confirmRisk(api, actors.otherCustomer.actorId, 2, 0, 'other-risk');
    const casa = eligibleCustomer(actors.otherCustomer.cifId).accounts[0]!.id;
    expect((await createOrder(api, 'deposits', '1000000', { key: 'shared-key', actor: actors.otherCustomer.actorId, casa })).status).toBe(201);
  });

  test('a key reused after its 24 hour replay window is 409, not a server error', async () => {
    await activeCustomer(api);
    expect((await createOrder(api, 'deposits', '1000000', { key: 'old-key' })).status).toBe(201);
    api.tick(25 * 3_600_000);
    expectApiError(await createOrder(api, 'deposits', '1000000', { key: 'old-key' }), 409, 'IDEMPOTENCY_CONFLICT');
  });

  test('wrong OTP: 400, order FAILED without calling Core, FAILURE audit, a retry is 409', async () => {
    await activeCustomer(api);
    const created = await createOrder(api, 'deposits', '1000000');
    expectApiError(await confirmOrder(api, 'deposits', created.body, { code: wrongOtp(api, created.body.challengeId) }), 400, 'OTP_INVALID');
    expect((await txn(api, created.body.txnId))).toEqual(expect.objectContaining({ status: 'FAILED', failure_reason: 'OTP_INVALID', completed_at: expect.any(Date) }));
    expect(api.state.coreCalls).toEqual([]);
    expect((await audit(api, 'CASH_DEPOSIT_CONFIRM')).map(row => row.outcome)).toEqual(['FAILURE']);
    expectApiError(await confirmOrder(api, 'deposits', created.body), 409, 'TXN_NOT_CONFIRMABLE');
  });

  test('expired OTP: 410 and FAILED; a challenge of another order is 409 and leaves the order INIT', async () => {
    await activeCustomer(api);
    const first = await createOrder(api, 'deposits', '1000000');
    const second = await createOrder(api, 'deposits', '1000000');
    expectApiError(await confirmOrder(api, 'deposits', first.body, { challengeId: second.body.challengeId }), 409, 'OTP_BINDING_MISMATCH');
    expect((await txn(api, first.body.txnId)).status).toBe('INIT');
    api.tick(121_000);
    expectApiError(await confirmOrder(api, 'deposits', first.body), 410, 'OTP_EXPIRED');
    expect((await txn(api, first.body.txnId))).toEqual(expect.objectContaining({ status: 'FAILED', failure_reason: 'OTP_EXPIRED' }));
  });

  test('Core rejection: 200 FAILED, no entries, balance unchanged', async () => {
    await activeCustomer(api);
    api.state.corePosting = async () => ({ outcome: 'REJECTED', reason: 'INSUFFICIENT_FUNDS' });
    const { created, confirmed } = await placeOrder(api, 'deposits', '1000000');
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toEqual(expect.objectContaining({ status: 'FAILED', failureReason: 'CORE_REJECTED', balance: '0.00' }));
    expect(await ledger(api, created.txnId)).toEqual([]);
  });

  test('Core error or no answer within 2 seconds: 200 PENDING, no entries', async () => {
    await activeCustomer(api);
    api.state.corePosting = async () => { throw new Error('synthetic core failure'); };
    const failing = await placeOrder(api, 'deposits', '1000000');
    expect(failing.confirmed.body).toEqual(expect.objectContaining({ status: 'PENDING', balance: '0.00' }));
    api.state.corePosting = () => new Promise(() => undefined);
    const hanging = await placeOrder(api, 'deposits', '1000000');
    expect(hanging.confirmed.body.status).toBe('PENDING');
    expect(await ledger(api, hanging.created.txnId)).toEqual([]);
    expect(api.logs.join('\n')).not.toContain('synthetic core failure');
  });

  test('a database failure after Core debited keeps the order PENDING instead of reporting failure', async () => {
    await activeCustomer(api);
    await api.dataSource.query(`CREATE FUNCTION wms.test_ledger_down() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ledger down'; END $$`);
    await api.dataSource.query('CREATE TRIGGER trg_test_ledger_down BEFORE INSERT ON wms.ledger_entries FOR EACH ROW EXECUTE FUNCTION wms.test_ledger_down()');
    const { created, confirmed } = await placeOrder(api, 'deposits', '1000000');
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe('PENDING');
    expect((await account(api)).balance).toBe('0.00');
    expect((await txn(api, created.txnId)).status).toBe('PENDING');
  });

  test("another customer cannot confirm the order: 403 with a DENIED audit", async () => {
    await activeCustomer(api);
    const created = await createOrder(api, 'deposits', '1000000');
    await registerCustomer(api, { cifId: actors.otherCustomer.cifId, actorId: actors.otherCustomer.actorId, key: 'other-invite' });
    expectApiError(await confirmOrder(api, 'deposits', created.body, { actor: actors.otherCustomer.actorId }), 403, 'FORBIDDEN');
    expect((await audit(api, 'CASH_DEPOSIT_CONFIRM')).map(row => row.outcome)).toEqual(['DENIED']);
    expect((await txn(api, created.body.txnId)).status).toBe('INIT');
  });

  test('staff cannot use customer cash routes', async () => {
    await activeCustomer(api);
    expectApiError(await api.request('/me/investment-account', { token: await api.tokenFor() }), 403, 'FORBIDDEN');
  });
});

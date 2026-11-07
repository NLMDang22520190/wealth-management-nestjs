import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { expectApiError, startApiFixture } from '../helpers/application.js';
import { account, activeCustomer, audit, BACK_OFFICE, createOrder, CUSTOMER, expectBalanceMatchesLedger, fund, insertBackOffice, ledger, nextKey, placeOrder, runReconciliation, txn } from '../helpers/cash.js';
import type { Api } from '../helpers/cash.js';

describe('S25 process 2c reconciliation and back-office resolution', () => {
  let api: Api;
  let backOffice: string;
  beforeEach(async () => { api = await startApiFixture(); await activeCustomer(api); backOffice = await insertBackOffice(api); });
  afterEach(async () => { await api?.stop(); });

  const coreDown = () => { api.state.corePosting = async () => { throw new Error('synthetic'); }; };
  const coreBack = () => { api.state.corePosting = undefined; };
  const noAnswer = () => { api.state.coreStatus = async () => { throw new Error('synthetic'); }; };
  const notPosted = () => { api.state.coreStatus = async () => ({ outcome: 'NOT_POSTED' }); };
  const resolve = (id: string, outcome: string, note: unknown = 'Đã đối chiếu với Core', token = backOffice) =>
    api.request(`/back-office/cash-transactions/${id}/resolve`, { method: 'POST', token, key: nextKey('resolve'), body: { outcome, note } });

  async function pending(kind: 'deposits' | 'withdrawals', amount = '3000000') {
    if (kind === 'withdrawals') await fund(api, '10000000');
    coreDown();
    const { created, confirmed } = await placeOrder(api, kind, amount);
    expect(confirmed.body.status).toBe('PENDING');
    coreBack();
    return created as { txnId: string; refNo: string };
  }

  test('deposit PENDING: Core posted means entries are written only now and the balance credited', async () => {
    const created = await pending('deposits');
    expect(await ledger(api, created.txnId)).toEqual([]);
    const run = await runReconciliation(api, backOffice);
    expect(run.status).toBe(200);
    expect(run.body).toEqual(expect.objectContaining({ checked: 1, succeeded: 1, failed: 0, unanswered: 0 }));
    expect(await txn(api, created.txnId)).toEqual(expect.objectContaining({ status: 'SUCCESS', core_ref: `CORE-${created.refNo}` }));
    expect((await account(api)).balance).toBe('3000000.00');
    await expectBalanceMatchesLedger(api);
    expect((await audit(api, 'CASH_DEPOSIT_SUCCEEDED')).at(-1)).toEqual(expect.objectContaining({ actor_id: 'reconciliation-job', actor_role: 'SYSTEM_JOB' }));
  });

  test('deposit PENDING: Core not posted means FAILED without entries', async () => {
    const created = await pending('deposits');
    notPosted();
    await runReconciliation(api, backOffice);
    expect(await txn(api, created.txnId)).toEqual(expect.objectContaining({ status: 'FAILED', failure_reason: 'CORE_NOT_POSTED' }));
    expect(await ledger(api, created.txnId)).toEqual([]);
  });

  test('withdrawal PENDING: Core posted keeps the entries; not posted reverses and refunds', async () => {
    const kept = await pending('withdrawals');
    await runReconciliation(api, backOffice);
    expect((await txn(api, kept.txnId)).status).toBe('SUCCESS');
    expect(await ledger(api, kept.txnId)).toHaveLength(2);
    expect((await account(api)).balance).toBe('7000000.00');
    const reversed = await pending('withdrawals');
    notPosted();
    await runReconciliation(api, backOffice);
    expect((await txn(api, reversed.txnId)).status).toBe('FAILED');
    expect(await ledger(api, reversed.txnId)).toHaveLength(4);
    expect((await account(api)).balance).toBe('17000000.00');
    await expectBalanceMatchesLedger(api);
  });

  test('three unanswered rounds move the order to the back-office queue and stop asking Core', async () => {
    const created = await pending('withdrawals');
    noAnswer();
    for (const expected of [1, 2, 3]) {
      const run = await runReconciliation(api, backOffice);
      expect(run.body.unanswered).toBe(1);
      expect((await txn(api, created.txnId)).retry_count).toBe(expected);
    }
    expect(await txn(api, created.txnId)).toEqual(expect.objectContaining({ status: 'PENDING', needs_manual_review: true }));
    const asked = api.state.coreCalls.filter(call => call.kind === 'STATUS').length;
    expect((await runReconciliation(api, backOffice)).body.checked).toBe(0);
    expect(api.state.coreCalls.filter(call => call.kind === 'STATUS')).toHaveLength(asked);
  });

  test('an abandoned order is failed once its OTP expired and its hold released; a live one is untouched', async () => {
    await fund(api, '10000000');
    const abandoned = await createOrder(api, 'withdrawals', '3000000');
    api.tick(121_000);
    const live = await createOrder(api, 'withdrawals', '2000000');
    const run = await runReconciliation(api, backOffice);
    expect(run.body.expired).toBe(1);
    expect(await txn(api, abandoned.body.txnId)).toEqual(expect.objectContaining({ status: 'FAILED', failure_reason: 'OTP_EXPIRED' }));
    expect((await txn(api, live.body.txnId)).status).toBe('INIT');
    expect((await account(api)).held_amount).toBe('2000000.00');
  });

  test('an order whose OTP was consumed but whose process died goes to reconciliation after a minute', async () => {
    const created = await pending('deposits');
    await api.dataSource.query("UPDATE wms.cash_transactions SET status='INIT' WHERE txn_id=$1", [created.txnId]);
    await runReconciliation(api, backOffice);
    expect((await txn(api, created.txnId)).status).toBe('INIT');
    api.tick(61_000);
    const run = await runReconciliation(api, backOffice);
    expect(run.body.recovered).toBe(1);
    expect((await txn(api, created.txnId)).status).toBe('SUCCESS');
  });

  test('one order that cannot be swept does not stop the job', async () => {
    await fund(api, '10000000');
    const broken = await createOrder(api, 'withdrawals', '3000000');
    const healthy = await createOrder(api, 'deposits', '1000000');
    // This trigger stands in for any database error on this one order.
    await api.dataSource.query(`CREATE FUNCTION wms.test_cash_down() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.txn_id = '${broken.body.txnId}'::uuid THEN RAISE EXCEPTION 'cash down'; END IF; RETURN NEW; END $$`);
    await api.dataSource.query('CREATE TRIGGER trg_test_cash_down BEFORE UPDATE ON wms.cash_transactions FOR EACH ROW EXECUTE FUNCTION wms.test_cash_down()');
    api.tick(121_000);
    const run = await runReconciliation(api, backOffice);
    expect(run.status).toBe(200);
    expect(run.body.expired).toBe(1);
    expect((await txn(api, healthy.body.txnId)).status).toBe('FAILED');
    expect((await txn(api, broken.body.txnId)).status).toBe('INIT');
  });

  test('the back-office queue lists only orders that need review', async () => {
    const stuck = await pending('deposits');
    noAnswer();
    for (let round = 0; round < 3; round += 1) await runReconciliation(api, backOffice);
    await pending('deposits');
    const queue = await api.request('/back-office/cash-transactions?needsReview=true', { token: backOffice });
    expect(queue.status).toBe(200);
    expect(queue.body.items.map((item: { txnId: string }) => item.txnId)).toEqual([stuck.txnId]);
    expect(queue.body.items[0]).toEqual(expect.objectContaining({ retryCount: 3, needsReview: true, cifId: CUSTOMER }));
  });

  async function stuck(kind: 'deposits' | 'withdrawals') {
    const created = await pending(kind);
    noAnswer();
    for (let round = 0; round < 3; round += 1) await runReconciliation(api, backOffice);
    return created;
  }

  test('resolving a deposit SUCCESS posts and credits; FAILED posts nothing', async () => {
    const good = await stuck('deposits');
    const resolved = await resolve(good.txnId, 'SUCCESS');
    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe('SUCCESS');
    expect((await account(api)).balance).toBe('3000000.00');
    const bad = await stuck('deposits');
    expect((await resolve(bad.txnId, 'FAILED')).body).toEqual(expect.objectContaining({ status: 'FAILED', failureReason: 'BACK_OFFICE_RESOLVED' }));
    expect(await ledger(api, bad.txnId)).toEqual([]);
    await expectBalanceMatchesLedger(api);
    const rows = await audit(api, 'CASH_TRANSACTION_RESOLVED');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(expect.objectContaining({ actor_id: BACK_OFFICE, actor_role: 'BACK_OFFICE' }));
    expect(rows[0]!.new_value).toEqual(expect.objectContaining({ note: 'Đã đối chiếu với Core' }));
  });

  test('resolving a withdrawal FAILED reverses and refunds; SUCCESS keeps the entries', async () => {
    const bad = await stuck('withdrawals');
    await resolve(bad.txnId, 'FAILED');
    expect(await ledger(api, bad.txnId)).toHaveLength(4);
    expect((await account(api)).balance).toBe('10000000.00');
    const good = await stuck('withdrawals');
    await resolve(good.txnId, 'SUCCESS');
    expect(await ledger(api, good.txnId)).toHaveLength(2);
    expect((await account(api)).balance).toBe('17000000.00');
    await expectBalanceMatchesLedger(api);
  });

  test('only orders in review can be resolved, only by back-office, and a note is required', async () => {
    const early = await pending('deposits');
    expectApiError(await resolve(early.txnId, 'SUCCESS'), 409, 'TXN_NOT_RESOLVABLE');
    const created = await stuck('deposits');
    expectApiError(await resolve(created.txnId, 'SUCCESS', ''), 400, 'VALIDATION_ERROR');
    expectApiError(await resolve(created.txnId, 'MAYBE'), 400, 'VALIDATION_ERROR');
    expectApiError(await resolve(created.txnId, 'SUCCESS', 'note', await api.tokenFor()), 403, 'FORBIDDEN');
    expect((await resolve(created.txnId, 'SUCCESS')).status).toBe(200);
    expectApiError(await resolve(created.txnId, 'FAILED'), 409, 'TXN_NOT_RESOLVABLE');
  });

  test('the job endpoint is back-office only', async () => {
    expectApiError(await runReconciliation(api, await api.tokenFor(CUSTOMER)), 403, 'FORBIDDEN');
  });
});

describe('S25 job endpoints without mocks', () => {
  test('are hidden when mocks are disabled', async () => {
    const api = await startApiFixture({ mockEnabled: false });
    try {
      expectApiError(await api.request('/demo/jobs/reconciliation', { method: 'POST' }), 404, 'NOT_FOUND');
      expectApiError(await api.request('/demo/jobs/maturity-settlement', { method: 'POST', body: {} }), 404, 'NOT_FOUND');
    } finally { await api.stop(); }
  });
});

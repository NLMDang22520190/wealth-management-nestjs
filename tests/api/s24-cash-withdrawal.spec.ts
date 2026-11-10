import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { expectApiError, startApiFixture } from '../helpers/application.js';
import { account, activeCustomer, audit, CASA, confirmOrder, createOrder, CUSTOMER, expectBalanceMatchesLedger, fund, ledger, placeOrder, txn, wrongOtp } from '../helpers/cash.js';
import type { Api } from '../helpers/cash.js';

describe('S24 UC-06 withdrawal to the payment account', () => {
  let api: Api;
  beforeEach(async () => { api = await startApiFixture(); await activeCustomer(api); await fund(api, '10000000'); });
  afterEach(async () => { await api?.stop(); });

  test('success: hold on create, posted before Core is called, Core credit, hold consumed', async () => {
    const created = await createOrder(api, 'withdrawals', '3000000');
    expect(created.status).toBe(201);
    expect(created.body.refNo).toMatch(/^WDR-20260115-\d{4}$/);
    expect(await account(api)).toEqual(expect.objectContaining({ balance: '10000000.00', held_amount: '3000000.00' }));
    expect(api.deliveries.find(item => item.challengeId === created.body.challengeId)!.purpose).toBe('WITHDRAWAL');
    let entriesAtCoreCall = 0;
    api.state.corePosting = async (kind, request) => {
      expect(kind).toBe('CREDIT');
      entriesAtCoreCall = (await ledger(api, created.body.txnId)).length;
      return { outcome: 'POSTED', coreRef: `CORE-${request.refNo}` };
    };
    const confirmed = await confirmOrder(api, 'withdrawals', created.body);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toEqual(expect.objectContaining({ status: 'SUCCESS', balance: '7000000.00', availableBalance: '7000000.00' }));
    expect(entriesAtCoreCall).toBe(2);
    expect(await account(api)).toEqual(expect.objectContaining({ balance: '7000000.00', held_amount: '0.00' }));
    const entries = await ledger(api, created.body.txnId);
    expect(entries.map(entry => [entry.account_type, entry.side, entry.amount])).toEqual(expect.arrayContaining([
      ['CUSTOMER_INVESTMENT', 'DEBIT', '3000000.00'], ['CORE_CLEARING', 'CREDIT', '3000000.00']]));
    await expectBalanceMatchesLedger(api);
    expect(api.state.coreCalls.at(-1)).toEqual({ kind: 'CREDIT', request: { refNo: created.body.refNo, casaNo: CASA, amount: '3000000.00' } });
  });

  test('the amount cannot exceed the available balance, which excludes holds; the error names the maximum', async () => {
    expect((await createOrder(api, 'withdrawals', '6000000')).status).toBe(201);
    const over = await createOrder(api, 'withdrawals', '4000001');
    expectApiError(over, 422, 'INSUFFICIENT_AVAILABLE_BALANCE');
    expect(over.body.details).toEqual({ maxAmount: '4000000.00' });
    expect((await audit(api, 'CASH_WITHDRAWAL_REQUEST')).map(row => row.outcome)).toEqual(['FAILURE']);
    expectApiError(await createOrder(api, 'withdrawals', '999999'), 422, 'AMOUNT_BELOW_MINIMUM');
  });

  test('concurrent withdrawals never over-hold', async () => {
    const results = await Promise.all([createOrder(api, 'withdrawals', '6000000'), createOrder(api, 'withdrawals', '6000000')]);
    expect(results.map(result => result.status).sort()).toEqual([201, 422]);
    expect((await account(api)).held_amount).toBe('6000000.00');
  });

  test('the daily withdrawal limit is 2 billion', async () => {
    await api.dataSource.query('UPDATE wms.investment_accounts SET balance=balance+5000000000 WHERE cif_id=$1', [CUSTOMER]);
    expect((await createOrder(api, 'withdrawals', '2000000000')).status).toBe(201);
    const over = await createOrder(api, 'withdrawals', '1000000');
    expectApiError(over, 422, 'DAILY_LIMIT_EXCEEDED');
    expect(over.body.details).toEqual({ remaining: '0.00' });
  });

  test('wrong OTP releases the hold, nothing is posted', async () => {
    const created = await createOrder(api, 'withdrawals', '3000000');
    expectApiError(await confirmOrder(api, 'withdrawals', created.body, { code: wrongOtp(api, created.body.challengeId) }), 400, 'OTP_INVALID');
    expect((await txn(api, created.body.txnId))).toEqual(expect.objectContaining({ status: 'FAILED', failure_reason: 'OTP_INVALID' }));
    expect(await account(api)).toEqual(expect.objectContaining({ balance: '10000000.00', held_amount: '0.00' }));
    expect(await ledger(api, created.body.txnId)).toEqual([]);
    expect(api.state.coreCalls.filter(call => call.kind === 'CREDIT')).toEqual([]);
  });

  test('expired OTP releases the hold', async () => {
    const created = await createOrder(api, 'withdrawals', '3000000');
    api.tick(121_000);
    expectApiError(await confirmOrder(api, 'withdrawals', created.body), 410, 'OTP_EXPIRED');
    expect((await account(api)).held_amount).toBe('0.00');
  });

  test('a balance that shrank while waiting for OTP fails the order at confirm', async () => {
    const created = await createOrder(api, 'withdrawals', '3000000');
    await api.dataSource.query('UPDATE wms.investment_accounts SET balance=2000000,held_amount=0 WHERE cif_id=$1', [CUSTOMER]);
    expectApiError(await confirmOrder(api, 'withdrawals', created.body), 422, 'INSUFFICIENT_AVAILABLE_BALANCE');
    expect((await txn(api, created.body.txnId)).status).toBe('FAILED');
    expect(await account(api)).toEqual(expect.objectContaining({ balance: '2000000.00', held_amount: '0.00' }));
    expect(await ledger(api, created.body.txnId)).toEqual([]);
  });

  test('a frozen account fails the order at confirm and releases the hold', async () => {
    const created = await createOrder(api, 'withdrawals', '3000000');
    await api.dataSource.query("UPDATE wms.investment_accounts SET status='FROZEN' WHERE cif_id=$1", [CUSTOMER]);
    expectApiError(await confirmOrder(api, 'withdrawals', created.body), 422, 'ACCOUNT_NOT_ACTIVE');
    expect(await account(api)).toEqual(expect.objectContaining({ balance: '10000000.00', held_amount: '0.00' }));
  });

  test('Core rejection: reversal entries point at the originals and refund the balance', async () => {
    api.state.corePosting = async () => ({ outcome: 'REJECTED', reason: 'ACCOUNT_LOCKED' });
    const { created, confirmed } = await placeOrder(api, 'withdrawals', '3000000');
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toEqual(expect.objectContaining({ status: 'FAILED', failureReason: 'CORE_REJECTED', balance: '10000000.00' }));
    const entries = await ledger(api, created.txnId);
    expect(entries).toHaveLength(4);
    const originals = entries.filter(entry => entry.reversal_of === null);
    const reversals = entries.filter(entry => entry.reversal_of !== null);
    expect(reversals.map(entry => entry.reversal_of).sort()).toEqual(originals.map(entry => entry.entry_id).sort());
    expect(reversals.map(entry => [entry.account_type, entry.side])).toEqual(expect.arrayContaining([['CUSTOMER_INVESTMENT', 'CREDIT'], ['CORE_CLEARING', 'DEBIT']]));
    expect(new Set(reversals.map(entry => entry.journal_id)).size).toBe(1);
    expect(reversals[0]!.journal_id).not.toBe(originals[0]!.journal_id);
    await expectBalanceMatchesLedger(api);
  });

  test('Core error: PENDING keeps the entries and the deducted balance', async () => {
    api.state.corePosting = async () => { throw new Error('synthetic'); };
    const { created, confirmed } = await placeOrder(api, 'withdrawals', '3000000');
    expect(confirmed.body).toEqual(expect.objectContaining({ status: 'PENDING', balance: '7000000.00' }));
    expect(await ledger(api, created.txnId)).toHaveLength(2);
    await expectBalanceMatchesLedger(api);
  });

  test('replaying the create or confirm does not deduct twice', async () => {
    const created = await createOrder(api, 'withdrawals', '3000000', { key: 'wd' });
    expect((await createOrder(api, 'withdrawals', '3000000', { key: 'wd' })).body).toEqual(created.body);
    expect((await account(api)).held_amount).toBe('3000000.00');
    const confirmed = await confirmOrder(api, 'withdrawals', created.body, { key: 'wd-confirm' });
    expect((await confirmOrder(api, 'withdrawals', created.body, { key: 'wd-confirm' })).body).toEqual(confirmed.body);
    expect((await account(api)).balance).toBe('7000000.00');
  });

  test('a withdrawal order id cannot be confirmed through the deposit route', async () => {
    const created = await createOrder(api, 'withdrawals', '3000000');
    expectApiError(await confirmOrder(api, 'deposits', created.body), 404, 'NOT_FOUND');
  });
});

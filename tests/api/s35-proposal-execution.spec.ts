import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { expectApiError, startApiFixture } from '../helpers/application.js';
import { account, expectBalanceMatchesLedger, fund } from '../helpers/cash.js';
import type { Api } from '../helpers/cash.js';
import { createAsset, holdDeposit, holdUnits, RM, runSnapshot, snapshots, submitPrice } from '../helpers/portfolio.js';
import { approveNow, challenge, created, proposalCustomer, proposalRow } from '../helpers/proposals.js';

describe('S35 UC-16 atomic execution', () => {
  let api: Api;
  let customerId: string;
  let backOffice: string;
  beforeEach(async () => {
    api = await startApiFixture();
    ({ customerId, backOffice } = await proposalCustomer(api));
  }, 120_000);
  afterEach(async () => { await api?.stop(); });

  const holdingOf = async (assetId: string) => api.dataSource.query(`SELECT holding_id,quantity::text,avg_cost::text,principal::text,locked_rate::text,status::text,
    to_char(start_date,'YYYY-MM-DD') AS start_date,to_char(maturity_date,'YYYY-MM-DD') AS maturity_date FROM wms.portfolio_holdings WHERE asset_id=$1 ORDER BY status DESC,start_date NULLS FIRST`, [assetId]);

  test('sell and early settle first, then buy and open: hand-computed balances, holdings and balanced journals', async () => {
    await fund(api, '100000000');
    const fundAsset = await createAsset(api, backOffice, 'MUTUAL_FUND'); // NAV 20,000
    const bond = await createAsset(api, backOffice, 'BOND'); // price 100,000
    const oldDeposit = await createAsset(api, backOffice, 'TERM_DEPOSIT');
    const newDeposit = await createAsset(api, backOffice, 'TERM_DEPOSIT', { interestRate: '6' });
    await holdUnits(api, fundAsset.assetId, '1000', '18000');
    await holdUnits(api, bond.assetId, '100', '100000');
    // 36,500,000 at 10% from 2026-01-05: 10 days of interest on 2026-01-15 = 100,000.
    await holdDeposit(api, oldDeposit.assetId, { principal: '36500000', rate: '10', start: '2026-01-05', maturity: '2026-07-05' });
    const bondHolding = (await holdingOf(bond.assetId))[0].holding_id;
    const depositHolding = (await holdingOf(oldDeposit.assetId))[0].holding_id;

    const proposal = await created(api, customerId, [
      { action: 'BUY', assetId: fundAsset.assetId, quantity: '500' },
      { action: 'SELL', holdingId: bondHolding, quantity: '100' },
      { action: 'SETTLE', holdingId: depositHolding },
      { action: 'OPEN', assetId: newDeposit.assetId, amount: '50000000' }]);
    const done = await approveNow(api, proposal.proposalId);
    expect(done.status).toBe(200);
    expect(done.body).toEqual(expect.objectContaining({ status: 'EXECUTED', failureReason: null }));

    // 100,000,000 + 10,000,000 + 36,600,000 - 10,000,000 - 50,000,000
    expect((await account(api)).balance).toBe('86600000.00');
    await expectBalanceMatchesLedger(api);
    expect((await holdingOf(fundAsset.assetId))[0]).toEqual(expect.objectContaining({ quantity: '1500.000000', avg_cost: '18666.6667', status: 'OPEN' }));
    expect((await holdingOf(bond.assetId))[0]).toEqual(expect.objectContaining({ quantity: '0.000000', status: 'CLOSED' }));
    expect((await holdingOf(oldDeposit.assetId))[0].status).toBe('CLOSED');
    expect((await holdingOf(newDeposit.assetId))[0]).toEqual(expect.objectContaining({ principal: '50000000.00', locked_rate: '6.0000', status: 'OPEN', start_date: '2026-01-15', maturity_date: '2026-07-15' }));

    const entries: Array<{ action: string; leg_no: number; account_type: string; side: string; amount: string; entry_id: string }> = await api.dataSource.query(
      `SELECT t.action_type::text AS action,l.leg_no,a.type::text AS account_type,e.side::text,e.amount::text,e.entry_id::text
       FROM wms.ledger_entries e JOIN wms.ledger_accounts a USING(ledger_account_id) JOIN wms.investment_transactions t ON t.transaction_id=e.investment_transaction_id
       JOIN wms.proposal_legs l ON l.leg_id=t.proposal_leg_id ORDER BY e.entry_id`);
    const lines = (action: string) => entries.filter(row => row.action === action).map(row => [row.account_type, row.side, row.amount]);
    expect(lines('SELL')).toEqual([['CUSTOMER_INVESTMENT', 'CREDIT', '10000000.00'], ['BOND_HOLDING', 'DEBIT', '10000000.00']]);
    expect(lines('SETTLE')).toEqual([['CUSTOMER_INVESTMENT', 'CREDIT', '36600000.00'], ['TERM_DEPOSIT', 'DEBIT', '36500000.00'], ['INTEREST_PAYABLE', 'DEBIT', '100000.00']]);
    expect(lines('BUY')).toEqual([['CUSTOMER_INVESTMENT', 'DEBIT', '10000000.00'], ['FUND_HOLDING', 'CREDIT', '10000000.00']]);
    expect(lines('OPEN')).toEqual([['CUSTOMER_INVESTMENT', 'DEBIT', '50000000.00'], ['TERM_DEPOSIT', 'CREDIT', '50000000.00']]);
    const firstBuy = Math.min(...entries.filter(row => row.action === 'BUY' || row.action === 'OPEN').map(row => Number(row.entry_id)));
    expect(Math.max(...entries.filter(row => row.action === 'SELL' || row.action === 'SETTLE').map(row => Number(row.entry_id)))).toBeLessThan(firstBuy);

    expect(await proposalRow(api, proposal.proposalId)).toEqual(expect.objectContaining({ status: 'EXECUTED', otp_auth_ref: expect.any(String) }));
    expect((await api.dataSource.query('SELECT status::text,is_atomic_success FROM wms.execution_sessions'))).toEqual([{ status: 'COMMITTED', is_atomic_success: true }]);
    expect(await api.dataSource.query("SELECT status::text FROM wms.investment_transactions WHERE status<>'EXECUTED'")).toEqual([]);
    expect((await api.dataSource.query('SELECT actual_executed_price::text AS price,slippage_rate::text AS slip FROM wms.proposal_legs ORDER BY leg_no'))).toEqual([
      { price: '20000.0000', slip: '0.0000' }, { price: '100000.0000', slip: '0.0000' }, { price: '1.0000', slip: '0.0000' }, { price: '1.0000', slip: '0.0000' }]);
    expect(await api.dataSource.query("SELECT 1 FROM wms.outbox_events WHERE event_type='ProposalExecuted'")).toHaveLength(1);
    expect((await snapshots(api)).map(row => row.snapshot_kind)).toContain('EVENT');
  });

  test('not enough cash after the sales: everything rolls back, the proposal FAILED with a rolled-back session', async () => {
    await fund(api, '10000000');
    const fundAsset = await createAsset(api, backOffice, 'MUTUAL_FUND');
    const bond = await createAsset(api, backOffice, 'BOND');
    await holdUnits(api, bond.assetId, '100', '100000');
    const bondHolding = (await holdingOf(bond.assetId))[0].holding_id;
    const proposal = await created(api, customerId, [{ action: 'SELL', holdingId: bondHolding, quantity: '100' }, { action: 'BUY', assetId: fundAsset.assetId, quantity: '1000' }]);
    // A 5% drop is within the guard, but the sale now raises 9,500,000: 19,500,000 for a 20,000,000 buy.
    await submitPrice(api, backOffice, bond.assetId, '95000');
    const done = await approveNow(api, proposal.proposalId);
    expect(done.status).toBe(200);
    expect(done.body).toEqual(expect.objectContaining({ status: 'FAILED', failureReason: 'INSUFFICIENT_FUNDS_FOR_EXECUTION' }));
    expect((await account(api)).balance).toBe('10000000.00');
    expect((await holdingOf(bond.assetId))[0]).toEqual(expect.objectContaining({ quantity: '100.000000', status: 'OPEN' }));
    expect(await holdingOf(fundAsset.assetId)).toEqual([]);
    expect(await api.dataSource.query('SELECT 1 FROM wms.investment_transactions')).toEqual([]);
    expect(await api.dataSource.query('SELECT status::text,is_atomic_success FROM wms.execution_sessions')).toEqual([{ status: 'ROLLED_BACK', is_atomic_success: false }]);
    expect((await proposalRow(api, proposal.proposalId)).status).toBe('FAILED');
    await expectBalanceMatchesLedger(api);
    expectApiError(await challenge(api, proposal.proposalId), 409, 'PROPOSAL_NOT_PENDING');
  });

  test('a proposal from a drift alert resolves it when executed, and the scan sees the new portfolio', async () => {
    await fund(api, '100000000');
    const fundAsset = await createAsset(api, backOffice, 'MUTUAL_FUND');
    await runSnapshot(api, backOffice);
    const alert = (await api.request('/rm/drift-alerts', { token: await api.tokenFor(RM) })).body.items.find((item: { allocationClass: string }) => item.allocationClass === 'MUTUAL_FUND');
    const proposal = await created(api, customerId, [{ action: 'BUY', assetId: fundAsset.assetId, quantity: '1750' }], { driftAlertId: alert.alertId });
    api.tick();
    expect((await approveNow(api, proposal.proposalId)).body.status).toBe('EXECUTED');
    expect((await api.dataSource.query('SELECT status::text FROM wms.drift_alerts WHERE alert_id=$1', [alert.alertId]))[0].status).toBe('RESOLVED');
    // 35,000,000 of 100,000,000 in the fund is exactly its 35% target: no open fund alert remains.
    const open = await api.dataSource.query("SELECT allocation_class::text FROM wms.drift_alerts WHERE status IN ('NEW','READ') AND allocation_class='MUTUAL_FUND'");
    expect(open).toEqual([]);
  });
});

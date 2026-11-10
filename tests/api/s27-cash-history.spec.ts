import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { actors, insertStaff, staff, viaDataSource } from '../helpers/actors.js';
import { expectApiError, startApiFixture } from '../helpers/application.js';
import { activeCustomer, audit, createOrder, CUSTOMER, fund, insertBackOffice, placeOrder } from '../helpers/cash.js';
import type { Api } from '../helpers/cash.js';
import { registerCustomer } from '../helpers/flows.js';

describe('S27 UC-07 cash history and customer result feed', () => {
  let api: Api;
  let customerId: string;
  beforeEach(async () => { api = await startApiFixture(); customerId = (await activeCustomer(api)).customerId; });
  afterEach(async () => { await api?.stop(); });

  const mine = async (query = '') => api.request(`/me/cash-transactions${query}`, { token: await api.tokenFor(CUSTOMER) });

  test('the customer lists own transactions newest first with amounts as strings, and filters them', async () => {
    await fund(api, '5000000');
    api.tick();
    api.state.corePosting = async () => ({ outcome: 'REJECTED', reason: 'x' });
    await placeOrder(api, 'withdrawals', '1000000');
    const list = await mine();
    expect(list.status).toBe(200);
    expect(list.body).toEqual(expect.objectContaining({ total: 2, page: 1, pageSize: 10 }));
    expect(list.body.items.map((item: any) => [item.txnType, item.status, item.amount])).toEqual([['WITHDRAWAL', 'FAILED', '1000000.00'], ['DEPOSIT', 'SUCCESS', '5000000.00']]);
    expect((await mine('?type=DEPOSIT')).body.items).toHaveLength(1);
    expect((await mine('?status=FAILED')).body.items).toHaveLength(1);
    expect((await mine('?pageSize=1&page=2')).body.items[0].txnType).toBe('DEPOSIT');
  });

  test('history defaults to the last 30 days and honours from/to in Vietnam dates', async () => {
    await fund(api, '1000000');
    api.tick(31 * 86_400_000);
    expect((await mine()).body.total).toBe(0);
    expect((await mine('?from=2026-01-15&to=2026-01-15')).body.total).toBe(1);
    expect((await mine('?from=2026-01-16')).body.total).toBe(0);
  });

  test('invalid filters are 400', async () => {
    for (const query of ['?type=X', '?status=X', '?from=2026-13-01', '?pageSize=101', '?page=0', '?to=abc']) expectApiError(await mine(query), 400, 'VALIDATION_ERROR');
  });

  test('the detail shows ledger entries; someone else\'s transaction is 403 with DENIED', async () => {
    const { created } = await placeOrder(api, 'deposits', '1000000');
    const detail = await api.request(`/me/cash-transactions/${created.txnId}`, { token: await api.tokenFor(CUSTOMER) });
    expect(detail.status).toBe(200);
    expect(detail.body.entries).toHaveLength(2);
    expect(detail.body.entries).toEqual(expect.arrayContaining([expect.objectContaining({ side: 'CREDIT', amount: '1000000.00', accountType: 'CUSTOMER_INVESTMENT', balanceAfter: '1000000.00', reversalOf: null })]));
    await registerCustomer(api, { cifId: actors.otherCustomer.cifId, actorId: actors.otherCustomer.actorId, key: 'other' });
    expectApiError(await api.request(`/me/cash-transactions/${created.txnId}`, { token: await api.tokenFor(actors.otherCustomer.actorId) }), 403, 'FORBIDDEN');
    expect((await audit(api, 'CASH_HISTORY_VIEW')).map(row => row.outcome)).toContain('DENIED');
    expectApiError(await api.request('/me/cash-transactions/00000000-0000-4000-8000-000000000000', { token: await api.tokenFor(CUSTOMER) }), 404, 'NOT_FOUND');
  });

  test('the assigned RM and the team leader read history with an audit row; the former RM is 403 with DENIED', async () => {
    const { created } = await placeOrder(api, 'deposits', '1000000');
    const rm = await api.tokenFor();
    const list = await api.request(`/customers/${customerId}/cash-transactions`, { token: rm });
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect((await api.request(`/customers/${customerId}/cash-transactions/${created.txnId}`, { token: rm })).body.entries).toHaveLength(2);
    expect((await api.request(`/customers/${customerId}/cash-transactions`, { token: await api.tokenFor(actors.leader.actorId) })).status).toBe(200);
    const viewed = await audit(api, 'CASH_HISTORY_VIEW');
    expect(viewed.filter(row => row.outcome === 'SUCCESS').map(row => row.actor_id)).toEqual([actors.rm.actorId, actors.rm.actorId, actors.leader.actorId]);
    await insertStaff(viaDataSource(api.dataSource), staff.foreign);
    expectApiError(await api.request(`/customers/${customerId}/cash-transactions`, { token: await api.tokenFor(staff.foreign.actorId) }), 403, 'FORBIDDEN');
    expect((await audit(api, 'CASH_HISTORY_VIEW')).at(-1)).toEqual(expect.objectContaining({ outcome: 'DENIED', actor_id: staff.foreign.actorId }));
  });

  test('a transaction of another customer is not reachable through the staff route', async () => {
    const { created } = await placeOrder(api, 'deposits', '1000000');
    const other = await registerCustomer(api, { cifId: actors.otherCustomer.cifId, actorId: actors.otherCustomer.actorId, key: 'other' }) as any;
    expectApiError(await api.request(`/customers/${other.customerId}/cash-transactions/${created.txnId}`, { token: await api.tokenFor() }), 404, 'NOT_FOUND');
  });

  test('back-office searches by CIF, type and status with an audit row; others are refused', async () => {
    const { created } = await placeOrder(api, 'deposits', '1000000');
    const token = await insertBackOffice(api);
    const list = await api.request(`/back-office/cash-transactions?cifId=${CUSTOMER}&type=DEPOSIT&status=SUCCESS`, { token });
    expect(list.status).toBe(200);
    expect(list.body.items.map((item: any) => item.txnId)).toEqual([created.txnId]);
    expect((await api.request('/back-office/cash-transactions?cifId=CIF000000', { token })).body.total).toBe(0);
    expect((await api.request(`/back-office/cash-transactions/${created.txnId}`, { token })).body.entries).toHaveLength(2);
    expect((await audit(api, 'CASH_HISTORY_VIEW')).map(row => row.actor_role)).toContain('BACK_OFFICE');
    expectApiError(await api.request('/back-office/cash-transactions', { token: await api.tokenFor() }), 403, 'FORBIDDEN');
  });

  test('there is no route to edit or delete a transaction', async () => {
    const { created } = await placeOrder(api, 'deposits', '1000000');
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      expect((await api.request(`/me/cash-transactions/${created.txnId}`, { method, token: await api.tokenFor(CUSTOMER) })).status).toBe(404);
    }
  });

  test('the result feed shows finished transactions newest first, not open ones', async () => {
    await fund(api, '5000000');
    api.tick();
    await createOrder(api, 'deposits', '1000000');
    api.state.corePosting = async () => ({ outcome: 'REJECTED', reason: 'x' });
    api.tick();
    await placeOrder(api, 'withdrawals', '2000000');
    const feed = await api.request('/me/cash-notifications', { token: await api.tokenFor(CUSTOMER) });
    expect(feed.status).toBe(200);
    expect(feed.body.items.map((item: any) => [item.txnType, item.status, item.failureReason])).toEqual([['WITHDRAWAL', 'FAILED', 'CORE_REJECTED'], ['DEPOSIT', 'SUCCESS', null]]);
    expect(feed.body.items[0].completedAt).toEqual(expect.any(String));
  });
});

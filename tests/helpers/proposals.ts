import { expect } from 'vitest';
import { activeCustomer, CUSTOMER, nextKey } from './cash.js';
import type { Api } from './cash.js';
import { RM, staffTokens } from './portfolio.js';

export interface Leg { action: 'BUY' | 'SELL' | 'OPEN' | 'SETTLE'; assetId?: string; holdingId?: string; quantity?: string; amount?: string }

/** A BALANCED customer (maximum product risk 3) of the fixture RM, with back-office and manager tokens for products and prices. */
export async function proposalCustomer(api: Api) {
  const { customerId } = await activeCustomer(api);
  return { customerId, ...await staffTokens(api) };
}

export const propose = async (api: Api, customerId: string, legs: Leg[], extra: Record<string, unknown> = {}, key = nextKey('proposal'), actor = RM) =>
  api.request(`/customers/${customerId}/proposals`, { method: 'POST', token: await api.tokenFor(actor), key, body: { legs, ...extra } });

export async function created(api: Api, customerId: string, legs: Leg[], extra: Record<string, unknown> = {}) {
  const response = await propose(api, customerId, legs, extra);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body as { proposalId: string; proposalCode: string; status: string; legs: Array<Record<string, unknown>> };
}

export const challenge = async (api: Api, proposalId: string, key = nextKey('challenge')) =>
  api.request(`/me/proposals/${proposalId}/approval-challenge`, { method: 'POST', token: await api.tokenFor(CUSTOMER), key });

export const codeOf = (api: Api, challengeId: string) => api.deliveries.find(item => item.challengeId === challengeId)!.code;
export const wrongCode = (code: string) => (code === '000000' ? '000001' : '000000');

export const approve = async (api: Api, proposalId: string, challengeId: string, code: string, key = nextKey('approve')) =>
  api.request(`/me/proposals/${proposalId}/approve`, { method: 'POST', token: await api.tokenFor(CUSTOMER), key, body: { challengeId, code } });

/** Challenge plus the right code; asserts the challenge was issued. */
export async function approveNow(api: Api, proposalId: string) {
  const issued = await challenge(api, proposalId);
  expect(issued.status, JSON.stringify(issued.body)).toBe(201);
  return approve(api, proposalId, issued.body.challengeId, codeOf(api, issued.body.challengeId));
}

export const cancel = async (api: Api, proposalId: string, reason = 'Khách hàng yêu cầu thay đổi tỷ trọng', actor = RM) =>
  api.request(`/proposals/${proposalId}/cancel`, { method: 'POST', token: await api.tokenFor(actor), key: nextKey('cancel'), body: { reason } });

export const reject = async (api: Api, proposalId: string, reason = 'Chưa phù hợp thời điểm') =>
  api.request(`/me/proposals/${proposalId}/reject`, { method: 'POST', token: await api.tokenFor(CUSTOMER), key: nextKey('reject'), body: { reason } });

export const proposalRow = async (api: Api, proposalId: string) => (await api.dataSource.query(
  `SELECT status::text AS status,failure_reason,cancel_reason,rejection_reason,drift_alert_id,otp_auth_ref,approved_at,executed_at,closed_at
   FROM wms.proposals WHERE proposal_id=$1`, [proposalId]))[0] as Record<string, any>;

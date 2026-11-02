import { expect } from 'vitest';
import { actors } from './actors.js';
import type { startApiFixture } from './application.js';
import { eligibleCustomer } from './application.js';

type Api = Awaited<ReturnType<typeof startApiFixture>>;

/** UC-01 through the public API (RM invites, customer consents with OTP). Used by the R9 specs; older specs keep their own copies. */
export async function registerCustomer(api: Api, input: { cifId?: string; actorId?: string; rmActorId?: string; key?: string } = {}) {
  const cifId = input.cifId ?? actors.customer.cifId;
  const actorId = input.actorId ?? actors.customer.actorId;
  const created = await api.request('/onboarding/requests', { method: 'POST', token: await api.tokenFor(input.rmActorId ?? actors.rm.actorId),
    key: input.key ?? `r9-invite-${cifId}`, body: { cifRef: cifId, selectedCasaNo: eligibleCustomer(cifId).accounts[0].id } });
  expect(created.status).toBe(201);
  const customerToken = await api.tokenFor(actorId);
  const challenge = await api.request('/otp/challenges', { method: 'POST', token: customerToken, body: { purpose: 'SERVICE_CONSENT', operationId: created.body.requestId } });
  expect(challenge.status).toBe(201);
  const otp = api.deliveries.find(item => item.challengeId === challenge.body.challengeId)!;
  const accepted = await api.request(`/me/onboarding-requests/${created.body.requestId}/confirm`, { method: 'POST', token: customerToken,
    key: `r9-consent-${cifId}`, body: { challengeId: otp.challengeId, code: otp.code } });
  expect(accepted.status).toBe(200);
  return { request: created.body, challenge: challenge.body, otp, ...accepted.body } as { request: any; challenge: any; otp: typeof otp; customerId: string; serviceId: string; accountId: string };
}

/** A draft with every question answered with the option at `optionIndex` (0 => score 10, 4 => score 50). */
export async function createDraft(api: Api, actorId: string, optionIndex: number, key: string) {
  const token = await api.tokenFor(actorId);
  const questionnaire = await api.request('/risk-questionnaires/current', { token });
  expect(questionnaire.status).toBe(200);
  const draft = await api.request('/me/risk-assessments', { method: 'POST', token, key, body: {
    questionnaireVersion: questionnaire.body.version,
    answers: questionnaire.body.questions.map((question: any) => ({ questionId: question.id, optionId: question.options[optionIndex].id })) } });
  expect(draft.status).toBe(201);
  return draft.body;
}

export async function confirmRisk(api: Api, actorId: string, optionIndex: number, expectedVersion: number, key: string) {
  const token = await api.tokenFor(actorId);
  const draft = await createDraft(api, actorId, optionIndex, `${key}-draft`);
  const challenge = await api.request('/otp/challenges', { method: 'POST', token, body: { purpose: 'RISK_PROFILE_CONFIRM', operationId: draft.draftId } });
  expect(challenge.status).toBe(201);
  const otp = api.deliveries.find(item => item.challengeId === challenge.body.challengeId)!;
  const confirmed = await api.request(`/me/risk-assessments/${draft.draftId}/confirm`, { method: 'POST', token, key: `${key}-confirm`,
    body: { challengeId: otp.challengeId, code: otp.code, expectedCurrentProfileVersion: expectedVersion } });
  expect(confirmed.status).toBe(200);
  return confirmed.body;
}

export const wrongCode = (code: string) => (code === '000000' ? '000001' : '000000');

import { ApiProperty } from '@nestjs/swagger';
import { ApiError } from '../../platform/http.js';
import { text, uuid } from '../../platform/validation.js';

export interface RiskAnswer { questionId: string; optionId: string; }
export interface RiskQuestion { id: string; text: string; options: Array<{ id: string; text: string; points: number }>; }
export type RiskCategory = 'CONSERVATIVE' | 'BALANCED' | 'GROWTH';
export interface RiskResult {
  score: number; category: RiskCategory; maxProductRisk: number;
  allocation: { cash: number; deposit: number; bond: number; fund: number };
}
export interface RiskDraftRow {
  id: string; customer_id: string; questionnaire_version: string; answers: RiskAnswer[];
  score: number; category: RiskCategory; max_product_risk: number; allocation: RiskResult['allocation'];
  expected_current_profile_version: number; payload_hash: string; created_at: Date; expires_at: Date;
}
export interface RiskProfileRow extends Omit<RiskDraftRow, 'expected_current_profile_version' | 'created_at'> {
  draft_id: string; version: number; confirmed_at: Date; otp_receipt_ref: string;
}

function validAnswers(value: unknown): boolean {
  return Array.isArray(value) && value.length === 10 && value.every(answer =>
    answer && typeof answer === 'object' && !Array.isArray(answer)
    && Object.keys(answer).length === 2 && text(answer.questionId) && text(answer.optionId)
    && Object.hasOwn(answer, 'questionId') && Object.hasOwn(answer, 'optionId'));
}

export class RiskDraftBody {
  static readonly fields = { questionnaireVersion: text, answers: validAnswers };
  @ApiProperty() questionnaireVersion!: string;
  @ApiProperty({ type: 'array', items: { type: 'object', required: ['questionId', 'optionId'], additionalProperties: false,
    properties: { questionId: { type: 'string' }, optionId: { type: 'string' } } } }) answers!: RiskAnswer[];
}
export class RiskConfirmBody {
  static readonly fields = { challengeId: uuid, code: (value: unknown) => typeof value === 'string' && /^\d{6}$/.test(value),
    expectedCurrentProfileVersion: (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 };
  @ApiProperty({ format: 'uuid' }) challengeId!: string;
  @ApiProperty({ pattern: '^\\d{6}$' }) code!: string;
  @ApiProperty({ minimum: 0 }) expectedCurrentProfileVersion!: number;
}

export function scoreAnswers(questions: RiskQuestion[], answers: RiskAnswer[]): RiskResult {
  const seen = new Set<string>();
  let score = 0;
  for (const answer of answers) {
    const question = questions.find(item => item.id === answer.questionId);
    const option = question?.options.find(item => item.id === answer.optionId);
    if (!option || seen.has(answer.questionId)) throw new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed');
    seen.add(answer.questionId);
    score += option.points;
  }
  if (answers.length !== questions.length || score < 10 || score > 50) throw new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed');
  if (score <= 20) return { score, category: 'CONSERVATIVE', maxProductRisk: 2, allocation: { cash: 10, deposit: 50, bond: 30, fund: 10 } };
  if (score <= 35) return { score, category: 'BALANCED', maxProductRisk: 3, allocation: { cash: 5, deposit: 30, bond: 30, fund: 35 } };
  return { score, category: 'GROWTH', maxProductRisk: 5, allocation: { cash: 5, deposit: 15, bond: 20, fund: 60 } };
}

export function draftProjection(row: RiskDraftRow) {
  return { id: row.id, questionnaireVersion: row.questionnaire_version, answers: row.answers,
    score: row.score, category: row.category, maxProductRisk: row.max_product_risk, allocation: row.allocation,
    expectedCurrentProfileVersion: row.expected_current_profile_version, payloadHash: row.payload_hash,
    expiresAt: new Date(row.expires_at).toISOString() };
}

export function profileProjection(row: RiskProfileRow, now: Date) {
  return { id: row.id, draftId: row.draft_id, customerId: row.customer_id, version: row.version,
    questionnaireVersion: row.questionnaire_version, answers: row.answers, score: row.score, category: row.category,
    maxProductRisk: row.max_product_risk, allocation: row.allocation,
    confirmedAt: new Date(row.confirmed_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString(),
    valid: now.getTime() < new Date(row.expires_at).getTime() };
}

/** Calendar expiry is UTC, with leap-day/month-end clamped to the destination month. */
export function profileExpiry(confirmedAt: Date): Date {
  const expiry = new Date(confirmedAt);
  const day = expiry.getUTCDate();
  expiry.setUTCDate(1);
  expiry.setUTCFullYear(expiry.getUTCFullYear() + 1);
  const lastDay = new Date(Date.UTC(expiry.getUTCFullYear(), expiry.getUTCMonth() + 1, 0)).getUTCDate();
  expiry.setUTCDate(Math.min(day, lastDay));
  return expiry;
}

export function riskDraftUnexpired(draft: RiskDraftRow, now: Date): void {
  if (now.getTime() >= new Date(draft.expires_at).getTime()) throw new ApiError(410, 'RISK_DRAFT_EXPIRED', 'Risk preview expired');
}

export function riskPaging(page: string | undefined, pageSize: string | undefined) {
  const parse = (value: string | undefined, fallback: number, maximum: number) => {
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > maximum) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed');
    }
    return Number(value);
  };
  return { page: parse(page, 1, 1_000_000), pageSize: parse(pageSize, 10, 100) };
}

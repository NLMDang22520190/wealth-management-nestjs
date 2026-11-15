import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApiError } from '../../platform/http.js';
import { text, uuid } from '../../platform/validation.js';

export type LegAction = 'BUY' | 'SELL' | 'OPEN' | 'SETTLE';
export interface LegInput { action: LegAction; assetId?: string; holdingId?: string; quantity?: string; amount?: string }

export const OTP_PURPOSE = 'PROPOSAL_APPROVAL';
/** BR-22, in percent. */
export const SLIPPAGE_LIMIT = '5';
/** UC-15 exception 4: wrong codes allowed per challenge. */
export const MAX_OTP_ATTEMPTS = 3;
export const PROPOSAL_TTL_MS = 24 * 3_600_000;
export const STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'EXECUTING', 'EXECUTED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED'];
export const SALES: LegAction[] = ['SELL', 'SETTLE'];

const QUANTITY = /^\d{1,14}(\.\d{1,6})?$/;
const MONEY = /^\d{1,18}(\.\d{1,2})?$/;
const positive = (pattern: RegExp) => (value: unknown) => typeof value === 'string' && pattern.test(value) && /[1-9]/.test(value);
const FIELDS: Record<LegAction, Record<string, (value: unknown) => boolean>> = {
  BUY: { assetId: uuid, quantity: positive(QUANTITY) },
  SELL: { holdingId: uuid, quantity: positive(QUANTITY) },
  OPEN: { assetId: uuid, amount: positive(MONEY) },
  SETTLE: { holdingId: uuid },
};

/** Each leg carries exactly the fields of its action; a holding appears once, and a deposit product is opened once (one open deposit per product and day). */
function legsRule(value: unknown): boolean {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return false;
  const holdings = new Set<string>();
  const opened = new Set<string>();
  for (const leg of value) {
    if (!leg || typeof leg !== 'object' || Array.isArray(leg)) return false;
    const { action, ...rest } = leg as Record<string, unknown>;
    const fields = FIELDS[action as LegAction];
    if (!fields) return false;
    const keys = Object.keys(rest);
    if (keys.length !== Object.keys(fields).length || keys.some(key => !fields[key]?.(rest[key]))) return false;
    if (typeof rest.holdingId === 'string') {
      if (holdings.has(rest.holdingId)) return false;
      holdings.add(rest.holdingId);
    }
    if (action === 'OPEN') {
      if (opened.has(rest.assetId as string)) return false;
      opened.add(rest.assetId as string);
    }
  }
  return true;
}
const between = (minimum: number, maximum: number) => (value: unknown) => text(value) && (value as string).trim().length >= minimum && (value as string).trim().length <= maximum;
const optional = (rule: (value: unknown) => boolean) => (value: unknown) => value === undefined || rule(value);

export class CreateProposalBody {
  static readonly fields = { legs: legsRule, note: optional(between(1, 500)), driftAlertId: optional(uuid) };
  @ApiProperty({ description: 'BUY {assetId, quantity}, SELL {holdingId, quantity}, OPEN {assetId, amount}, SETTLE {holdingId}; 1 to 20 legs.' }) legs!: LegInput[];
  @ApiPropertyOptional({ maxLength: 500 }) note?: string;
  @ApiPropertyOptional({ format: 'uuid', description: 'The drift alert this proposal answers (UC-12).' }) driftAlertId?: string;
}
export class CancelProposalBody {
  static readonly fields = { reason: between(10, 255) };
  @ApiProperty({ minLength: 10, maxLength: 255 }) reason!: string;
}
export class RejectProposalBody {
  static readonly fields = { reason: between(1, 500) };
  @ApiProperty({ maxLength: 500 }) reason!: string;
}
export class ApproveProposalBody {
  static readonly fields = { challengeId: uuid, code: (value: unknown) => typeof value === 'string' && /^\d{6}$/.test(value) };
  @ApiProperty({ format: 'uuid' }) challengeId!: string;
  @ApiProperty({ pattern: '^\\d{6}$' }) code!: string;
}

export const invalid = () => new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed');
export const notFound = () => new ApiError(404, 'NOT_FOUND', 'Resource not found');
export const forbidden = () => new ApiError(403, 'FORBIDDEN', 'Access denied');
export const legError = (status: number, code: string, message: string, details: Record<string, unknown>) => new ApiError(status, code, message, details);

export function parseStatus(raw: Record<string, unknown>): string | undefined {
  const status = raw.status;
  if (status === undefined) return undefined;
  if (typeof status !== 'string' || !STATUSES.includes(status)) throw invalid();
  return status;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApiError } from '../../platform/http.js';
import type { AuditContext } from '../../platform/http.js';
import { text, uuid } from '../../platform/validation.js';

/** Money is handled as integer cents in BigInt: `money_vnd` is NUMERIC(20,2) and JS floats never touch amounts. */
const AMOUNT = /^\d{1,18}(\.\d{1,2})?$/;
export const MIN_CASH_CENTS = 100_000_000n;
export const DAILY_LIMIT_CENTS = 200_000_000_000n;

export function toCents(amount: string): bigint {
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
}
export function formatCents(cents: bigint): string {
  const digits = cents.toString().padStart(3, '0');
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

const amountRule = (value: unknown) => typeof value === 'string' && AMOUNT.test(value);
const casaRule = (value: unknown) => text(value) && (value as string).length <= 30;

export class DepositBody {
  static readonly fields = { sourceCasaNo: casaRule, amount: amountRule };
  @ApiProperty({ description: 'Own active VND CASA number.' }) sourceCasaNo!: string;
  @ApiProperty({ example: '5000000', description: 'Decimal string, at most 2 decimals.' }) amount!: string;
}
export class WithdrawalBody {
  static readonly fields = { destCasaNo: casaRule, amount: amountRule };
  @ApiProperty({ description: 'Own active VND CASA number.' }) destCasaNo!: string;
  @ApiProperty({ example: '5000000', description: 'Decimal string, at most 2 decimals.' }) amount!: string;
}
export class CashConfirmBody {
  static readonly fields = { challengeId: uuid, code: (value: unknown) => typeof value === 'string' && /^\d{6}$/.test(value) };
  @ApiProperty({ format: 'uuid' }) challengeId!: string;
  @ApiProperty({ pattern: '^\\d{6}$' }) code!: string;
}
export class ResolveBody {
  static readonly fields = {
    outcome: (value: unknown) => value === 'SUCCESS' || value === 'FAILED',
    note: (value: unknown) => text(value) && (value as string).length <= 500,
  };
  @ApiProperty({ enum: ['SUCCESS', 'FAILED'] }) outcome!: 'SUCCESS' | 'FAILED';
  @ApiProperty({ maxLength: 500 }) note!: string;
}
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
export class MaturityJobBody {
  static readonly fields = { asOf: (value: unknown) => value === undefined || isCalendarDate(value) };
  @ApiPropertyOptional({ description: 'Demo only: run as if today were this date (YYYY-MM-DD).' }) asOf?: string;
}

export type OrderType = 'DEPOSIT' | 'WITHDRAWAL';
export const ORDER = {
  DEPOSIT: { prefix: 'DEP', action: 'CASH_DEPOSIT', otpPurpose: 'DEPOSIT' },
  WITHDRAWAL: { prefix: 'WDR', action: 'CASH_WITHDRAWAL', otpPurpose: 'WITHDRAWAL' },
} as const;

/** Business rules use the Vietnam calendar day. */
export function vietnamDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function vietnamMinutesOfDay(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  return Number(parts.find(part => part.type === 'hour')!.value) * 60 + Number(parts.find(part => part.type === 'minute')!.value);
}
export const startOfVietnamDay = (date: string) => new Date(`${date}T00:00:00.000+07:00`);
export const endOfVietnamDay = (date: string) => new Date(startOfVietnamDay(date).getTime() + 86_400_000);

/** Audit context of work that no HTTP request started. */
export const JOB_CONTEXT: AuditContext = { requestId: '', ip: '', device: '', deviceId: null };
export const RECONCILIATION_ACTOR = { actorId: 'reconciliation-job', role: 'SYSTEM_JOB' } as const;
export const MATURITY_ACTOR = { actorId: 'maturity-job', role: 'SYSTEM_JOB' } as const;

export const MAX_RECONCILIATION_ROUNDS = 3;
export const notFound = () => new ApiError(404, 'NOT_FOUND', 'Resource not found');
export const forbidden = () => new ApiError(403, 'FORBIDDEN', 'Access denied');

export interface HistoryQuery {
  page: number; pageSize: number; type?: string; status?: string; from?: Date; to?: Date; cifId?: string; needsReview: boolean;
}
const TXN_TYPES = ['DEPOSIT', 'WITHDRAWAL', 'MATURITY_SETTLEMENT'];
const TXN_STATUSES = ['INIT', 'PENDING', 'SUCCESS', 'FAILED'];
const invalid = () => new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed');

function single(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalid();
  return value;
}
function positive(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!/^\d{1,9}$/.test(value) || Number(value) < 1 || Number(value) > maximum) throw invalid();
  return Number(value);
}
function date(value: string | undefined): string | undefined {
  if (value !== undefined && !isCalendarDate(value)) throw invalid();
  return value;
}

/** Only whitelisted keys are read; scope never comes from the query. */
export function parseHistoryQuery(raw: Record<string, unknown>): HistoryQuery {
  const type = single(raw.type);
  if (type !== undefined && !TXN_TYPES.includes(type)) throw invalid();
  const status = single(raw.status);
  if (status !== undefined && !TXN_STATUSES.includes(status)) throw invalid();
  const from = date(single(raw.from));
  const to = date(single(raw.to));
  const cifId = single(raw.cifId);
  if (cifId !== undefined && (cifId.length === 0 || cifId.length > 30)) throw invalid();
  const needsReview = single(raw.needsReview);
  if (needsReview !== undefined && needsReview !== 'true' && needsReview !== 'false') throw invalid();
  return { page: positive(single(raw.page), 1, 1_000_000), pageSize: positive(single(raw.pageSize), 10, 100), needsReview: needsReview === 'true',
    ...(type ? { type } : {}), ...(status ? { status } : {}), ...(cifId ? { cifId } : {}),
    ...(from ? { from: startOfVietnamDay(from) } : {}), ...(to ? { to: endOfVietnamDay(to) } : {}) };
}

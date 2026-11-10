import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApiError } from '../../platform/http.js';
import { text, uuid } from '../../platform/validation.js';
import { isCalendarDate } from '../accounts-ledger/cash.domain.js';

export type AssetClass = 'TERM_DEPOSIT' | 'BOND' | 'MUTUAL_FUND';
export type PriceType = 'NAV' | 'BOND_PRICE' | 'INTEREST_RATE';
export const ASSET_CLASSES: AssetClass[] = ['TERM_DEPOSIT', 'BOND', 'MUTUAL_FUND'];
const ASSET_STATUSES = ['ON_SALE', 'DISCONTINUED'];
const FUND_TYPES = ['MONEY_MARKET', 'BOND', 'BALANCED', 'EQUITY'];
export const PRICE_TYPE: Record<AssetClass, PriceType> = { TERM_DEPOSIT: 'INTEREST_RATE', BOND: 'BOND_PRICE', MUTUAL_FUND: 'NAV' };

export const invalid = () => new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed');
export const assetNotFound = () => new ApiError(404, 'ASSET_NOT_FOUND', 'Product not found');

const MONEY = /^\d{1,18}(\.\d{1,2})?$/;
const PRICE = /^\d{1,16}(\.\d{1,4})?$/;
const RATE = /^\d{1,3}(\.\d{1,4})?$/;
const hasValue = (value: string) => /[1-9]/.test(value);
const matching = (pattern: RegExp) => (value: unknown) => typeof value === 'string' && pattern.test(value);
const positive = (pattern: RegExp) => (value: unknown) => typeof value === 'string' && pattern.test(value) && hasValue(value);
const limited = (maximum: number) => (value: unknown) => text(value) && (value as string).length <= maximum;
const optional = (rule: (value: unknown) => boolean) => (value: unknown) => value === undefined || rule(value);
const riskLevel = (value: unknown) => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 5;

export const priceRule = positive(PRICE);
export const dateRule = isCalendarDate;

export class CreateAssetBody {
  static readonly fields = {
    assetClass: (value: unknown) => ASSET_CLASSES.includes(value as AssetClass),
    assetCode: limited(30), assetName: limited(200), riskLevel,
    minInvestment: optional(matching(MONEY)),
    termMonths: optional(value => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 600),
    interestRate: optional(positive(RATE)),
    faceValue: optional(positive(MONEY)), couponRate: optional(matching(RATE)), issueDate: optional(dateRule), maturityDate: optional(dateRule), issuer: optional(limited(200)),
    fundType: optional(value => FUND_TYPES.includes(value as string)), fundManager: optional(limited(200)),
    initialPrice: optional(priceRule),
  };
  @ApiProperty({ enum: ASSET_CLASSES }) assetClass!: AssetClass;
  @ApiProperty({ maxLength: 30 }) assetCode!: string;
  @ApiProperty({ maxLength: 200 }) assetName!: string;
  @ApiProperty({ minimum: 1, maximum: 5 }) riskLevel!: number;
  @ApiPropertyOptional({ example: '1000000' }) minInvestment?: string;
  @ApiPropertyOptional({ description: 'TERM_DEPOSIT' }) termMonths?: number;
  @ApiPropertyOptional({ description: 'TERM_DEPOSIT: % per year' }) interestRate?: string;
  @ApiPropertyOptional({ description: 'BOND' }) faceValue?: string;
  @ApiPropertyOptional({ description: 'BOND: % per year' }) couponRate?: string;
  @ApiPropertyOptional({ description: 'BOND' }) issueDate?: string;
  @ApiPropertyOptional({ description: 'BOND' }) maturityDate?: string;
  @ApiPropertyOptional({ description: 'BOND' }) issuer?: string;
  @ApiPropertyOptional({ enum: FUND_TYPES, description: 'MUTUAL_FUND' }) fundType?: string;
  @ApiPropertyOptional({ description: 'MUTUAL_FUND' }) fundManager?: string;
  @ApiPropertyOptional({ description: 'BOND or MUTUAL_FUND: starting reference price or NAV' }) initialPrice?: string;
}

const CLASS_FIELDS: Record<AssetClass, { required: Array<keyof CreateAssetBody>; optional: Array<keyof CreateAssetBody> }> = {
  TERM_DEPOSIT: { required: ['termMonths', 'interestRate'], optional: [] },
  BOND: { required: ['faceValue', 'couponRate', 'maturityDate', 'issuer'], optional: ['issueDate', 'initialPrice'] },
  MUTUAL_FUND: { required: ['fundType', 'fundManager'], optional: ['initialPrice'] },
};
const COMMON_FIELDS = ['assetClass', 'assetCode', 'assetName', 'riskLevel', 'minInvestment'];

/** Each class takes its own fields only, so a mistyped form cannot silently drop what it sent. */
export function assertClassFields(body: CreateAssetBody): void {
  const allowed = CLASS_FIELDS[body.assetClass];
  if (allowed.required.some(field => body[field] === undefined)) throw invalid();
  const known = new Set<string>([...COMMON_FIELDS, ...allowed.required, ...allowed.optional]);
  if (Object.keys(body).some(field => !known.has(field))) throw invalid();
  if (body.issueDate && body.maturityDate && body.issueDate >= body.maturityDate) throw invalid();
}

export class AssetStatusBody {
  static readonly fields = { status: (value: unknown) => ASSET_STATUSES.includes(value as string) };
  @ApiProperty({ enum: ASSET_STATUSES }) status!: 'ON_SALE' | 'DISCONTINUED';
}
export class AssetRiskBody {
  static readonly fields = { riskLevel };
  @ApiProperty({ minimum: 1, maximum: 5 }) riskLevel!: number;
}
export class PriceBody {
  static readonly fields = { assetId: uuid, value: priceRule, effectiveDate: optional(dateRule) };
  @ApiProperty({ format: 'uuid' }) assetId!: string;
  @ApiProperty({ example: '12790.5', description: 'Greater than 0, at most 4 decimals. An interest rate is % per year.' }) value!: string;
  @ApiPropertyOptional({ description: 'YYYY-MM-DD, not in the future; today (Vietnam) by default.' }) effectiveDate?: string;
}
export class PriceImportBody {
  static readonly fields = { csv: (value: unknown) => typeof value === 'string' && value.length <= 100_000 };
  @ApiProperty({ description: 'Header assetCode,value,effectiveDate then at most 500 rows.' }) csv!: string;
}
export class PriceDecisionBody {
  static readonly fields = { reason: limited(500) };
  @ApiProperty({ maxLength: 500 }) reason!: string;
}
export class SnapshotJobBody {
  static readonly fields = { asOf: optional(dateRule) };
  @ApiPropertyOptional({ description: 'Demo only: run as if today were this date (YYYY-MM-DD).' }) asOf?: string;
}

export interface CsvRow { line: number; assetCode: string; value: string; effectiveDate: string; }
const CSV_HEADER = 'assetCode,value,effectiveDate';
const MAX_CSV_ROWS = 500;

/** A wrong header or too many rows refuses the file; one bad value is reported on its own row by the service. */
export function parsePriceCsv(csv: string): CsvRow[] {
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== CSV_HEADER) throw invalid();
  const rows: CsvRow[] = [];
  lines.slice(1).forEach((line, index) => {
    if (line.trim() === '') return;
    const [assetCode = '', value = '', effectiveDate = ''] = line.split(',').map(cell => cell.trim());
    rows.push({ line: index + 2, assetCode, value, effectiveDate });
  });
  if (rows.length > MAX_CSV_ROWS) throw invalid();
  return rows;
}

function single(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalid();
  return value;
}
function bounded(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!/^\d{1,9}$/.test(value) || Number(value) < 1 || Number(value) > maximum) throw invalid();
  return Number(value);
}

export interface AssetQuery { page: number; pageSize: number; assetClass?: string; status?: string; q?: string; }
export function parseAssetQuery(raw: Record<string, unknown>): AssetQuery {
  const assetClass = single(raw.assetClass);
  if (assetClass !== undefined && !ASSET_CLASSES.includes(assetClass as AssetClass)) throw invalid();
  const status = single(raw.status);
  if (status !== undefined && !ASSET_STATUSES.includes(status)) throw invalid();
  const q = single(raw.q);
  if (q !== undefined && q.length > 100) throw invalid();
  return { page: bounded(single(raw.page), 1, 1_000_000), pageSize: bounded(single(raw.pageSize), 20, 100),
    ...(assetClass ? { assetClass } : {}), ...(status ? { status } : {}), ...(q ? { q } : {}) };
}
export const parseHistoryDays = (raw: Record<string, unknown>) => bounded(single(raw.days), 90, 365);

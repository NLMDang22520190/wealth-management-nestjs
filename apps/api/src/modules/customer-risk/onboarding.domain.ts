import { ApiProperty } from '@nestjs/swagger';
import type { Actor } from '../../auth/actor.js';
import { ApiError } from '../../platform/http.js';
import { hash } from '../../platform/transactions.js';
import { text, uuid } from '../../platform/validation.js';

export interface CoreCustomer {
  cifId: string; name: string; dateOfBirth: string; active: boolean; kycVerified: boolean;
  accounts: Array<{ id: string; ownerCifId: string; currency: string; active: boolean }>;
}
export interface CoreBanking { lookup(reference: string): Promise<CoreCustomer | null>; }

export interface OnboardingRequest {
  id: string; cif_id: string; customer_name: string; selected_account_id: string; rm_id: string; team_id: string;
  status: string; terms_version: string; terms_hash: string; expires_at: Date;
}

export class CustomerLookupBody {
  static readonly fields = { cifRef: text };
  @ApiProperty({ description: 'Core banking customer reference; resolved by the server.' }) cifRef!: string;
}
export class OnboardingRequestBody extends CustomerLookupBody {
  static readonly fields = { cifRef: text, selectedAccountId: text };
  @ApiProperty({ description: 'An active VND account owned by this CIF, supplied by Core lookup.' }) selectedAccountId!: string;
}
export class ConsentBody {
  static readonly fields = { challengeId: uuid, code: (value: unknown) => typeof value === 'string' && /^\d{6}$/.test(value) };
  @ApiProperty({ format: 'uuid' }) challengeId!: string;
  @ApiProperty({ pattern: '^\\d{6}$', description: 'Code from the delivery channel.' }) code!: string;
}

export function eligibleAccounts(customer: CoreCustomer) {
  return customer.accounts.filter(account => account.ownerCifId === customer.cifId && account.currency === 'VND' && account.active);
}

export function isEligible(customer: CoreCustomer, now: Date): boolean {
  const birth = /^(\d{4})-(\d{2})-(\d{2})$/.exec(customer.dateOfBirth);
  if (!birth) return false;
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const year = parts.find(part => part.type === 'year')!.value;
  const month = parts.find(part => part.type === 'month')!.value;
  const day = parts.find(part => part.type === 'day')!.value;
  const eighteenthBirthday = `${Number(birth[1]) + 18}-${birth[2]}-${birth[3]}`;
  return customer.active && customer.kycVerified && `${year}-${month}-${day}` >= eighteenthBirthday && eligibleAccounts(customer).length > 0;
}

export function ownRequest(request: OnboardingRequest | undefined, actor: Actor): asserts request is OnboardingRequest {
  if (!request) throw new ApiError(404, 'NOT_FOUND', 'Resource not found');
  if (actor.role !== 'CUSTOMER' || actor.cifId !== request.cif_id) throw new ApiError(403, 'FORBIDDEN', 'Access denied');
}

export function requireUnexpired(request: OnboardingRequest, now: Date): void {
  if (request.status === 'EXPIRED' || new Date(request.expires_at).getTime() <= now.getTime()) {
    throw new ApiError(410, 'ONBOARDING_EXPIRED', 'Registration request expired');
  }
}

export function consentPayloadHash(request: OnboardingRequest): string {
  return hash(JSON.stringify([request.id, request.cif_id, request.selected_account_id, request.terms_version, request.terms_hash]));
}

export function requestProjection(request: OnboardingRequest) {
  return { id: request.id, status: request.status, expiresAt: new Date(request.expires_at).toISOString(), termsVersion: request.terms_version };
}

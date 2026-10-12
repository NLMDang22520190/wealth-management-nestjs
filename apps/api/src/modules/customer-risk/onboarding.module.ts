import { applyDecorators, Body, Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthModule } from '../../auth/auth.module.js';
import { AuthService } from '../../auth/auth.service.js';
import { Public, Roles } from '../../auth/guards.js';
import { ApiError, auditContext } from '../../platform/http.js';
import type { ApiRequest } from '../../platform/http.js';
import { OtpService } from '../../platform/otp.service.js';
import { OtpChallengeBody } from '../../platform/validation.js';
import { AccountsLedgerModule } from '../accounts-ledger/account-bootstrap.js';
import { ConsentBody, CustomerLookupBody, OnboardingRequestBody } from './onboarding.domain.js';
import { OnboardingService } from './onboarding.service.js';

class RegistrationResult {
  @ApiProperty({ format: 'uuid' }) requestId!: string;
  @ApiProperty({ format: 'uuid' }) customerId!: string;
  @ApiProperty({ format: 'uuid' }) serviceId!: string;
  @ApiProperty({ format: 'uuid' }) accountId!: string;
  @ApiProperty({ enum: ['PENDING_RISK_ASSESSMENT'] }) status!: string;
}
class PendingRequestResult {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['PENDING_CONSENT'] }) status!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty() termsVersion!: string;
}
class OtpChallengeResult {
  @ApiProperty({ format: 'uuid' }) challengeId!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}
const errors = () => applyDecorators(
  ApiResponse({ status: 400, description: 'VALIDATION_ERROR, OTP_PURPOSE_MISMATCH, or OTP_INVALID' }),
  ApiResponse({ status: 401, description: 'UNAUTHORIZED' }),
  ApiResponse({ status: 403, description: 'FORBIDDEN: trusted role or ownership mismatch' }),
  ApiResponse({ status: 404, description: 'NOT_FOUND or CUSTOMER_NOT_FOUND' }),
  ApiResponse({ status: 409, description: 'IDEMPOTENCY_CONFLICT, ONBOARDING_EXISTS, SERVICE_EXISTS, OTP_ALREADY_USED, OTP_BINDING_MISMATCH, or RM_CAPACITY_EXCEEDED' }),
  ApiResponse({ status: 410, description: 'ONBOARDING_EXPIRED or OTP_EXPIRED' }),
  ApiResponse({ status: 422, description: 'CUSTOMER_INELIGIBLE, ACCOUNT_INELIGIBLE, or RM_INACTIVE' }),
  ApiResponse({ status: 500, description: 'INTERNAL_ERROR: all local consent writes roll back' }),
  ApiResponse({ status: 503, description: 'CORE_UNAVAILABLE: no local registration committed' }),
);

function key(request: ApiRequest): string | undefined {
  const value = request.headers['idempotency-key'];
  return typeof value === 'string' ? value : undefined;
}

@ApiBearerAuth('bearer')
@ApiTags('Onboarding')
@Controller()
class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Roles('RM') @Post('onboarding/customer-lookup') @HttpCode(200)
  @ApiOperation({ summary: 'Resolve eligibility and active own VND accounts from Core banking' })
  @ApiResponse({ status: 200, description: 'Canonical cifRef, name, dateOfBirth, active, eligible and eligible accounts (external string account IDs)' }) @errors()
  lookup(@Body() body: CustomerLookupBody) { return this.onboarding.lookup(body.cifRef); }

  @Roles('RM') @Post('onboarding/requests')
  @ApiOperation({ summary: 'Reserve RM capacity for 72 hours and snapshot server-owned terms' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiResponse({ status: 201, type: PendingRequestResult }) @errors()
  create(@Req() request: ApiRequest, @Body() body: OnboardingRequestBody) {
    return this.onboarding.create(request.actor!, body, key(request), auditContext(request));
  }

  @Roles('CUSTOMER') @Get('me/onboarding-requests')
  @ApiOperation({ summary: 'List own invitations, projecting expired requests at their deadline' })
  @ApiResponse({ status: 200, description: 'items of own requests with effective status, expiresAt and termsVersion' }) @errors()
  invitations(@Req() request: ApiRequest) { return this.onboarding.invitations(request.actor!); }

  @Roles('CUSTOMER') @Get('me/onboarding-requests/:id')
  @ApiOperation({ summary: 'Read own request and its immutable terms' })
  @ApiResponse({ status: 200, description: 'Pending request with nonempty terms text', type: PendingRequestResult }) @errors()
  detail(@Req() request: ApiRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.onboarding.detail(request.actor!, id);
  }

  @Roles('CUSTOMER') @Post('me/onboarding-requests/:id/confirm') @HttpCode(200)
  @ApiOperation({ summary: 'Consume bound OTP and atomically register service, account, consent and provisional RM' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiResponse({ status: 200, type: RegistrationResult }) @errors()
  confirm(@Req() request: ApiRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: ConsentBody) {
    return this.onboarding.confirm(request.actor!, id, body, key(request), auditContext(request));
  }
}

@ApiBearerAuth('bearer')
@ApiTags('OTP')
@Controller()
class OtpController {
  constructor(private readonly onboarding: OnboardingService, private readonly otp: OtpService, private readonly auth: AuthService) {}

  @Roles('CUSTOMER') @Post('otp/challenges')
  @ApiOperation({ summary: 'Deliver an OTP bound to own consent operation, without returning its code' })
  @ApiResponse({ status: 201, type: OtpChallengeResult }) @errors()
  challenge(@Req() request: ApiRequest, @Body() body: OtpChallengeBody) {
    return this.onboarding.challenge(request.actor!, body.purpose, body.operationId, auditContext(request));
  }

  // Public metadata permits the feature check to run before authentication; this method still authenticates enabled inbox access.
  @Public() @Get('me/otp-challenges/:id/demo-code')
  @ApiOperation({ summary: 'Development/test mock delivery inbox; production and disabled mock always return 404' })
  @ApiResponse({ status: 200, description: 'challengeId, code and expiresAt, available only to the operation-owning customer' }) @errors()
  async demoCode(@Req() request: ApiRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    this.auth.ensureMockEnabled();
    const actor = await this.auth.authenticate(request.headers.authorization);
    if (actor.role !== 'CUSTOMER') throw new ApiError(403, 'FORBIDDEN', 'Access denied');
    return this.otp.demoCode(id, actor.actorId);
  }
}

@Module({ imports: [AuthModule, AccountsLedgerModule], controllers: [OnboardingController, OtpController], providers: [OnboardingService, OtpService] })
export class CustomerRiskModule {}

import { Body, Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/guards.js';
import { ApiError, auditContext } from '../platform/http.js';
import type { ApiRequest } from '../platform/http.js';
import { CustomerRiskModule } from '../modules/customer-risk/onboarding.module.js';
import { RiskConfirmBody, RiskDraftBody, riskPaging } from '../modules/customer-risk/risk.domain.js';
import { RiskService } from '../modules/customer-risk/risk.service.js';

function pendingSlice(): never { throw new ApiError(501, 'NOT_IMPLEMENTED', 'This operation is not implemented yet'); }

/** Public route signatures; remaining business implementations arrive in later slices. */
@ApiBearerAuth('bearer')
@ApiTags('Risk assessment')
@Controller()
class RiskController {
  constructor(private readonly risk: RiskService) {}

  @Roles('CUSTOMER') @Get('risk-questionnaires/current')
  @ApiOperation({ summary: 'Get ten questions from the current demo questionnaire; points stay server-owned' })
  questionnaire(@Req() request: ApiRequest) { return this.risk.questionnaire(request.actor!); }
  @Roles('CUSTOMER') @Post('me/risk-assessments')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({ summary: 'Create a server-scored immutable preview, valid for 24 hours' })
  draft(@Req() request: ApiRequest, @Body() body: RiskDraftBody) {
    return this.risk.draft(request.actor!, body, this.key(request));
  }
  @Roles('CUSTOMER') @Post('me/risk-assessments/:id/confirm') @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({ summary: 'Confirm a stored preview with a bound OTP and expected current-profile version' })
  confirm(@Req() request: ApiRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: RiskConfirmBody) {
    return this.risk.confirm(request.actor!, id, body, this.key(request), auditContext(request));
  }
  @Roles('CUSTOMER') @Get('me/risk-profile')
  myProfile(@Req() request: ApiRequest) { return this.risk.profile(request.actor!); }
  @Roles('CUSTOMER') @Get('me/risk-profile/history')
  myHistory(@Req() request: ApiRequest, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.risk.history(request.actor!, riskPaging(page, pageSize));
  }
  @Roles('RM', 'LEADER') @Get('customers/:id/risk-profile')
  customerProfile(@Req() request: ApiRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.risk.profile(request.actor!, id);
  }
  @Roles('RM', 'LEADER') @Get('customers/:id/risk-profile/history')
  customerHistory(@Req() request: ApiRequest, @Param('id', new ParseUUIDPipe()) id: string,
    @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.risk.history(request.actor!, riskPaging(page, pageSize), id);
  }

  private key(request: ApiRequest): string | undefined {
    const value = request.headers['idempotency-key'];
    return typeof value === 'string' ? value : undefined;
  }
}

@ApiBearerAuth('bearer')
@ApiTags('Relationship managers')
@Controller()
class RmController {
  @Roles('LEADER') @Get('team/rms')
  team() { return pendingSlice(); }
  @Roles('LEADER') @Post('customers/:id/rm-assignment')
  assign(@Param('id') _id: string) { return pendingSlice(); }
  @Roles('RM') @Get('rm/customers')
  list() { return pendingSlice(); }
  @Roles('RM', 'LEADER', 'CUSTOMER') @Get('customers/:id')
  detail(@Param('id') _id: string) { return pendingSlice(); }
}

@Module({ imports: [CustomerRiskModule], controllers: [RiskController, RmController] })
export class BusinessRoutesModule {}

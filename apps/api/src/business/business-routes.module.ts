import { Body, Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/guards.js';
import { ApiError, auditContext } from '../platform/http.js';
import type { ApiRequest } from '../platform/http.js';
import { CustomerRiskModule } from '../modules/customer-risk/onboarding.module.js';
import { RiskConfirmBody, RiskDraftBody, riskPaging } from '../modules/customer-risk/risk.domain.js';
import { RiskService } from '../modules/customer-risk/risk.service.js';
import { RmAssignmentBody } from '../modules/customer-risk/rm-assignment.domain.js';
import { RmAssignmentService } from '../modules/customer-risk/rm-assignment.service.js';
import { parseCustomerListQuery } from '../modules/customer-risk/rm-customers.domain.js';
import { RmCustomersService } from '../modules/customer-risk/rm-customers.service.js';

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
    return this.risk.draft(request.actor!, body, this.key(request), auditContext(request));
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
  constructor(private readonly assignments: RmAssignmentService, private readonly customers: RmCustomersService) {}
  @Roles('LEADER') @Get('team/rms')
  team(@Req() request: ApiRequest) { return this.assignments.team(request.actor!); }
  @Roles('LEADER') @Get('team/customers')
  @ApiOperation({ summary: 'List customers currently assigned to RMs of the authenticated leader team' })
  teamCustomers(@Req() request: ApiRequest, @Query('page') page?: string, @Query('pageSize') pageSize?: string, @Query('name') name?: string) {
    if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0 || name.length > 100)) throw new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed');
    return this.assignments.customers(request.actor!, riskPaging(page, pageSize), name?.trim());
  }
  @Roles('LEADER') @Post('customers/:id/rm-assignment') @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  assign(@Req() request: ApiRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: RmAssignmentBody) {
    const key = request.headers['idempotency-key'];
    return this.assignments.assign(request.actor!, id, body, typeof key === 'string' ? key : undefined, auditContext(request));
  }
  @Roles('RM') @Get('rm/customers')
  @ApiOperation({ summary: 'List customers currently assigned to the authenticated RM; scope is never taken from the query' })
  list(@Req() request: ApiRequest, @Query() query: Record<string, unknown>) {
    return this.customers.list(request.actor!, parseCustomerListQuery(query));
  }
  @Roles('RM', 'LEADER', 'CUSTOMER') @Get('customers/:id')
  @ApiOperation({ summary: 'Customer summary for the current RM, the current RM team leader, or the customer themself' })
  detail(@Req() request: ApiRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.customers.detail(request.actor!, id);
  }
}

@Module({ imports: [CustomerRiskModule], controllers: [RiskController, RmController] })
export class BusinessRoutesModule {}

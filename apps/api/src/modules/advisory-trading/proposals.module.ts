import { Body, Controller, Get, HttpCode, Module, Param, Post, Query, Req } from '@nestjs/common';
import { IdParamPipe } from '../../platform/validation.js';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthModule } from '../../auth/auth.module.js';
import { Roles } from '../../auth/guards.js';
import { auditContext } from '../../platform/http.js';
import type { ApiRequest } from '../../platform/http.js';
import { LedgerService } from '../accounts-ledger/ledger.service.js';
import { CustomerRiskModule } from '../customer-risk/onboarding.module.js';
import { HoldingsMutation } from '../portfolio-valuation/holdings-mutation.js';
import { PortfolioScanModule } from '../portfolio-valuation/portfolio-scan.module.js';
import { ApprovalService } from './approval.service.js';
import { ExecutionEngine } from './execution.engine.js';
import { ApproveProposalBody, CancelProposalBody, CreateProposalBody, parseStatus, RejectProposalBody } from './proposal.domain.js';
import { ProposalJobs } from './proposal-jobs.js';
import { ProposalService } from './proposal.service.js';

function key(request: ApiRequest): string | undefined {
  const value = request.headers['idempotency-key'];
  return typeof value === 'string' ? value : undefined;
}
const uuidParam = () => new IdParamPipe();

@ApiBearerAuth('bearer')
@ApiTags('Proposals (staff)')
@Controller()
class StaffProposalsController {
  constructor(private readonly proposals: ProposalService) {}

  @Roles('RM') @Post('customers/:customerId/proposals')
  @ApiOperation({ summary: 'UC-13: a proposal for a customer of this RM; prices come from the server' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiResponse({ status: 409, description: 'PROPOSAL_PENDING_EXISTS or ALERT_NOT_OPEN' })
  @ApiResponse({ status: 422, description: 'RISK_PROFILE_REQUIRED, SUITABILITY_VIOLATION, PRODUCT_NOT_ON_SALE, PRICE_UNAVAILABLE, BELOW_MIN_INVESTMENT, HOLDING_NOT_FOUND, QUANTITY_EXCEEDS_HOLDING or BUDGET_EXCEEDED' })
  create(@Req() request: ApiRequest, @Param('customerId', uuidParam()) customerId: string, @Body() body: CreateProposalBody) {
    return this.proposals.create(request.actor!, customerId, body, key(request), auditContext(request));
  }

  @Roles('RM', 'LEADER') @Get('customers/:customerId/proposals')
  forCustomer(@Req() request: ApiRequest, @Param('customerId', uuidParam()) customerId: string) { return this.proposals.forCustomer(request.actor!, customerId, auditContext(request)); }

  @Roles('RM', 'LEADER') @Get('proposals/:id')
  detail(@Req() request: ApiRequest, @Param('id', uuidParam()) id: string) { return this.proposals.staffDetail(request.actor!, id, auditContext(request)); }

  @Roles('RM') @Get('rm/proposals')
  forRm(@Req() request: ApiRequest, @Query() query: Record<string, unknown>) { return this.proposals.forRm(request.actor!, parseStatus(query)); }

  @Roles('RM') @Post('proposals/:id/cancel') @HttpCode(200)
  @ApiOperation({ summary: 'UC-14: withdraw a pending proposal' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiResponse({ status: 409, description: 'PROPOSAL_NOT_PENDING' }) @ApiResponse({ status: 410, description: 'PROPOSAL_EXPIRED' })
  cancel(@Req() request: ApiRequest, @Param('id', uuidParam()) id: string, @Body() body: CancelProposalBody) {
    return this.proposals.cancel(request.actor!, id, body, key(request), auditContext(request));
  }
}

@ApiBearerAuth('bearer')
@ApiTags('Proposals (customer)')
@Controller('me/proposals')
class CustomerProposalsController {
  constructor(private readonly proposals: ProposalService, private readonly approvals: ApprovalService) {}

  @Roles('CUSTOMER') @Get()
  list(@Req() request: ApiRequest) { return this.proposals.ownList(request.actor!); }

  @Roles('CUSTOMER') @Get(':id')
  detail(@Req() request: ApiRequest, @Param('id', uuidParam()) id: string) { return this.proposals.ownDetail(request.actor!, id, auditContext(request)); }

  @Roles('CUSTOMER') @Post(':id/reject') @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  reject(@Req() request: ApiRequest, @Param('id', uuidParam()) id: string, @Body() body: RejectProposalBody) {
    return this.proposals.reject(request.actor!, id, body, key(request), auditContext(request));
  }

  @Roles('CUSTOMER') @Post(':id/approval-challenge')
  @ApiOperation({ summary: 'UC-15: check slippage (BR-22), then send a Smart OTP' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiResponse({ status: 409, description: 'SLIPPAGE_EXCEEDED: the proposal is now FAILED' })
  challenge(@Req() request: ApiRequest, @Param('id', uuidParam()) id: string) { return this.approvals.challenge(request.actor!, id, key(request), auditContext(request)); }

  @Roles('CUSTOMER') @Post(':id/approve') @HttpCode(200)
  @ApiOperation({ summary: 'UC-15 and UC-16: sign with the OTP; the body status is EXECUTED or FAILED (all or nothing)' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiResponse({ status: 400, description: 'OTP_INVALID: the proposal stays pending' }) @ApiResponse({ status: 409, description: 'OTP_ATTEMPTS_EXCEEDED, OTP_BINDING_MISMATCH or PROPOSAL_NOT_PENDING' })
  approve(@Req() request: ApiRequest, @Param('id', uuidParam()) id: string, @Body() body: ApproveProposalBody) {
    return this.approvals.approve(request.actor!, id, body, key(request), auditContext(request));
  }
}

@Module({ imports: [AuthModule, CustomerRiskModule, PortfolioScanModule], controllers: [StaffProposalsController, CustomerProposalsController],
  providers: [ProposalService, ApprovalService, ExecutionEngine, LedgerService, HoldingsMutation, ProposalJobs] })
export class ProposalsModule {}

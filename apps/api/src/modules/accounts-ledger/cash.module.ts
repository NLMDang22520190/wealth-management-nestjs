import { Body, Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthModule } from '../../auth/auth.module.js';
import { AuthService } from '../../auth/auth.service.js';
import { Public, Roles } from '../../auth/guards.js';
import { auditContext } from '../../platform/http.js';
import type { ApiRequest } from '../../platform/http.js';
import { CustomerRiskModule } from '../customer-risk/onboarding.module.js';
import { TermDepositMaturity } from '../portfolio-valuation/term-deposit-maturity.js';
import { CashConfirmBody, DepositBody, forbidden, MaturityJobBody, parseHistoryQuery, ResolveBody, WithdrawalBody } from './cash.domain.js';
import { CashHistoryService } from './cash-history.service.js';
import { CashJobs } from './cash-jobs.js';
import { CashOrderService } from './cash-order.service.js';
import { CashSettlement } from './cash-settlement.service.js';
import { LedgerService } from './ledger.service.js';
import { MaturityService } from './maturity.service.js';
import { ReconciliationService } from './reconciliation.service.js';

function key(request: ApiRequest): string | undefined {
  const value = request.headers['idempotency-key'];
  return typeof value === 'string' ? value : undefined;
}
const uuidParam = () => new ParseUUIDPipe();

@ApiBearerAuth('bearer')
@ApiTags('Cash (customer)')
@Controller('me')
class CustomerCashController {
  constructor(private readonly orders: CashOrderService, private readonly history: CashHistoryService) {}

  @Roles('CUSTOMER') @Get('investment-account')
  @ApiOperation({ summary: 'Balances, remaining daily limits and own VND CASA accounts' })
  @ApiResponse({ status: 404, description: 'ACCOUNT_NOT_FOUND' }) @ApiResponse({ status: 503, description: 'CORE_UNAVAILABLE' })
  account(@Req() request: ApiRequest) { return this.orders.accountView(request.actor!); }

  @Roles('CUSTOMER') @Post('deposits')
  @ApiOperation({ summary: 'UC-05: create a deposit order and send its Smart OTP' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiResponse({ status: 422, description: 'AMOUNT_BELOW_MINIMUM, DAILY_LIMIT_EXCEEDED, CASA_NOT_ELIGIBLE, SERVICE_INACTIVE or ACCOUNT_NOT_ACTIVE' })
  deposit(@Req() request: ApiRequest, @Body() body: DepositBody) {
    return this.orders.create('DEPOSIT', request.actor!, { casaNo: body.sourceCasaNo, amount: body.amount }, key(request), auditContext(request));
  }

  @Roles('CUSTOMER') @Post('deposits/:id/confirm') @HttpCode(200)
  @ApiOperation({ summary: 'UC-05: sign with OTP; the body status is SUCCESS, FAILED (Core refused) or PENDING (no answer from Core)' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiResponse({ status: 400, description: 'OTP_INVALID: the order is FAILED' }) @ApiResponse({ status: 410, description: 'OTP_EXPIRED: the order is FAILED' })
  @ApiResponse({ status: 409, description: 'OTP_BINDING_MISMATCH or TXN_NOT_CONFIRMABLE' })
  confirmDeposit(@Req() request: ApiRequest, @Param('id', uuidParam()) id: string, @Body() body: CashConfirmBody) {
    return this.orders.confirm('DEPOSIT', request.actor!, id, body, key(request), auditContext(request));
  }

  @Roles('CUSTOMER') @Post('withdrawals')
  @ApiOperation({ summary: 'UC-06: hold the amount and send a Smart OTP' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiResponse({ status: 422, description: 'INSUFFICIENT_AVAILABLE_BALANCE, AMOUNT_BELOW_MINIMUM, DAILY_LIMIT_EXCEEDED, CASA_NOT_ELIGIBLE, SERVICE_INACTIVE or ACCOUNT_NOT_ACTIVE' })
  withdraw(@Req() request: ApiRequest, @Body() body: WithdrawalBody) {
    return this.orders.create('WITHDRAWAL', request.actor!, { casaNo: body.destCasaNo, amount: body.amount }, key(request), auditContext(request));
  }

  @Roles('CUSTOMER') @Post('withdrawals/:id/confirm') @HttpCode(200)
  @ApiOperation({ summary: 'UC-06: sign with OTP; the body status is SUCCESS, FAILED (refunded) or PENDING' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  confirmWithdrawal(@Req() request: ApiRequest, @Param('id', uuidParam()) id: string, @Body() body: CashConfirmBody) {
    return this.orders.confirm('WITHDRAWAL', request.actor!, id, body, key(request), auditContext(request));
  }

  @Roles('CUSTOMER') @Get('cash-transactions')
  @ApiOperation({ summary: 'UC-07: own transactions, last 30 days by default' })
  list(@Req() request: ApiRequest, @Query() query: Record<string, unknown>) { return this.history.own(request.actor!, parseHistoryQuery(query)); }

  @Roles('CUSTOMER') @Get('cash-transactions/:id')
  @ApiOperation({ summary: 'UC-07: own transaction with its ledger entries' })
  detail(@Req() request: ApiRequest, @Param('id', uuidParam()) id: string) { return this.history.ownDetail(request.actor!, id, auditContext(request)); }

  @Roles('CUSTOMER') @Get('cash-notifications')
  @ApiOperation({ summary: 'The 20 most recently finished transactions' })
  results(@Req() request: ApiRequest) { return this.history.results(request.actor!); }
}

@ApiBearerAuth('bearer')
@ApiTags('Cash (staff)')
@Controller('customers/:customerId/cash-transactions')
class StaffCashController {
  constructor(private readonly history: CashHistoryService) {}

  @Roles('RM', 'LEADER') @Get()
  @ApiOperation({ summary: 'UC-07: history of a customer in scope; each view is audited' })
  list(@Req() request: ApiRequest, @Param('customerId', uuidParam()) customerId: string, @Query() query: Record<string, unknown>) {
    return this.history.forCustomer(request.actor!, customerId, parseHistoryQuery(query), auditContext(request));
  }

  @Roles('RM', 'LEADER') @Get(':txnId')
  detail(@Req() request: ApiRequest, @Param('customerId', uuidParam()) customerId: string, @Param('txnId', uuidParam()) txnId: string) {
    return this.history.customerDetail(request.actor!, customerId, txnId, auditContext(request));
  }
}

@ApiBearerAuth('bearer')
@ApiTags('Cash (back-office)')
@Controller('back-office')
class BackOfficeCashController {
  constructor(private readonly history: CashHistoryService, private readonly reconciliation: ReconciliationService, private readonly maturity: MaturityService) {}

  @Roles('BACK_OFFICE') @Get('cash-transactions')
  @ApiOperation({ summary: 'Search by cifId, type, status, needsReview; each view is audited' })
  list(@Req() request: ApiRequest, @Query() query: Record<string, unknown>) {
    return this.history.backOffice(request.actor!, parseHistoryQuery(query), auditContext(request));
  }

  @Roles('BACK_OFFICE') @Get('cash-transactions/:id')
  detail(@Req() request: ApiRequest, @Param('id', uuidParam()) id: string) { return this.history.backOfficeDetail(request.actor!, id, auditContext(request)); }

  @Roles('BACK_OFFICE') @Post('cash-transactions/:id/resolve') @HttpCode(200)
  @ApiOperation({ summary: 'Close an order that three reconciliation rounds could not settle' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiResponse({ status: 409, description: 'TXN_NOT_RESOLVABLE' })
  resolve(@Req() request: ApiRequest, @Param('id', uuidParam()) id: string, @Body() body: ResolveBody) {
    return this.reconciliation.resolve(request.actor!, id, body, key(request), auditContext(request));
  }

  @Roles('BACK_OFFICE') @Get('maturity-runs')
  @ApiOperation({ summary: 'UC-08: the 20 most recent settlement runs and their failures' })
  runs() { return this.maturity.recentRuns(); }
}

/** Manual job triggers for the demo. Public metadata lets the feature check answer 404 before authentication, as the demo OTP inbox does. */
@ApiBearerAuth('bearer')
@ApiTags('Demo')
@Controller('demo/jobs')
class DemoJobsController {
  constructor(private readonly auth: AuthService, private readonly jobs: CashJobs) {}

  private async requireBackOffice(request: ApiRequest): Promise<void> {
    this.auth.ensureMockEnabled();
    const actor = await this.auth.authenticate(request.headers.authorization);
    if (actor.role !== 'BACK_OFFICE') throw forbidden();
  }

  @Public() @Post('reconciliation') @HttpCode(200)
  @ApiResponse({ status: 409, description: 'JOB_RUNNING' })
  async reconciliation(@Req() request: ApiRequest) {
    await this.requireBackOffice(request);
    return this.jobs.runReconciliation();
  }

  @Public() @Post('maturity-settlement') @HttpCode(200)
  @ApiResponse({ status: 409, description: 'JOB_RUNNING' })
  async maturity(@Req() request: ApiRequest, @Body() body: MaturityJobBody) {
    await this.requireBackOffice(request);
    return this.jobs.runMaturity(body.asOf);
  }
}

@Module({ imports: [AuthModule, CustomerRiskModule], controllers: [CustomerCashController, StaffCashController, BackOfficeCashController, DemoJobsController],
  providers: [LedgerService, CashSettlement, CashOrderService, ReconciliationService, TermDepositMaturity, MaturityService, CashHistoryService, CashJobs] })
export class CashModule {}

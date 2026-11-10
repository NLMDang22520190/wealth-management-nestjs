import { Body, Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthModule } from '../../auth/auth.module.js';
import { AuthService } from '../../auth/auth.service.js';
import { Public, Roles } from '../../auth/guards.js';
import { ApiError, auditContext } from '../../platform/http.js';
import type { ApiRequest } from '../../platform/http.js';
import { CustomerRiskModule } from '../customer-risk/onboarding.module.js';
import { CatalogService } from './catalog.service.js';
import { PortfolioJobs } from './portfolio-jobs.js';
import { PortfolioReadService } from './portfolio-read.service.js';
import { PortfolioScanModule } from './portfolio-scan.module.js';
import { AssetRiskBody, AssetStatusBody, CreateAssetBody, parseAssetQuery, parseHistoryDays, PriceBody, PriceDecisionBody, PriceImportBody, SnapshotJobBody } from './portfolio.domain.js';
import { PricingService } from './pricing.service.js';

function key(request: ApiRequest): string | undefined {
  const value = request.headers['idempotency-key'];
  return typeof value === 'string' ? value : undefined;
}
const uuidParam = () => new ParseUUIDPipe();

@ApiBearerAuth('bearer')
@ApiTags('Products (back-office)')
@Controller('back-office/assets')
class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Roles('BACK_OFFICE') @Get()
  list(@Query() query: Record<string, unknown>) { return this.catalog.list(parseAssetQuery(query)); }

  @Roles('BACK_OFFICE') @Get(':id')
  detail(@Param('id', uuidParam()) id: string) { return this.catalog.detail(id); }

  @Roles('BACK_OFFICE') @Post()
  @ApiOperation({ summary: 'UC-09: add a product, with its class details and starting price, in one transaction' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiResponse({ status: 409, description: 'PRODUCT_CODE_EXISTS' }) @ApiResponse({ status: 400, description: 'BOND_MATURITY_PASSED or VALIDATION_ERROR' })
  create(@Req() request: ApiRequest, @Body() body: CreateAssetBody) { return this.catalog.create(request.actor!, body, key(request), auditContext(request)); }

  @Roles('BACK_OFFICE') @Patch(':id/status')
  @ApiHeader({ name: 'Idempotency-Key', required: true }) @ApiResponse({ status: 404, description: 'ASSET_NOT_FOUND' })
  status(@Req() request: ApiRequest, @Param('id', uuidParam()) id: string, @Body() body: AssetStatusBody) { return this.catalog.changeStatus(request.actor!, id, body, key(request), auditContext(request)); }

  @Roles('BACK_OFFICE') @Patch(':id/risk-level')
  @ApiHeader({ name: 'Idempotency-Key', required: true }) @ApiResponse({ status: 404, description: 'ASSET_NOT_FOUND' })
  risk(@Req() request: ApiRequest, @Param('id', uuidParam()) id: string, @Body() body: AssetRiskBody) { return this.catalog.changeRisk(request.actor!, id, body, key(request), auditContext(request)); }
}

@ApiBearerAuth('bearer')
@ApiTags('Prices (back-office)')
@Controller('back-office/prices')
class PricingController {
  constructor(private readonly pricing: PricingService) {}

  @Roles('BACK_OFFICE') @Post()
  @ApiOperation({ summary: 'UC-10: enter a NAV, bond price or interest rate; above 20% it waits for the manager' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiResponse({ status: 409, description: 'PRICE_PENDING_EXISTS or PRICE_NOT_LATEST' }) @ApiResponse({ status: 404, description: 'ASSET_NOT_FOUND' })
  submit(@Req() request: ApiRequest, @Body() body: PriceBody) { return this.pricing.submit(request.actor!, body, key(request), auditContext(request)); }

  @Roles('BACK_OFFICE') @Post('import') @HttpCode(200)
  @ApiOperation({ summary: 'UC-10: import a CSV; each row reports its own result' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  import(@Req() request: ApiRequest, @Body() body: PriceImportBody) { return this.pricing.importCsv(request.actor!, body.csv, key(request), auditContext(request)); }

  @Roles('BACK_OFFICE', 'BACK_OFFICE_MANAGER') @Get('pending')
  pending() { return this.pricing.pending(); }

  @Roles('BACK_OFFICE_MANAGER') @Post(':id/approve') @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiResponse({ status: 409, description: 'PRICE_NOT_PENDING' }) @ApiResponse({ status: 403, description: 'MAKER_CHECKER_VIOLATION' })
  approve(@Req() request: ApiRequest, @Param('id', uuidParam()) id: string, @Body() body: PriceDecisionBody) {
    return this.pricing.decide(request.actor!, id, 'APPROVED', body.reason, key(request), auditContext(request));
  }

  @Roles('BACK_OFFICE_MANAGER') @Post(':id/reject') @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiResponse({ status: 409, description: 'PRICE_NOT_PENDING' }) @ApiResponse({ status: 403, description: 'MAKER_CHECKER_VIOLATION' })
  reject(@Req() request: ApiRequest, @Param('id', uuidParam()) id: string, @Body() body: PriceDecisionBody) {
    return this.pricing.decide(request.actor!, id, 'REJECTED', body.reason, key(request), auditContext(request));
  }
}

@ApiBearerAuth('bearer')
@ApiTags('Portfolio')
@Controller()
class PortfolioController {
  constructor(private readonly reads: PortfolioReadService, private readonly catalog: CatalogService) {}

  @Roles('CUSTOMER') @Get('me/portfolio')
  @ApiOperation({ summary: 'UC-11: own holdings valued at the latest prices' }) @ApiResponse({ status: 404, description: 'ACCOUNT_NOT_FOUND' })
  own(@Req() request: ApiRequest) { return this.reads.ownPortfolio(request.actor!); }

  @Roles('CUSTOMER') @Get('me/portfolio/aum-history')
  ownHistory(@Req() request: ApiRequest, @Query() query: Record<string, unknown>) { return this.reads.ownHistory(request.actor!, parseHistoryDays(query)); }

  @Roles('RM', 'LEADER') @Get('customers/:customerId/portfolio')
  @ApiOperation({ summary: 'UC-11: a customer in scope; each view is audited' })
  customer(@Req() request: ApiRequest, @Param('customerId', uuidParam()) customerId: string) { return this.reads.customerPortfolio(request.actor!, customerId, auditContext(request)); }

  @Roles('RM', 'LEADER') @Get('customers/:customerId/portfolio/aum-history')
  customerHistory(@Req() request: ApiRequest, @Param('customerId', uuidParam()) customerId: string, @Query() query: Record<string, unknown>) {
    return this.reads.customerHistory(request.actor!, customerId, parseHistoryDays(query), auditContext(request));
  }

  @Roles('RM', 'LEADER') @Get('customers/:customerId/drift-alerts')
  customerAlerts(@Req() request: ApiRequest, @Param('customerId', uuidParam()) customerId: string) { return this.reads.customerAlerts(request.actor!, customerId, auditContext(request)); }

  @Roles('RM') @Get('rm/drift-alerts')
  @ApiOperation({ summary: 'UC-12: open alerts of the customers this RM holds now, with the suggested adjustment' })
  alerts(@Req() request: ApiRequest) { return this.reads.rmAlerts(request.actor!); }

  @Roles('RM') @Post('rm/drift-alerts/:id/read') @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true }) @ApiResponse({ status: 404, description: 'ALERT_NOT_FOUND' })
  read(@Req() request: ApiRequest, @Param('id', uuidParam()) id: string) { return this.reads.markRead(request.actor!, id, key(request), auditContext(request)); }

  @Roles('RM') @Get('rm/product-risk-warnings')
  @ApiOperation({ summary: 'UC-09: customers of this RM holding a product above their maximum risk' })
  warnings(@Req() request: ApiRequest) { return this.catalog.riskWarnings(request.actor!); }

  @Roles('RM', 'LEADER') @Get('products')
  @ApiOperation({ summary: 'Products on sale' })
  products() { return this.catalog.products(); }
}

/** Public metadata lets the feature check answer 404 before authentication, as the other demo triggers do. */
@ApiBearerAuth('bearer')
@ApiTags('Demo')
@Controller('demo/jobs')
class DemoPortfolioJobsController {
  constructor(private readonly auth: AuthService, private readonly jobs: PortfolioJobs) {}

  @Public() @Post('portfolio-snapshot') @HttpCode(200)
  @ApiResponse({ status: 409, description: 'JOB_RUNNING' })
  async snapshot(@Req() request: ApiRequest, @Body() body: SnapshotJobBody) {
    this.auth.ensureMockEnabled();
    const actor = await this.auth.authenticate(request.headers.authorization);
    if (actor.role !== 'BACK_OFFICE') throw new ApiError(403, 'FORBIDDEN', 'Access denied');
    return this.jobs.runNow(body.asOf);
  }
}

@Module({ imports: [AuthModule, CustomerRiskModule, PortfolioScanModule], controllers: [CatalogController, PricingController, PortfolioController, DemoPortfolioJobsController],
  providers: [CatalogService, PricingService, PortfolioReadService, PortfolioJobs] })
export class PortfolioModule {}

import { Controller, Get, Module, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/guards.js';
import { ApiError } from '../platform/http.js';

function pendingSlice(): never { throw new ApiError(501, 'NOT_IMPLEMENTED', 'This operation is not implemented yet'); }

/** Public route signatures; remaining business implementations arrive in later slices. */
@ApiBearerAuth('bearer')
@ApiTags('Risk assessment')
@Controller()
class RiskController {
  @Roles('CUSTOMER') @Get('risk-questionnaires/current')
  questionnaire() { return pendingSlice(); }
  @Roles('CUSTOMER') @Post('me/risk-assessments')
  draft() { return pendingSlice(); }
  @Roles('CUSTOMER') @Post('me/risk-assessments/:id/confirm')
  confirm(@Param('id', new ParseUUIDPipe()) _id: string) { return pendingSlice(); }
  @Roles('CUSTOMER') @Get('me/risk-profile')
  myProfile() { return pendingSlice(); }
  @Roles('RM', 'LEADER') @Get('customers/:id/risk-profile')
  customerProfile(@Param('id') _id: string) { return pendingSlice(); }
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

@Module({ controllers: [RiskController, RmController] })
export class BusinessRoutesModule {}

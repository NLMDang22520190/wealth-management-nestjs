import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/guards.js';
import { ApiError } from '../platform/http.js';
import { OtpChallengeBody } from '../platform/validation.js';

function pendingSlice(): never { throw new ApiError(501, 'NOT_IMPLEMENTED', 'This operation is not implemented yet'); }

/** Public route signatures; business implementations are delivered in the next slices. */
@ApiBearerAuth('bearer')
@ApiTags('Onboarding')
@Controller()
class OnboardingController {
  @Roles('RM') @Post('onboarding/customer-lookup')
  lookup() { return pendingSlice(); }
  @Roles('RM') @Post('onboarding/requests')
  request() { return pendingSlice(); }
  @Roles('CUSTOMER') @Get('me/onboarding-requests/:id')
  getRequest(@Param('id', new ParseUUIDPipe()) _id: string) { return pendingSlice(); }
  @Roles('CUSTOMER') @Post('me/onboarding-requests/:id/confirm')
  confirm(@Param('id', new ParseUUIDPipe()) _id: string) { return pendingSlice(); }
}

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

@ApiBearerAuth('bearer')
@ApiTags('OTP')
@Controller('otp')
class OtpController {
  @Post('challenges')
  challenge(@Body() _body: OtpChallengeBody) { return pendingSlice(); }
}

@Module({ controllers: [OnboardingController, RiskController, RmController, OtpController] })
export class BusinessRoutesModule {}

import { Body, Controller, Get, HttpCode, Module, Post, Req, UseGuards } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { ApiRequest } from '../platform/http.js';
import { MockTokenBody } from '../platform/validation.js';
import { AuthService } from './auth.service.js';
import { AuthenticationGuard, MockEnabledGuard, Public, RoleGuard } from './guards.js';

@ApiTags('Authentication')
@Controller()
class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @UseGuards(MockEnabledGuard)
  @Post('mock-auth/token')
  @HttpCode(200)
  token(@Body() body: MockTokenBody) { return this.auth.issue(body.actorId); }

  @ApiBearerAuth('bearer')
  @Get('auth/me')
  me(@Req() request: ApiRequest) { return request.actor; }
}

@Module({
  controllers: [AuthController],
  providers: [AuthService, MockEnabledGuard,
    { provide: APP_GUARD, useClass: AuthenticationGuard },
    { provide: APP_GUARD, useClass: RoleGuard }],
  exports: [AuthService],
})
export class AuthModule {}

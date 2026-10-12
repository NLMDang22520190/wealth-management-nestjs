import { Injectable, SetMetadata } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError } from '../platform/http.js';
import type { ApiRequest } from '../platform/http.js';
import type { ActorRole } from './actor.js';
import { AuthService } from './auth.service.js';

const PUBLIC = Symbol('PUBLIC');
const ROLES = Symbol('ROLES');
export const Public = () => SetMetadata(PUBLIC, true);
export const Roles = (...roles: ActorRole[]) => SetMetadata(ROLES, roles);

@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly auth: AuthService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, [context.getHandler(), context.getClass()])) return true;
    const request = context.switchToHttp().getRequest<ApiRequest>();
    request.actor = await this.auth.authenticate(request.headers.authorization);
    return true;
  }
}

@Injectable()
export class RoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<ActorRole[]>(ROLES, [context.getHandler(), context.getClass()]);
    const actor = context.switchToHttp().getRequest<ApiRequest>().actor;
    if (roles && (!actor || !roles.includes(actor.role))) throw new ApiError(403, 'FORBIDDEN', 'Access denied');
    return true;
  }
}

@Injectable()
export class MockEnabledGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}
  canActivate(): boolean { this.auth.ensureMockEnabled(); return true; }
}

import { randomUUID } from 'node:crypto';
import { Catch, HttpException } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter, LoggerService } from '@nestjs/common';
import type { Actor } from '../auth/actor.js';

export interface ApiRequest {
  headers: Record<string, string | string[] | undefined>;
  requestId: string;
  ip?: string;
  socket?: { remoteAddress?: string };
  actor?: Actor;
}
export interface AuditContext { requestId: string; ip: string; device: string; }

export function auditContext(request: ApiRequest): AuditContext {
  const device = request.headers['user-agent'];
  return { requestId: request.requestId,
    ip: (request.ip ?? request.socket?.remoteAddress ?? '').replace(/^::ffff:/, ''),
    device: typeof device === 'string' ? device.slice(0, 512) : '' };
}
interface ApiResponse {
  setHeader(name: string, value: string): void;
  status(code: number): ApiResponse;
  json(body: unknown): void;
}

export function requestContext(request: ApiRequest, response: ApiResponse, next: () => void): void {
  const supplied = request.headers['x-request-id'];
  request.requestId = typeof supplied === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : randomUUID();
  response.setHeader('x-request-id', request.requestId);
  next();
}

export class ApiError extends HttpException {
  constructor(status: number, code: string, message: string, details: unknown = []) {
    super({ code, message, details }, status);
  }
}

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: LoggerService) {}
  catch(exception: unknown, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<ApiRequest>();
    const response = host.switchToHttp().getResponse<ApiResponse>();
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    const fallback: Record<number, [string, string]> = {
      400: ['VALIDATION_ERROR', 'Request validation failed'],
      401: ['UNAUTHORIZED', 'Authentication required'],
      403: ['FORBIDDEN', 'Access denied'],
      404: ['NOT_FOUND', 'Resource not found'],
      501: ['NOT_IMPLEMENTED', 'This operation is not implemented yet'],
      503: ['UNAVAILABLE', 'Service unavailable'],
    };
    const [code, message] = fallback[status] ?? ['INTERNAL_ERROR', 'Unexpected server error'];
    const body = exception instanceof ApiError ? exception.getResponse() as object : { code, message, details: [] };
    this.logger.error({ code, status, requestId: request.requestId });
    response.status(status).json({ ...body, requestId: request.requestId });
  }
}

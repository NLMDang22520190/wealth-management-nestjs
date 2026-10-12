import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { ApplicationOptions } from '../application.js';
import { ApiError } from '../platform/http.js';
import { RUNTIME_OPTIONS } from '../platform/runtime.module.js';
import type { Actor } from './actor.js';

const ISSUER = 'wealth-management-mock';
const AUDIENCE = 'wealth-management-api';
const EXPIRES_IN = 3600;
const unauthorized = () => new ApiError(401, 'UNAUTHORIZED', 'Authentication required');

@Injectable()
export class AuthService {
  constructor(private readonly database: DataSource, @Inject(RUNTIME_OPTIONS) private readonly options: ApplicationOptions) {}

  private async lookup(column: 'actor_id' | 'subject_id', identifier: string): Promise<Actor> {
    const [actor] = await this.database.query(
      `SELECT actor_id AS "actorId", subject_id AS "subjectId", role, cif_id AS "cifId",
       rm_id AS "rmId", team_id AS "teamId" FROM public.mock_actors WHERE ${column} = $1 AND active = true`,
      [identifier],
    ) as Actor[];
    if (!actor || !['RM', 'LEADER', 'CUSTOMER'].includes(actor.role)) throw unauthorized();
    return actor;
  }

  ensureMockEnabled(): void {
    if (!this.options.mockEnabled || this.options.environment === 'production') {
      throw new ApiError(404, 'NOT_FOUND', 'Resource not found');
    }
  }

  async issue(actorId: string): Promise<{ accessToken: string; expiresIn: number }> {
    this.ensureMockEnabled();
    const actor = await this.lookup('actor_id', actorId);
    const seconds = Math.floor(this.options.clock.now().getTime() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: actor.subjectId, iss: ISSUER, aud: AUDIENCE, iat: seconds, exp: seconds + EXPIRES_IN })).toString('base64url');
    const input = `${header}.${payload}`;
    return { accessToken: `${input}.${this.sign(input).toString('base64url')}`, expiresIn: EXPIRES_IN };
  }

  private sign(input: string): Buffer {
    return createHmac('sha256', this.options.jwtSecret).update(input).digest();
  }

  async authenticate(authorization: unknown): Promise<Actor> {
    if (!this.options.mockEnabled || this.options.environment === 'production'
      || typeof authorization !== 'string' || authorization.length > 8192) throw unauthorized();
    const bearer = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization);
    if (!bearer) throw unauthorized();
    const [headerPart, payloadPart, signaturePart] = bearer[1]!.split('.') as [string, string, string];
    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
      const signature = Buffer.from(signaturePart, 'base64url');
      const expected = this.sign(`${headerPart}.${payloadPart}`);
      if (signature.toString('base64url') !== signaturePart || signature.length !== expected.length
        || !timingSafeEqual(signature, expected)) throw unauthorized();
      header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as Record<string, unknown>;
      payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as Record<string, unknown>;
    } catch { throw unauthorized(); }
    const seconds = Math.floor(this.options.clock.now().getTime() / 1000);
    if (!header || !payload || header.alg !== 'HS256' || header.typ !== 'JWT'
      || payload.iss !== ISSUER || payload.aud !== AUDIENCE
      || typeof payload.sub !== 'string' || !payload.sub
      || !Number.isSafeInteger(payload.exp) || (payload.exp as number) <= seconds
      || (payload.nbf !== undefined && (!Number.isSafeInteger(payload.nbf) || (payload.nbf as number) > seconds))) throw unauthorized();
    // Only the active registry supplies identity. Client role/CIF/RM/team claims have no authority.
    return this.lookup('subject_id', payload.sub);
  }
}

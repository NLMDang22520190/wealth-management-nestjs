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

  /**
   * Identity comes only from server rows: staff by `iam_subject`, then customers by `iam_subject`, then (before onboarding)
   * a CIF with an invitation whose `'cust.' || lower(cif)` equals the subject. A subject that is both staff and customer is refused.
   */
  private async bySubject(subject: string): Promise<Actor> {
    const staff: Array<{ employee_code: string; iam_subject: string; role: string; staff_id: string; team_id: string | null; is_active: boolean }> =
      await this.database.query(`SELECT employee_code,iam_subject,role::text AS role,staff_id,team_id,is_active
        FROM wms.staff_users WHERE iam_subject=$1`, [subject]);
    const customers: Array<{ cif_id: string }> = await this.database.query('SELECT cif_id FROM wms.customers WHERE iam_subject=$1', [subject]);
    if (staff.length > 0 && customers.length > 0) throw unauthorized();
    if (staff.length > 0) {
      const member = staff[0]!;
      if (staff.length !== 1 || !member.is_active || (member.role !== 'RM' && member.role !== 'LEADER')) throw unauthorized();
      return { actorId: member.employee_code, subjectId: member.iam_subject, role: member.role, cifId: null,
        rmId: member.role === 'RM' ? member.staff_id : null, teamId: member.team_id, staffId: member.staff_id };
    }
    let cifs = customers.map(row => row.cif_id);
    if (cifs.length === 0) {
      const invited: Array<{ cif_id: string }> = await this.database.query(
        "SELECT DISTINCT cif_id FROM wms.onboarding_requests WHERE 'cust.' || lower(cif_id)=$1", [subject]);
      cifs = invited.map(row => row.cif_id);
    }
    // Several CIFs behind one subject (CIFs that differ only in case) are not aliases of each other.
    if (cifs.length !== 1) throw unauthorized();
    return { actorId: cifs[0]!, subjectId: subject, role: 'CUSTOMER', cifId: cifs[0]!, rmId: null, teamId: null, staffId: null };
  }

  /** Subject a login id would carry: staff `iam_subject`, customer `iam_subject`, or `cust.<lower cif>` before onboarding. */
  private async subjectOf(actorId: string): Promise<string> {
    const [member] = await this.database.query('SELECT iam_subject FROM wms.staff_users WHERE employee_code=$1', [actorId]);
    const [customer] = await this.database.query('SELECT iam_subject FROM wms.customers WHERE cif_id=$1', [actorId]);
    if (member && customer) throw unauthorized();
    if (member) return member.iam_subject;
    if (customer) return customer.iam_subject ?? `cust.${actorId.toLowerCase()}`;
    const [invited] = await this.database.query('SELECT 1 FROM wms.onboarding_requests WHERE cif_id=$1 LIMIT 1', [actorId]);
    if (!invited) throw unauthorized();
    return `cust.${actorId.toLowerCase()}`;
  }

  ensureMockEnabled(): void {
    if (!this.options.mockEnabled || this.options.environment === 'production') {
      throw new ApiError(404, 'NOT_FOUND', 'Resource not found');
    }
  }

  async issue(actorId: string): Promise<{ accessToken: string; expiresIn: number }> {
    this.ensureMockEnabled();
    const actor = await this.bySubject(await this.subjectOf(actorId));
    if (actor.actorId !== actorId) throw unauthorized();
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
    // Only the active staff/customer rows supply identity. Client role/CIF/RM/team claims have no authority.
    return this.bySubject(payload.sub);
  }
}

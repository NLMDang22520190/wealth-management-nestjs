import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { ApplicationOptions } from '../application.js';
import { ApiError } from './http.js';
import { RUNTIME_OPTIONS } from './runtime.module.js';
import { hash } from './transactions.js';

export interface OtpDelivery {
  challengeId: string; actorId: string; purpose: string; operationId: string; code: string; expiresAt: string;
}

@Injectable()
export class OtpService {
  private readonly inbox = new Map<string, OtpDelivery>();
  constructor(@Inject(RUNTIME_OPTIONS) private readonly options: ApplicationOptions) {}

  async issue(manager: EntityManager, actorId: string, purpose: string, operationId: string, payloadHash: string): Promise<OtpDelivery> {
    const challengeId = randomUUID();
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const salt = randomBytes(32).toString('hex');
    const expiresAt = new Date(this.options.clock.now().getTime() + (this.options.otpTtlSeconds ?? 120) * 1000).toISOString();
    await manager.query(`INSERT INTO otp_challenges(id,actor_id,purpose,operation_id,payload_hash,code_hash,salt,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [challengeId, actorId, purpose, operationId, payloadHash, hash(`${salt}:${code}`), salt, expiresAt]);
    return { challengeId, actorId, purpose, operationId, code, expiresAt };
  }

  async deliver(delivery: OtpDelivery): Promise<void> {
    if (this.options.otpDelivery) await this.options.otpDelivery(delivery);
    if (this.options.mockEnabled && this.options.environment !== 'production') this.inbox.set(delivery.challengeId, delivery);
  }

  demoCode(challengeId: string, actorId: string): { challengeId: string; code: string; expiresAt: string } {
    const delivery = this.inbox.get(challengeId);
    if (!delivery) throw new ApiError(404, 'NOT_FOUND', 'Resource not found');
    if (delivery.actorId !== actorId) throw new ApiError(403, 'FORBIDDEN', 'Access denied');
    return { challengeId, code: delivery.code, expiresAt: delivery.expiresAt };
  }

  async consume(manager: EntityManager, challengeId: string, code: string, actorId: string,
    purpose: string, operationId: string, payloadHash: string): Promise<string> {
    const [row] = await manager.query('SELECT * FROM otp_challenges WHERE id=$1 FOR UPDATE', [challengeId]);
    if (!row || row.actor_id !== actorId || row.purpose !== purpose || row.operation_id !== operationId || row.payload_hash !== payloadHash) {
      throw new ApiError(409, 'OTP_BINDING_MISMATCH', 'Challenge does not authorize this operation');
    }
    if (row.consumed_at) throw new ApiError(409, 'OTP_ALREADY_USED', 'Challenge already used');
    const now = this.options.clock.now();
    if (new Date(row.expires_at).getTime() <= now.getTime()) throw new ApiError(410, 'OTP_EXPIRED', 'Challenge expired');
    if (!timingSafeEqual(Buffer.from(row.code_hash, 'hex'), Buffer.from(hash(`${row.salt}:${code}`), 'hex'))) {
      throw new ApiError(400, 'OTP_INVALID', 'Invalid verification code');
    }
    const receiptRef = randomUUID();
    await manager.query('UPDATE otp_challenges SET consumed_at=$2,receipt_ref=$3 WHERE id=$1', [challengeId, now, receiptRef]);
    return receiptRef;
  }
}

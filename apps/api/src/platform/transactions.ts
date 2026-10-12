import { createHash, randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { ApiError } from './http.js';

export const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Transaction-scoped locks work across API instances and roll back with all writes. */
async function lock(manager: EntityManager, namespace: string, resource: string): Promise<void> {
  await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${namespace}:${resource}`]);
}

/** Shared ordering: sorted RM locks before customer/CIF locks. */
export async function lockCustomer(manager: EntityManager, cifId: string, rmIds: string[]): Promise<void> {
  for (const rmId of [...new Set(rmIds)].sort()) await lock(manager, 'rm-capacity', rmId);
  await lock(manager, 'customer-cif', cifId);
}

export async function idempotent<T>(manager: EntityManager, actorId: string, purpose: string, resource: string,
  key: string | undefined, payload: unknown, now: Date, work: () => Promise<T>): Promise<T> {
  if (!key || key.length > 200) throw new ApiError(400, 'VALIDATION_ERROR', 'Idempotency-Key is required');
  const scope = JSON.stringify([actorId, purpose, resource]);
  const payloadHash = hash(JSON.stringify(payload));
  await lock(manager, 'idempotency', JSON.stringify([scope, key]));
  const [record] = await manager.query('SELECT payload_hash,response FROM idempotency_records WHERE scope=$1 AND key=$2', [scope, key]);
  if (record) {
    if (record.payload_hash !== payloadHash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Key already binds a different request');
    return record.response as T;
  }
  const response = await work();
  await manager.query('INSERT INTO idempotency_records(scope,key,payload_hash,response,created_at) VALUES($1,$2,$3,$4,$5)',
    [scope, key, payloadHash, JSON.stringify(response), now]);
  return response;
}

export async function appendSuccess(manager: EntityManager, actorId: string, resourceId: string,
  action: string, eventType: string, payload: unknown, now: Date): Promise<void> {
  await manager.query(`INSERT INTO audit_events(id,action,outcome,actor_id,resource_id,payload,created_at)
    VALUES($1,$2,'SUCCESS',$3,$4,$5,$6)`, [randomUUID(), action, actorId, resourceId, JSON.stringify(payload), now]);
  await manager.query(`INSERT INTO outbox_events(id,event_type,aggregate_id,payload,created_at)
    VALUES($1,$2,$3,$4,$5)`, [randomUUID(), eventType, resourceId, JSON.stringify(payload), now]);
}

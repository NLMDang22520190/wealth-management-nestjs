import { createHash, randomUUID } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import type { ActorRole } from '../auth/actor.js';
import { ApiError } from './http.js';
import type { AuditContext } from './http.js';

export const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

/** P1 idempotency records live 24 hours (NFR-P2-05); the team column default of 300 s is for cash operations. */
const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;
/** Team `idem_key` is VARCHAR(100). */
const MAX_KEY_LENGTH = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who acts, for audit rows: the login id and the role (`wms.actor_role`). */
export interface AuditActor { actorId: string; role: ActorRole; }
/** What the audit row and the outbox event are about. */
export interface Reference { type: string; id: string; }

/** Transaction-scoped locks work across API instances and roll back with all writes. */
async function lock(manager: EntityManager, namespace: string, resource: string): Promise<void> {
  await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${namespace}:${resource}`]);
}

/** Shared ordering: sorted RM locks before customer/CIF locks. */
export async function lockCustomer(manager: EntityManager, cifId: string, rmIds: string[]): Promise<void> {
  for (const rmId of [...new Set(rmIds)].sort()) await lock(manager, 'rm-capacity', rmId);
  await lock(manager, 'customer-cif', cifId);
}

function requireKey(key: string | undefined): asserts key is string {
  if (!key || key.length > MAX_KEY_LENGTH) throw new ApiError(400, 'VALIDATION_ERROR', 'Idempotency-Key is required');
}

const RECORD_WHERE = 'scope_actor=$1 AND scope_purpose=$2 AND scope_resource=$3 AND idem_key=$4';

export async function idempotent<T>(manager: EntityManager, actorId: string, purpose: string, resource: string,
  key: string | undefined, payload: unknown, now: Date, work: () => Promise<T>, responseStatus = 200): Promise<T> {
  requireKey(key);
  const payloadHash = hash(JSON.stringify(payload));
  const scope = [actorId, purpose, resource, key];
  await lock(manager, 'idempotency', JSON.stringify(scope));
  const [record] = await manager.query(`SELECT payload_hash,response_body,expires_at FROM wms.idempotency_records WHERE ${RECORD_WHERE}`, scope);
  if (record) {
    if (new Date(record.expires_at).getTime() > now.getTime()) {
      if (record.payload_hash !== payloadHash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Key already binds a different request');
      return record.response_body as T;
    }
    // An expired key is treated as new.
    await manager.query(`DELETE FROM wms.idempotency_records WHERE ${RECORD_WHERE}`, scope);
  }
  const response = await work();
  await manager.query(`INSERT INTO wms.idempotency_records(scope_actor,scope_purpose,scope_resource,idem_key,payload_hash,response_status,response_body,created_at,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
  [...scope, payloadHash, responseStatus, JSON.stringify(response), now, new Date(now.getTime() + IDEMPOTENCY_TTL_MS)]);
  return response;
}

/** A committed replay needs no external dependency; locked idempotent() remains the write authority. */
export async function idempotencyReplay<T>(manager: EntityManager, actorId: string, purpose: string, resource: string,
  key: string | undefined, payload: unknown, now: Date): Promise<{ response: T } | undefined> {
  requireKey(key);
  const [record] = await manager.query(`SELECT payload_hash,response_body,expires_at FROM wms.idempotency_records WHERE ${RECORD_WHERE}`,
    [actorId, purpose, resource, key]);
  if (!record || new Date(record.expires_at).getTime() <= now.getTime()) return undefined;
  if (record.payload_hash !== hash(JSON.stringify(payload))) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Key already binds a different request');
  return { response: record.response_body as T };
}

interface AuditRow {
  actor: AuditActor; reference: Reference; action: string; outcome: 'SUCCESS' | 'FAILURE' | 'DENIED';
  payload: unknown; before: unknown; after: unknown; now: Date; context: AuditContext;
}

async function insertAudit(manager: EntityManager, row: AuditRow): Promise<void> {
  const json = (value: unknown) => (value === null || value === undefined ? null : JSON.stringify(value));
  await manager.query(`INSERT INTO wms.audit_logs(request_id,actor_id,actor_role,action,outcome,reference_type,reference_id,
      old_value,new_value,payload_hash,ip_address,device_id,user_agent,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
  // A client-supplied X-Request-Id that is not a UUID stays in the response header and logs, but cannot fill the UUID column.
  [UUID.test(row.context.requestId) ? row.context.requestId : null, row.actor.actorId, row.actor.role, row.action, row.outcome,
    row.reference.type, row.reference.id, json(row.before), json(row.after), hash(JSON.stringify(row.payload)),
    row.context.ip || null, row.context.deviceId, row.context.device || null, row.now]);
}

export async function appendAudit(manager: EntityManager, actor: AuditActor, reference: Reference,
  action: string, payload: unknown, now: Date, metadata: AuditContext & { before: unknown; after: unknown }): Promise<void> {
  await insertAudit(manager, { actor, reference, action, outcome: 'SUCCESS', payload, before: metadata.before, after: metadata.after, now, context: metadata });
}

/** Failure and denial rows go in their own short transaction, after the business transaction has rolled back. */
export async function recordOutcome(database: DataSource, outcome: 'FAILURE' | 'DENIED', actor: AuditActor, reference: Reference,
  action: string, errorCode: string, now: Date, context: AuditContext): Promise<void> {
  await database.transaction(async manager => {
    await insertAudit(manager, { actor, reference, action, outcome, payload: { errorCode }, before: null, after: { errorCode }, now, context });
  });
}

export function apiErrorCode(error: unknown): string | undefined {
  return error instanceof ApiError ? (error.getResponse() as { code?: string }).code : undefined;
}

export async function appendSuccess(manager: EntityManager, actor: AuditActor, reference: Reference,
  action: string, eventType: string, payload: unknown, now: Date, metadata: AuditContext & { before: unknown; after: unknown }): Promise<void> {
  await appendAudit(manager, actor, reference, action, payload, now, metadata);
  await manager.query(`INSERT INTO wms.outbox_events(event_id,event_type,aggregate_type,aggregate_id,payload,created_at)
    VALUES($1,$2,$3,$4,$5,$6)`, [randomUUID(), eventType, reference.type, reference.id, JSON.stringify(payload), now]);
}

import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { Actor } from '../../auth/actor.js';
import type { ApplicationOptions } from '../../application.js';
import { ApiError } from '../../platform/http.js';
import type { AuditContext } from '../../platform/http.js';
import { RUNTIME_OPTIONS } from '../../platform/runtime.module.js';
import { appendSuccess, idempotent } from '../../platform/transactions.js';
import { ProposalCancellation } from '../advisory-trading/proposal-cancellation.js';
import { CustomerAccess } from './customer-access.service.js';
import { assignmentProjection } from './rm-assignment.domain.js';
import type { AssignmentRow, RmAssignmentBody } from './rm-assignment.domain.js';

@Injectable()
export class RmAssignmentService {
  constructor(private readonly database: DataSource, private readonly access: CustomerAccess,
    private readonly cancellation: ProposalCancellation,
    @Inject(RUNTIME_OPTIONS) private readonly options: ApplicationOptions) {}

  async team(actor: Actor) {
    if (actor.role !== 'LEADER' || !actor.teamId) throw new ApiError(403, 'FORBIDDEN', 'Access denied');
    const rows = await this.database.query(`SELECT a.rm_id,a.team_id,a.active,
      (SELECT count(*)::integer FROM rm_assignment_history h WHERE h.rm_id=a.rm_id AND h.valid_to IS NULL) AS assigned,
      (SELECT count(*)::integer FROM rm_capacity_reservations r WHERE r.rm_id=a.rm_id AND r.status='ACTIVE' AND r.expires_at>$2) AS reserved
      FROM mock_actors a WHERE a.role='RM' AND a.team_id=$1 ORDER BY a.rm_id`, [actor.teamId, this.options.clock.now()]);
    return { items: rows.map((row: { rm_id: string; team_id: string; active: boolean; assigned: number; reserved: number }) => ({
      rmId: row.rm_id, teamId: row.team_id, active: row.active, assigned: row.assigned, reserved: row.reserved,
      available: Math.max(0, 80 - row.assigned - row.reserved), capacityLimit: 80 })) };
  }

  async assign(actor: Actor, customerId: string, body: RmAssignmentBody, key: string | undefined, context: AuditContext) {
    if (actor.role !== 'LEADER' || !actor.teamId) throw new ApiError(403, 'FORBIDDEN', 'Access denied');
    return this.access.withAssignmentTransaction(customerId, [body.targetRmId], manager =>
      idempotent(manager, actor.actorId, 'RM_ASSIGNMENT', customerId, key, body, this.options.clock.now(), async () => {
        await this.access.authorize(actor, customerId, manager);
        const [current]: AssignmentRow[] = await manager.query('SELECT * FROM rm_assignment_history WHERE customer_id=$1 AND valid_to IS NULL', [customerId]);
        const [destination] = await manager.query("SELECT team_id,active FROM mock_actors WHERE role='RM' AND rm_id=$1", [body.targetRmId]);
        if (!destination || destination.team_id !== actor.teamId) throw new ApiError(403, 'FORBIDDEN', 'Access denied');
        if (!destination.active) throw new ApiError(422, 'RM_INACTIVE', 'Relationship manager is inactive');
        const [service] = await manager.query('SELECT status FROM wealth_services WHERE customer_id=$1', [customerId]);
        if (service?.status !== 'ACTIVE') throw new ApiError(422, 'SERVICE_INACTIVE', 'Wealth service is inactive');
        if (current.version !== body.expectedAssignmentVersion) throw new ApiError(409, 'RM_ASSIGNMENT_STALE', 'Assignment changed; refresh before transferring');
        if (current.rm_id === body.targetRmId) return assignmentProjection(current, false);
        const now = this.options.clock.now();
        const [capacity] = await manager.query(`SELECT
          (SELECT count(*) FROM rm_assignment_history WHERE rm_id=$1 AND valid_to IS NULL) +
          (SELECT count(*) FROM rm_capacity_reservations WHERE rm_id=$1 AND status='ACTIVE' AND expires_at>$2) AS used`, [body.targetRmId, now]);
        if (Number(capacity.used) >= 80) throw new ApiError(409, 'RM_CAPACITY_EXCEEDED', 'Relationship manager capacity exceeded');
        await manager.query('UPDATE rm_assignment_history SET valid_to=$2 WHERE id=$1', [current.id, now]);
        const [next]: AssignmentRow[] = await manager.query(`INSERT INTO rm_assignment_history
          (id,customer_id,rm_id,team_id,valid_from,provisional,version,assigned_by,reason)
          VALUES($1,$2,$3,$4,$5,false,$6,$7,$8) RETURNING *`,
          [randomUUID(), customerId, body.targetRmId, destination.team_id, now, current.version + 1, actor.actorId, body.reason]);
        await this.cancellation.forRmTransfer(manager, customerId, current.rm_id, now);
        await appendSuccess(manager, actor.actorId, customerId, 'RM_ASSIGNMENT_CHANGED', 'RmAssignmentChanged',
          { customerId, previousRmId: current.rm_id, rmId: next.rm_id, version: next.version }, now,
          { ...context, before: { rmId: current.rm_id, version: current.version }, after: { rmId: next.rm_id, version: next.version } });
        return assignmentProjection(next, true);
      }));
  }
}

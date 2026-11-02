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
    // DECISION[D-R9 S1]: rmName is the RM's staff_users.employee_code until S3c renames it to rmFullName (full_name).
    const rows = await this.database.query(`SELECT s.staff_id AS rm_id,s.employee_code,s.team_id,s.is_active,s.max_customers,
      (SELECT count(*)::integer FROM wms.rm_assignments h WHERE h.rm_id=s.staff_id AND h.valid_to IS NULL) AS assigned,
      (SELECT count(*)::integer FROM wms.rm_capacity_reservations r WHERE r.rm_id=s.staff_id AND r.status='ACTIVE' AND r.expires_at>$2) AS reserved
      FROM wms.staff_users s WHERE s.role='RM' AND s.team_id=$1 ORDER BY s.staff_id`, [actor.teamId, this.options.clock.now()]);
    return { items: rows.map((row: { rm_id: string; employee_code: string | null; team_id: string; is_active: boolean; max_customers: number; assigned: number; reserved: number }) => ({
      rmId: row.rm_id, rmName: row.employee_code ?? null, teamId: row.team_id, active: row.is_active, assigned: row.assigned, reserved: row.reserved,
      available: Math.max(0, row.max_customers - row.assigned - row.reserved), capacityLimit: row.max_customers })) };
  }

 async customers(actor: Actor, paging: { page: number; pageSize: number }, name: string | undefined) {
    if (actor.role !== 'LEADER' || !actor.teamId) throw new ApiError(403, 'FORBIDDEN', 'Access denied');
    const params: unknown[] = [actor.teamId];
    let filter = '';
    if (name) { params.push(`%${name.replace(/[\\%_]/g, '\\$&')}%`); filter = ' AND c.full_name ILIKE $2'; }
    // DECISION[D-R9 S1]: rmName = staff_users.employee_code of the assigned RM (S3c: full_name).
    const from = `FROM wms.customers c JOIN wms.rm_assignments a ON a.customer_id=c.customer_id AND a.valid_to IS NULL
      LEFT JOIN wms.staff_users m ON m.role='RM' AND m.staff_id=a.rm_id
      WHERE a.team_id=$1${filter}`;
    const [count] = await this.database.query(`SELECT count(*)::integer AS total ${from}`, params);
    const rows = await this.database.query(`SELECT c.customer_id AS id,c.full_name AS name,a.rm_id,m.employee_code AS rm_name,a.version,
      EXISTS(SELECT 1 FROM wms.wealth_services w JOIN wms.risk_profiles r ON r.risk_profile_id=w.current_risk_profile_id WHERE w.customer_id=c.customer_id AND r.expires_at>$${params.length + 3}) AS risk_valid,
      (SELECT max(n.created_at) FROM wms.customer_notifications n WHERE n.customer_id=c.customer_id AND n.kind='RISK_SURVEY_REMINDER') AS last_reminder_at ${from} ORDER BY c.full_name,c.customer_id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, paging.pageSize, (paging.page - 1) * paging.pageSize, this.options.clock.now()]);
    return { page: paging.page, pageSize: paging.pageSize, total: count.total,
      items: rows.map((row: { id: string; name: string; rm_id: string; rm_name: string | null; version: number; risk_valid: boolean; last_reminder_at: Date | null }) =>
        ({ customerId: row.id, name: row.name, rmId: row.rm_id, rmName: row.rm_name ?? null, assignmentVersion: row.version,
          riskProfileValid: row.risk_valid, lastReminderAt: row.last_reminder_at ? row.last_reminder_at.toISOString() : null })) };
  }

  async assign(actor: Actor, customerId: string, body: RmAssignmentBody, key: string | undefined, context: AuditContext) {
    if (actor.role !== 'LEADER' || !actor.teamId) throw new ApiError(403, 'FORBIDDEN', 'Access denied');
    return this.access.withAssignmentTransaction(customerId, [body.targetRmId], manager =>
      idempotent(manager, actor.actorId, 'RM_ASSIGNMENT', customerId, key, body, this.options.clock.now(), async () => {
        await this.access.authorize(actor, customerId, manager);
        const [current]: AssignmentRow[] = await manager.query('SELECT * FROM wms.rm_assignments WHERE customer_id=$1 AND valid_to IS NULL', [customerId]);
        const [destination] = await manager.query("SELECT team_id,is_active,max_customers FROM wms.staff_users WHERE role='RM' AND staff_id=$1", [body.targetRmId]);
        if (!destination || destination.team_id !== actor.teamId) throw new ApiError(403, 'FORBIDDEN', 'Access denied');
        if (!destination.is_active) throw new ApiError(422, 'RM_INACTIVE', 'Relationship manager is inactive');
        const [service] = await manager.query('SELECT status FROM wms.wealth_services WHERE customer_id=$1', [customerId]);
        if (service?.status !== 'ACTIVE') throw new ApiError(422, 'SERVICE_INACTIVE', 'Wealth service is inactive');
        // DECISION[D-R4b]: transfer needs a current, unexpired risk profile (survey answered and OTP-confirmed).
        const [profile] = await manager.query(`SELECT 1 FROM wms.wealth_services w JOIN wms.risk_profiles r ON r.risk_profile_id=w.current_risk_profile_id
          WHERE w.customer_id=$1 AND r.expires_at>$2`, [customerId, this.options.clock.now()]);
        if (!profile) throw new ApiError(422, 'RISK_PROFILE_REQUIRED', 'Customer must complete the risk survey before transfer');
        if (current.version !== body.expectedAssignmentVersion) throw new ApiError(409, 'RM_ASSIGNMENT_STALE', 'Assignment changed; refresh before transferring');
        if (current.rm_id === body.targetRmId) return assignmentProjection(current, false);
        const now = this.options.clock.now();
        const [capacity] = await manager.query(`SELECT
          (SELECT count(*) FROM wms.rm_assignments WHERE rm_id=$1 AND valid_to IS NULL) +
          (SELECT count(*) FROM wms.rm_capacity_reservations WHERE rm_id=$1 AND status='ACTIVE' AND expires_at>$2) AS used`, [body.targetRmId, now]);
        if (Number(capacity.used) >= destination.max_customers) throw new ApiError(409, 'RM_CAPACITY_EXCEEDED', 'Relationship manager capacity exceeded');
        await manager.query('UPDATE wms.rm_assignments SET valid_to=$2 WHERE assignment_id=$1', [current.assignment_id, now]);
        const [next]: AssignmentRow[] = await manager.query(`INSERT INTO wms.rm_assignments
          (assignment_id,customer_id,rm_id,team_id,valid_from,provisional,version,assigned_by,reason)
          VALUES($1,$2,$3,$4,$5,false,$6,$7,$8) RETURNING *`,
          [randomUUID(), customerId, body.targetRmId, destination.team_id, now, current.version + 1, actor.staffId, body.reason]);
        const cancelled = await this.cancellation.forRmTransfer(manager, customerId, current.rm_id, now);
        await appendSuccess(manager, actor, { type: 'CUSTOMER', id: customerId }, 'RM_ASSIGNMENT_CHANGED', 'RmAssignmentChanged',
          { customerId, previousRmId: current.rm_id, rmId: next.rm_id, version: next.version }, now,
          { ...context, before: { rmId: current.rm_id, version: current.version }, after: { rmId: next.rm_id, version: next.version } });
        return assignmentProjection(next, true, cancelled);
      }));
  }
}

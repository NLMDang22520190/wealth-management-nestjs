import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { Actor } from '../../auth/actor.js';
import type { ApplicationOptions } from '../../application.js';
import { ApiError } from '../../platform/http.js';
import type { AuditContext } from '../../platform/http.js';
import { RUNTIME_OPTIONS } from '../../platform/runtime.module.js';
import { appendAudit } from '../../platform/transactions.js';
import { CustomerAccess } from './customer-access.service.js';
import { REMINDER_COOLDOWN_MS, REMINDER_MESSAGE } from './notifications.domain.js';
import type { RiskSurveyReminderBody } from './notifications.domain.js';

interface TeamCustomerRow { id: string; risk_valid: boolean; last_reminder_at: Date | null; }
type Skipped = { customerId: string; reason: 'PROFILE_VALID' | 'RECENTLY_REMINDED' };

@Injectable()
export class NotificationsService {
  constructor(private readonly database: DataSource, private readonly access: CustomerAccess,
    @Inject(RUNTIME_OPTIONS) private readonly options: ApplicationOptions) {}

  async remind(actor: Actor, body: RiskSurveyReminderBody, context: AuditContext) {
    if (actor.role !== 'LEADER' || !actor.teamId) throw new ApiError(403, 'FORBIDDEN', 'Access denied');
    const teamId = actor.teamId;
    return this.database.transaction(async manager => {
      // Serialize reminders per team so the 24h cooldown cannot be raced into duplicates.
      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`risk-reminder:${teamId}`]);
      const now = this.options.clock.now();
      const rows: TeamCustomerRow[] = await manager.query(`SELECT c.id,
          EXISTS(SELECT 1 FROM wealth_services w JOIN risk_profiles r ON r.id=w.current_risk_profile_id
            WHERE w.customer_id=c.id AND r.expires_at>$2) AS risk_valid,
          (SELECT max(n.created_at) FROM customer_notifications n WHERE n.customer_id=c.id AND n.kind='RISK_SURVEY_REMINDER') AS last_reminder_at
        FROM customers c JOIN rm_assignment_history a ON a.customer_id=c.id AND a.valid_to IS NULL
        WHERE a.team_id=$1 ORDER BY c.id`, [teamId, now]);
      const byId = new Map(rows.map(row => [row.id, row]));
      const explicit = body.customerIds ? [...new Set(body.customerIds.map(id => id.toLowerCase()))] : undefined;
      // All-or-nothing: any id outside the leader's team rejects the whole request.
      if (explicit?.some(id => !byId.has(id))) throw new ApiError(403, 'FORBIDDEN', 'Access denied');
      const targets = explicit ? explicit.map(id => byId.get(id)!) : rows.filter(row => !row.risk_valid);
      const skipped: Skipped[] = [];
      let sent = 0;
      for (const row of targets) {
        if (row.risk_valid) { skipped.push({ customerId: row.id, reason: 'PROFILE_VALID' }); continue; }
        if (row.last_reminder_at && now.getTime() - row.last_reminder_at.getTime() < REMINDER_COOLDOWN_MS) {
          skipped.push({ customerId: row.id, reason: 'RECENTLY_REMINDED' }); continue;
        }
        const id = randomUUID();
        await manager.query(`INSERT INTO customer_notifications(id,customer_id,kind,message,created_by,created_at)
          VALUES($1,$2,'RISK_SURVEY_REMINDER',$3,$4,$5)`, [id, row.id, REMINDER_MESSAGE, actor.actorId, now]);
        await appendAudit(manager, actor.actorId, row.id, 'RISK_SURVEY_REMINDER_SENT',
          { customerId: row.id, notificationId: id }, now, { ...context, before: null, after: { notificationId: id } });
        sent += 1;
      }
      return { sent, skipped };
    });
  }

  async list(actor: Actor) {
    if (actor.role !== 'CUSTOMER' || !actor.cifId) throw new ApiError(403, 'FORBIDDEN', 'Access denied');
    // A CIF that has not registered yet simply has no notifications.
    const [customer] = await this.database.query('SELECT id FROM customers WHERE cif_id=$1', [actor.cifId]);
    if (!customer) return { items: [] };
    const rows = await this.database.query(`SELECT id,kind,message,created_at,read_at FROM customer_notifications
      WHERE customer_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100`, [customer.id]);
    return { items: rows.map((row: { id: string; kind: string; message: string; created_at: Date; read_at: Date | null }) => ({
      id: row.id, kind: row.kind, message: row.message, createdAt: row.created_at.toISOString(),
      readAt: row.read_at ? row.read_at.toISOString() : null })) };
  }

  async markRead(actor: Actor, id: string) {
    const customer = await this.access.own(actor);
    const [result]: Array<Array<{ id: string; read_at: Date }>> = await this.database.query(
      `UPDATE customer_notifications SET read_at=COALESCE(read_at,$3) WHERE id=$1 AND customer_id=$2 RETURNING id,read_at`,
      [id, customer.id, this.options.clock.now()]);
    const updated = result?.[0];
    if (!updated) throw new ApiError(404, 'NOT_FOUND', 'Resource not found');
    return { id: updated.id, readAt: updated.read_at.toISOString() };
  }
}

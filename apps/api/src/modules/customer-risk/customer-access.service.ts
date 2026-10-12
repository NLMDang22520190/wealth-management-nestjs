import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import type { Actor } from '../../auth/actor.js';
import { ApiError } from '../../platform/http.js';

export interface CustomerIdentity { id: string; cif_id: string; }

/** Resolve ownership from trusted CIF and the current assignment, never a browser-supplied role. */
@Injectable()
export class CustomerAccess {
  constructor(private readonly database: DataSource) {}

  async own(actor: Actor, manager: EntityManager = this.database.manager): Promise<CustomerIdentity> {
    if (actor.role !== 'CUSTOMER' || !actor.cifId) throw new ApiError(403, 'FORBIDDEN', 'Access denied');
    const [customer] = await manager.query('SELECT id,cif_id FROM customers WHERE cif_id=$1', [actor.cifId]);
    if (!customer) throw new ApiError(404, 'NOT_FOUND', 'Resource not found');
    return customer;
  }

  async staff(actor: Actor, customerId: string): Promise<CustomerIdentity> {
    const [customer] = await this.database.query(`SELECT c.id,c.cif_id FROM customers c
      JOIN rm_assignment_history a ON a.customer_id=c.id AND a.valid_to IS NULL
      WHERE c.id=$1 AND (($2='RM' AND a.rm_id=$3) OR ($2='LEADER' AND a.team_id=$4))`,
      [customerId, actor.role, actor.rmId, actor.teamId]);
    if (!customer) throw new ApiError(403, 'FORBIDDEN', 'Access denied');
    return customer;
  }
}

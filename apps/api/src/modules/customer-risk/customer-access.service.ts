import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import type { Actor } from '../../auth/actor.js';
import { ApiError } from '../../platform/http.js';
import { lockCustomer } from '../../platform/transactions.js';

export interface CustomerIdentity { id: string; cif_id: string; }
class AssignmentLockChanged extends Error {}
function forbidden(): never { throw Object.assign(new ApiError(403, 'FORBIDDEN', 'Access denied'), { code: 'FORBIDDEN' }); }

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
    if (actor.role !== 'RM' && actor.role !== 'LEADER') forbidden();
    return this.authorize(actor, customerId, this.database.manager);
  }

  async authorize(actor: Actor, customerId: string, manager: EntityManager): Promise<CustomerIdentity> {
    const [customer] = await manager.query(`SELECT c.id,c.cif_id FROM customers c
      JOIN rm_assignment_history a ON a.customer_id=c.id AND a.valid_to IS NULL
      WHERE c.id=$1 AND (($2='RM' AND a.rm_id=$3) OR ($2='LEADER' AND a.team_id=$4)
        OR ($2='CUSTOMER' AND c.cif_id=$5))`,
      [customerId, actor.role, actor.rmId, actor.teamId, actor.cifId]);
    if (!customer) forbidden();
    return customer;
  }

  /** Local DB work only: callback must not call external services while ownership locks are held. */
  async withAccessTransaction<T>(actor: Actor, customerId: string,
    work: (manager: EntityManager, identity: CustomerIdentity) => Promise<T>): Promise<T> {
    return this.withAssignmentTransaction(customerId, [], async manager => {
      const customer = await this.authorize(actor, customerId, manager);
      return work(manager, customer);
    });
  }

  /** Restart on a changed lock set rather than acquiring an RM lock after the CIF lock. */
  async withAssignmentTransaction<T>(customerId: string, additionalRmIds: string[],
    work: (manager: EntityManager) => Promise<T>): Promise<T> {
    for (;;) {
      try {
        return await this.database.transaction(async manager => {
          const [initial] = await manager.query(`SELECT c.cif_id,a.rm_id FROM customers c
            JOIN rm_assignment_history a ON a.customer_id=c.id AND a.valid_to IS NULL WHERE c.id=$1`, [customerId]);
          if (!initial) forbidden();
          const rmIds = [...additionalRmIds, initial.rm_id];
          await lockCustomer(manager, initial.cif_id, rmIds);
          const [current] = await manager.query('SELECT rm_id FROM rm_assignment_history WHERE customer_id=$1 AND valid_to IS NULL', [customerId]);
          if (!current || !rmIds.includes(current.rm_id)) throw new AssignmentLockChanged();
          return work(manager);
        });
      } catch (error) {
        if (!(error instanceof AssignmentLockChanged)) throw error;
      }
    }
  }
}

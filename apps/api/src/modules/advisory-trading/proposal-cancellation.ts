import { Injectable, Module } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

/** P4 owns proposal state; this local DB bridge participates in the caller's transaction. */
@Injectable()
export class ProposalCancellation {
  async forRmTransfer(manager: EntityManager, customerId: string, previousRmId: string, now: Date): Promise<number> {
    // closed_at from the app clock; the team state trigger would otherwise stamp the database time.
    const [, count] = await manager.query(`UPDATE wms.proposals SET status='CANCELLED',cancel_reason='RM_TRANSFER',closed_at=$3
      WHERE customer_id=$1 AND rm_id=$2 AND status='PENDING_APPROVAL'`, [customerId, previousRmId, now]) as [unknown, number];
    return count;
  }
}

@Module({ providers: [ProposalCancellation], exports: [ProposalCancellation] })
export class ProposalCancellationModule {}

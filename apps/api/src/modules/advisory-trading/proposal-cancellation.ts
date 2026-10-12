import { Injectable, Module } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

/** P4 owns proposal state; this local DB bridge participates in the caller's transaction. */
@Injectable()
export class ProposalCancellation {
  async forRmTransfer(manager: EntityManager, customerId: string, previousRmId: string, now: Date): Promise<void> {
    await manager.query(`UPDATE proposals SET status='CANCELLED',cancellation_reason='RM_TRANSFER',updated_at=$3
      WHERE customer_id=$1 AND author_rm_id=$2 AND status='PENDING_APPROVAL'`, [customerId, previousRmId, now]);
  }
}

@Module({ providers: [ProposalCancellation], exports: [ProposalCancellation] })
export class ProposalCancellationModule {}

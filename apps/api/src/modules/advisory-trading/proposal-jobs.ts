import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { ApplicationOptions } from '../../application.js';
import { withJobLock } from '../../platform/job-lock.js';
import { RUNTIME_OPTIONS } from '../../platform/runtime.module.js';
import { expireDue } from './proposal-store.js';

const TICK_MS = 60_000;

/** BR-21 for proposals nobody opens: every minute, pending ones past their 24 hours become EXPIRED. Reads and actions expire them too. */
@Injectable()
export class ProposalJobs implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly database: DataSource, @Inject(RUNTIME_OPTIONS) private readonly options: ApplicationOptions) {}

  onApplicationBootstrap(): void {
    if (!this.options.proposalJobsEnabled) return;
    this.timer = setInterval(() => {
      this.tick().catch(() => this.options.logger.error({ code: 'PROPOSAL_JOBS_FAILED' }));
    }, TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void { clearInterval(this.timer); }

  async tick(): Promise<void> {
    await withJobLock(this.database, 'proposal-jobs', () => this.database.transaction(manager => expireDue(manager, this.options.clock.now())));
  }
}

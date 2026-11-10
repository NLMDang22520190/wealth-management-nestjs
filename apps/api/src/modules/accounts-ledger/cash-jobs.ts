import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { ApplicationOptions } from '../../application.js';
import { ApiError } from '../../platform/http.js';
import { withJobLock } from '../../platform/job-lock.js';
import { RUNTIME_OPTIONS } from '../../platform/runtime.module.js';
import { vietnamDate, vietnamMinutesOfDay } from './cash.domain.js';
import { MaturityService } from './maturity.service.js';
import { ReconciliationService } from './reconciliation.service.js';

const TICK_MS = 60_000;
const RECONCILIATION_EVERY_MS = 5 * 60_000;
const MATURITY_AFTER_MINUTES = 30;
const JOB_LOCK = 'cash-jobs';

/** In-process schedule (no scheduler dependency). A session-level advisory lock on a dedicated connection keeps jobs to one instance at a time. */
@Injectable()
export class CashJobs implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private lastReconciliationAt: number | undefined;

  constructor(private readonly database: DataSource, private readonly reconciliation: ReconciliationService, private readonly maturity: MaturityService,
    @Inject(RUNTIME_OPTIONS) private readonly options: ApplicationOptions) {}

  onApplicationBootstrap(): void {
    if (!this.options.cashJobsEnabled) return;
    this.timer = setInterval(() => {
      this.tick().catch(() => this.options.logger.error({ code: 'CASH_JOBS_FAILED' }));
    }, TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void { clearInterval(this.timer); }

  /** One scheduler step. Maturity catches up when the API started after 00:30 Vietnam time. */
  async tick(): Promise<void> {
    await this.withJobLock(async () => {
      const now = this.options.clock.now();
      if (this.lastReconciliationAt === undefined || now.getTime() - this.lastReconciliationAt >= RECONCILIATION_EVERY_MS) {
        this.lastReconciliationAt = now.getTime();
        await this.reconciliation.run();
      }
      const today = vietnamDate(now);
      if (vietnamMinutesOfDay(now) >= MATURITY_AFTER_MINUTES && !await this.maturity.hasRunFor(today)) await this.maturity.run(today);
    });
  }

  runReconciliation() { return this.manual(() => this.reconciliation.run({ skipGrace: true })); }
  runMaturity(asOf?: string) { return this.manual(() => this.maturity.run(asOf)); }

  private async manual<T>(work: () => Promise<T>): Promise<T> {
    const outcome = await this.withJobLock(work);
    if (!outcome) throw new ApiError(409, 'JOB_RUNNING', 'Another job run is in progress');
    return outcome.value;
  }

  private withJobLock<T>(work: () => Promise<T>): Promise<{ value: T } | undefined> { return withJobLock(this.database, JOB_LOCK, work); }
}

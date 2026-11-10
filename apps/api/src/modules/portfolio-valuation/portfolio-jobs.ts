import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { ApplicationOptions } from '../../application.js';
import { ApiError } from '../../platform/http.js';
import { withJobLock } from '../../platform/job-lock.js';
import { RUNTIME_OPTIONS } from '../../platform/runtime.module.js';
import { appendAudit } from '../../platform/transactions.js';
import { JOB_CONTEXT, vietnamDate, vietnamMinutesOfDay } from '../accounts-ledger/cash.domain.js';
import { DriftScanner } from './drift-scanner.js';

const TICK_MS = 60_000;
const SNAPSHOT_AFTER_MINUTES = 17 * 60;
const JOB_LOCK = 'portfolio-jobs';
const JOB_ACTOR = { actorId: 'portfolio-job', role: 'SYSTEM_JOB' } as const;

export interface SnapshotRun { asOf: string; snapshots: number; skipped: number; failed: number; alerted: number; }

/** Daily valuation snapshot and drift scan. It looks for customers without today's snapshot, so a late start or a failed customer catches up by itself. */
@Injectable()
export class PortfolioJobs implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly database: DataSource, private readonly scanner: DriftScanner, @Inject(RUNTIME_OPTIONS) private readonly options: ApplicationOptions) {}

  onApplicationBootstrap(): void {
    if (!this.options.portfolioJobsEnabled) return;
    this.timer = setInterval(() => {
      this.tick().catch(() => this.options.logger.error({ code: 'PORTFOLIO_JOBS_FAILED' }));
    }, TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void { clearInterval(this.timer); }

  async tick(): Promise<void> {
    const now = this.options.clock.now();
    if (vietnamMinutesOfDay(now) < SNAPSHOT_AFTER_MINUTES) return;
    await withJobLock(this.database, JOB_LOCK, () => this.run(vietnamDate(now)));
  }

  /** Demo trigger; the date can be set to show a later day. */
  async runNow(asOf?: string): Promise<SnapshotRun> {
    const outcome = await withJobLock(this.database, JOB_LOCK, () => this.run(asOf ?? vietnamDate(this.options.clock.now())));
    if (!outcome) throw new ApiError(409, 'JOB_RUNNING', 'Another job run is in progress');
    return outcome.value;
  }

  private async run(asOf: string): Promise<SnapshotRun> {
    const result: SnapshotRun = { asOf, snapshots: 0, skipped: 0, failed: 0, alerted: 0 };
    const customers: Array<{ customer_id: string }> = await this.database.query(`SELECT ws.customer_id FROM wms.wealth_services ws JOIN wms.investment_accounts ia ON ia.customer_id=ws.customer_id
      WHERE ws.status='ACTIVE' AND NOT EXISTS (SELECT 1 FROM wms.portfolio_snapshots s WHERE s.customer_id=ws.customer_id AND s.snapshot_date=$1 AND s.snapshot_kind='DAILY')
      ORDER BY ws.customer_id`, [asOf]);
    for (const { customer_id: customerId } of customers) {
      const outcome = await this.scanner.scanQuietly(customerId, 'DAILY', asOf);
      if (!outcome) result.failed += 1;
      else if (outcome.skipped) result.skipped += 1;
      else if (outcome.snapshot) {
        result.snapshots += 1;
        if (outcome.alerts > 0) result.alerted += 1;
      }
    }
    // A customer waiting for a price is looked at every minute; only runs that did something are worth a row.
    if (result.snapshots > 0 || result.failed > 0) {
      await this.database.transaction(manager => appendAudit(manager, JOB_ACTOR, { type: 'PORTFOLIO_RUN', id: randomUUID() }, 'PORTFOLIO_SNAPSHOT_COMPLETED', result, this.options.clock.now(),
        { ...JOB_CONTEXT, before: null, after: result }));
    }
    return result;
  }
}

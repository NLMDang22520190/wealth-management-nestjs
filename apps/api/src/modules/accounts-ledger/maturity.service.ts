import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { ApplicationOptions } from '../../application.js';
import { RUNTIME_OPTIONS } from '../../platform/runtime.module.js';
import { appendAudit, appendSuccess } from '../../platform/transactions.js';
import { DriftScanner } from '../portfolio-valuation/drift-scanner.js';
import { TermDepositMaturity } from '../portfolio-valuation/term-deposit-maturity.js';
import { JOB_CONTEXT, MATURITY_ACTOR, vietnamDate } from './cash.domain.js';
import { lockAccount, nextRefNo } from './cash-store.js';
import { LedgerService } from './ledger.service.js';

export interface MaturityRun { asOf: string; settled: number; skipped: number; failed: Array<{ holdingId: string; code: string }>; }
const RUN_ACTION = 'MATURITY_RUN_COMPLETED';

/** UC-08. Money moves inside WMS only, so Core is not called; each deposit has its own transaction, so one failure stops only itself. */
@Injectable()
export class MaturityService {
  constructor(private readonly database: DataSource, private readonly ledger: LedgerService, private readonly deposits: TermDepositMaturity, private readonly scanner: DriftScanner,
    @Inject(RUNTIME_OPTIONS) private readonly options: ApplicationOptions) {}

  async run(asOf: string = vietnamDate(this.options.clock.now())): Promise<MaturityRun> {
    const result: MaturityRun = { asOf, settled: 0, skipped: 0, failed: [] };
    const settledAccounts = new Set<string>();
    for (const deposit of await this.deposits.due(this.database, asOf)) {
      try {
        if (await this.settle(deposit.holding_id, deposit.account_id)) {
          result.settled += 1;
          settledAccounts.add(deposit.account_id);
        }
        else result.skipped += 1;
      } catch {
        this.options.logger.error({ code: 'SETTLEMENT_FAILED', holdingId: deposit.holding_id });
        result.failed.push({ holdingId: deposit.holding_id, code: 'SETTLEMENT_FAILED' });
      }
    }
    if (settledAccounts.size > 0) await this.scanner.scanAccounts([...settledAccounts], asOf);
    await this.database.transaction(manager => appendAudit(manager, MATURITY_ACTOR, { type: 'MATURITY_RUN', id: randomUUID() }, RUN_ACTION, result,
      this.options.clock.now(), { ...JOB_CONTEXT, before: null, after: result }));
    return result;
  }

  private settle(holdingId: string, accountId: string): Promise<boolean> {
    return this.database.transaction(async manager => {
      const now = this.options.clock.now();
      await lockAccount(manager, accountId);
      const deposit = await this.deposits.lock(manager, holdingId);
      // BR-P2-06: a deposit settles once, however often the job runs.
      const [settled] = await manager.query('SELECT 1 FROM wms.maturity_settlements WHERE holding_id=$1', [holdingId]);
      if (deposit.status !== 'OPEN' || settled) return false;
      if (deposit.interest === null || deposit.total === null || deposit.days === null) throw new Error('Deposit terms are incomplete');
      const txnId = randomUUID();
      const refNo = await nextRefNo(manager, 'MAT', vietnamDate(now));
      await manager.query(`INSERT INTO wms.cash_transactions(txn_id,ref_no,account_id,txn_type,amount,status,created_at,completed_at)
        VALUES($1,$2,$3,'MATURITY_SETTLEMENT',$4,'SUCCESS',$5,$5)`, [txnId, refNo, accountId, deposit.total, now]);
      await manager.query(`INSERT INTO wms.maturity_settlements(txn_id,holding_id,settlement_key,principal_amount,interest_amount,days_held)
        VALUES($1,$2,$3,$4,$5,$6)`, [txnId, holdingId, `SETTLE-${holdingId}`, deposit.principal, deposit.interest, deposit.days]);
      // Interest of zero has no entry: the schema requires every entry amount to be positive.
      const interest = deposit.interest === '0.00' ? [] : [{ code: 'INTEREST_PAYABLE', amount: deposit.interest }];
      await this.ledger.post(manager, { accountId, cashTxnId: txnId, customerSide: 'CREDIT', amount: deposit.total,
        counter: [{ code: 'TERM_DEPOSIT', amount: deposit.principal }, ...interest], description: `Tất toán tiền gửi ${refNo}`, now });
      await this.deposits.close(manager, holdingId);
      const payload = { txnId, refNo, holdingId, principal: deposit.principal, interest: deposit.interest };
      await appendSuccess(manager, MATURITY_ACTOR, { type: 'CASH_TXN', id: txnId }, 'MATURITY_SETTLED', 'MaturitySettled', payload, now,
        { ...JOB_CONTEXT, before: { holdingStatus: 'OPEN' }, after: { holdingStatus: 'CLOSED', amount: deposit.total } });
      return true;
    });
  }

  async hasRunFor(day: string): Promise<boolean> {
    const [row] = await this.database.query("SELECT 1 FROM wms.audit_logs WHERE action=$1 AND new_value->>'asOf'=$2 LIMIT 1", [RUN_ACTION, day]);
    return Boolean(row);
  }

  async recentRuns() {
    const rows: Array<{ new_value: MaturityRun; created_at: Date }> = await this.database.query(
      'SELECT new_value,created_at FROM wms.audit_logs WHERE action=$1 ORDER BY log_id DESC LIMIT 20', [RUN_ACTION]);
    return { items: rows.map(row => ({ ...row.new_value, ranAt: row.created_at.toISOString() })) };
  }
}

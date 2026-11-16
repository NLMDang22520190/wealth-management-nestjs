import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import type { ApplicationOptions } from '../../application.js';
import type { Actor } from '../../auth/actor.js';
import { ApiError } from '../../platform/http.js';
import type { AuditContext } from '../../platform/http.js';
import { OtpService } from '../../platform/otp.service.js';
import { RUNTIME_OPTIONS } from '../../platform/runtime.module.js';
import { apiErrorCode, appendAudit, appendSuccess, idempotent, idempotencyReplay, recordOutcome } from '../../platform/transactions.js';
import { vietnamDate } from '../accounts-ledger/cash.domain.js';
import { lockAccount } from '../accounts-ledger/cash-store.js';
import { DriftScanner } from '../portfolio-valuation/drift-scanner.js';
import { ExecutionEngine, ExecutionFailure, quotes } from './execution.engine.js';
import type { MarketQuote } from './execution.engine.js';
import { MAX_OTP_ATTEMPTS, OTP_PURPOSE, SLIPPAGE_LIMIT } from './proposal.domain.js';
import type { ApproveProposalBody } from './proposal.domain.js';
import { assertPending, legsHash, loadLegs, loadProposal, nextCode, releaseAlert, scopeTeamTriggers, viewOf } from './proposal-store.js';
import { ProposalService } from './proposal.service.js';

const APPROVE = 'PROPOSAL_APPROVE';
const publicQuote = (quote: MarketQuote) => ({ legNo: quote.legNo, expectedPrice: quote.expectedPrice, currentPrice: quote.currentPrice, slippagePct: quote.slippagePct });

/** UC-15 and UC-16: the slippage guard, Smart OTP, then approval and execution in one transaction. */
@Injectable()
export class ApprovalService {
  constructor(private readonly database: DataSource, private readonly proposals: ProposalService, private readonly otp: OtpService, private readonly engine: ExecutionEngine,
    private readonly scanner: DriftScanner, @Inject(RUNTIME_OPTIONS) private readonly options: ApplicationOptions) {}

  private now(): Date { return this.options.clock.now(); }

  /** A pending proposal fails here, in its own transaction, so the 409 that follows does not undo it. */
  private async failForSlippage(actor: Actor, proposalId: string, legs: MarketQuote[], context: AuditContext): Promise<never> {
    const now = this.now();
    await this.database.transaction(async manager => {
      const row = (await loadProposal(manager, proposalId, true))!;
      if (row.status !== 'PENDING_APPROVAL') return;
      await this.markFailed(manager, actor, row.proposal_id, row.drift_alert_id, 'SLIPPAGE_EXCEEDED', null, context, now);
    });
    throw new ApiError(409, 'SLIPPAGE_EXCEEDED', 'Market prices moved more than 5% since the proposal was made', { legs: legs.map(publicQuote) });
  }

  private async markFailed(manager: EntityManager, actor: Actor, proposalId: string, alertId: string | null, reason: string, sessionCode: string | null, context: AuditContext, now: Date) {
    await scopeTeamTriggers(manager);
    await manager.query("UPDATE wms.proposals SET status='FAILED',failure_reason=$2,closed_at=$3 WHERE proposal_id=$1", [proposalId, reason, now]);
    if (sessionCode) {
      await manager.query(`INSERT INTO wms.execution_sessions(session_code,proposal_id,status,is_atomic_success,started_at,completed_at)
        VALUES($1,$2,'ROLLED_BACK',false,$3,$3)`, [sessionCode, proposalId, now]);
    }
    await releaseAlert(manager, alertId);
    await appendAudit(manager, actor, { type: 'PROPOSAL', id: proposalId }, 'PROPOSAL_FAILED', { proposalId, reason }, now,
      { ...context, before: { status: 'PENDING_APPROVAL' }, after: { status: 'FAILED', reason } });
  }

  async challenge(actor: Actor, proposalId: string, key: string | undefined, context: AuditContext) {
    const row = await this.proposals.own(actor, proposalId, context, 'PROPOSAL_CHALLENGE');
    const now = this.now();
    const replay = await idempotencyReplay(this.database.manager, actor.actorId, 'PROPOSAL_CHALLENGE', proposalId, key, {}, now);
    if (replay) return replay.response;
    assertPending(row, now);
    const market = await quotes(this.database.manager, proposalId, SLIPPAGE_LIMIT);
    if (market.some(quote => quote.exceeded)) await this.failForSlippage(actor, proposalId, market, context);
    let delivery: Awaited<ReturnType<OtpService['issue']>> | undefined;
    const response = await this.database.transaction(manager => idempotent(manager, actor.actorId, 'PROPOSAL_CHALLENGE', proposalId, key, {}, now, async () => {
      assertPending((await loadProposal(manager, proposalId, true))!, now);
      delivery = await this.otp.issue(manager, actor.actorId, OTP_PURPOSE, proposalId, legsHash(await loadLegs(manager, proposalId)));
      return { challengeId: delivery.challengeId, expiresAt: delivery.expiresAt, legs: market.map(publicQuote) };
    }, 201));
    // The code goes out after commit, never while a row lock is held.
    if (delivery) await this.otp.deliver(delivery);
    return response;
  }

  async approve(actor: Actor, proposalId: string, body: ApproveProposalBody, key: string | undefined, context: AuditContext) {
    const row = await this.proposals.own(actor, proposalId, context, APPROVE);
    const now = this.now();
    const replay = await idempotencyReplay(this.database.manager, actor.actorId, APPROVE, proposalId, key, body, now);
    if (replay) return replay.response;
    assertPending(row, now);
    const [challenge] = await this.database.query('SELECT attempt_count FROM wms.otp_challenges WHERE challenge_id=$1 AND purpose=$2 AND operation_id=$3',
      [body.challengeId, OTP_PURPOSE, proposalId]);
    if (challenge && challenge.attempt_count >= MAX_OTP_ATTEMPTS) throw new ApiError(409, 'OTP_ATTEMPTS_EXCEEDED', 'Too many wrong codes; request a new one');

    let executed = false;
    try {
      const result = await this.database.transaction(manager => idempotent(manager, actor.actorId, APPROVE, proposalId, key, body, now, async () => {
        await this.approveAndExecute(manager, actor, row.account_id, proposalId, body, context, now);
        executed = true;
        return viewOf(manager, proposalId);
      }));
      if (executed) await this.scanner.scanQuietly(row.customer_id, 'EXECUTION');
      return result;
    } catch (error) {
      if (apiErrorCode(error) === 'OTP_INVALID') {
        await recordOutcome(this.database, 'FAILURE', actor, { type: 'PROPOSAL', id: proposalId }, APPROVE, 'OTP_INVALID', now, context);
        await this.otp.recordFailedAttempt(this.database, body.challengeId);
        throw error;
      }
      if (error instanceof ApiError) throw error;
      const failure = error instanceof ExecutionFailure ? error : new ExecutionFailure('EXECUTION_ERROR', true);
      if (!(error instanceof ExecutionFailure)) this.options.logger.error({ code: 'PROPOSAL_EXECUTION_ERROR', proposalId });
      // BR-23: nothing of the attempt survived the rollback; the outcome is recorded on its own and replays like a success would.
      return this.database.transaction(manager => idempotent(manager, actor.actorId, APPROVE, proposalId, key, body, now, async () => {
        const current = (await loadProposal(manager, proposalId, true))!;
        if (current.status === 'PENDING_APPROVAL') {
          const sessionCode = failure.sessionStarted ? await nextCode(manager, 'execution_sessions', 'session_code', 'SESS', vietnamDate(now), 4) : null;
          await this.markFailed(manager, actor, proposalId, current.drift_alert_id, failure.code, sessionCode, context, now);
        }
        return viewOf(manager, proposalId);
      }));
    }
  }

  private async approveAndExecute(manager: EntityManager, actor: Actor, accountId: string, proposalId: string, body: ApproveProposalBody, context: AuditContext, now: Date) {
    await scopeTeamTriggers(manager);
    await lockAccount(manager, accountId);
    const proposal = (await loadProposal(manager, proposalId, true))!;
    assertPending(proposal, now);
    const legs = await loadLegs(manager, proposalId);
    const receipt = await this.otp.consume(manager, body.challengeId, body.code, actor.actorId, OTP_PURPOSE, proposalId, legsHash(legs));
    // Prices may have moved while the customer typed the code.
    const market = await quotes(manager, proposalId, SLIPPAGE_LIMIT);
    if (market.some(quote => quote.exceeded)) throw new ExecutionFailure('SLIPPAGE_EXCEEDED', false);
    // The team state trigger allows one step at a time.
    await manager.query("UPDATE wms.proposals SET status='APPROVED',otp_auth_ref=$2,approved_at=$3 WHERE proposal_id=$1", [proposalId, receipt, now]);
    await manager.query("UPDATE wms.proposals SET status='EXECUTING' WHERE proposal_id=$1", [proposalId]);
    const sessionId = randomUUID();
    const sessionCode = await nextCode(manager, 'execution_sessions', 'session_code', 'SESS', vietnamDate(now), 4);
    await manager.query("INSERT INTO wms.execution_sessions(session_id,session_code,proposal_id,status,started_at) VALUES($1,$2,$3,'IN_PROGRESS',$4)", [sessionId, sessionCode, proposalId, now]);
    await this.engine.execute(manager, proposal, legs, market, sessionId, vietnamDate(now), now);
    await manager.query("UPDATE wms.execution_sessions SET status='COMMITTED',is_atomic_success=true,completed_at=$2 WHERE session_id=$1", [sessionId, now]);
    await manager.query("UPDATE wms.proposals SET status='EXECUTED',executed_at=$2,closed_at=$2 WHERE proposal_id=$1", [proposalId, now]);
    await releaseAlert(manager, proposal.drift_alert_id);
    await appendSuccess(manager, actor, { type: 'PROPOSAL', id: proposalId }, 'PROPOSAL_EXECUTED', 'ProposalExecuted', { proposalId, customerId: proposal.customer_id, sessionCode }, now,
      { ...context, before: { status: 'PENDING_APPROVAL' }, after: { status: 'EXECUTED', sessionCode, legs: legs.length } });
  }
}

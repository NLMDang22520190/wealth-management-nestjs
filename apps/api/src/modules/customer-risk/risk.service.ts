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
import { apiErrorCode, appendAudit, appendSuccess, hash, idempotent, lockCustomer, recordOutcome } from '../../platform/transactions.js';
import { RiskHoldingsRead } from '../portfolio-valuation/risk-holdings-read.js';
import { CustomerAccess } from './customer-access.service.js';
import { draftProjection, profileExpiry, profileProjection, riskDraftUnexpired, scoreAnswers } from './risk.domain.js';
import type { RiskConfirmBody, RiskDraftBody, RiskDraftRow, RiskProfileRow, RiskQuestion } from './risk.domain.js';

const CONFIRM_PURPOSE = 'RISK_PROFILE_CONFIRM';

@Injectable()
export class RiskService {
  constructor(private readonly database: DataSource, private readonly otp: OtpService,
    private readonly access: CustomerAccess, private readonly holdings: RiskHoldingsRead,
    @Inject(RUNTIME_OPTIONS) private readonly options: ApplicationOptions) {}

  async questionnaire(actor: Actor) {
    await this.access.own(actor);
    const [row]: Array<{ version: string; questions: RiskQuestion[] }> = await this.database.query(
      "SELECT version,questions FROM risk_questionnaire_versions WHERE status='ACTIVE' AND effective_from <= $1 ORDER BY effective_from DESC LIMIT 1", [this.options.clock.now()]);
    if (!row) throw new ApiError(503, 'UNAVAILABLE', 'Risk questionnaire unavailable');
    return { version: row.version, questions: row.questions.map(question => ({ id: question.id, text: question.text,
      options: question.options.map(option => ({ id: option.id, text: option.text })) })) };
  }

  async draft(actor: Actor, body: RiskDraftBody, key: string | undefined, context: AuditContext) {
    const customer = await this.access.own(actor);
    return this.database.transaction(manager => idempotent(manager, actor.actorId, 'RISK_ASSESSMENT_DRAFT', customer.id,
      key, body, this.options.clock.now(), async () => {
        await lockCustomer(manager, customer.cif_id, []);
        const now = this.options.clock.now();
        const [questionnaire]: Array<{ questions: RiskQuestion[] }> = await manager.query(
          "SELECT questions FROM risk_questionnaire_versions WHERE version=$1 AND status='ACTIVE' AND effective_from <= $2 FOR SHARE", [body.questionnaireVersion, now]);
        if (!questionnaire) throw new ApiError(409, 'QUESTIONNAIRE_VERSION_MISMATCH', 'Questionnaire version is not current');
        const result = scoreAnswers(questionnaire.questions, body.answers);
        const current = await this.current(manager, customer.id);
        const expectedVersion = current?.version ?? 0;
        const id = randomUUID();
        // DECISION[S2]: a preview lasts 24 hours; changing answers creates a new immutable preview.
        const expiresAt = new Date(now.getTime() + 24 * 3_600_000);
        const payloadHash = hash(JSON.stringify([id, customer.id, body.questionnaireVersion, body.answers, result, expectedVersion,
          now.toISOString(), expiresAt.toISOString()]));
        const [draft]: RiskDraftRow[] = await manager.query(`INSERT INTO risk_assessment_drafts
          (id,customer_id,questionnaire_version,answers,score,category,max_product_risk,allocation,expected_current_profile_version,payload_hash,created_at,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [id, customer.id, body.questionnaireVersion,
          JSON.stringify(body.answers), result.score, result.category, result.maxProductRisk, JSON.stringify(result.allocation),
          expectedVersion, payloadHash, now, expiresAt]);
        const auditResult = { id, questionnaireVersion: draft.questionnaire_version,
          expectedCurrentProfileVersion: expectedVersion, score: draft.score, category: draft.category };
        await appendAudit(manager, actor.actorId, id, 'RISK_DRAFT_CREATED', auditResult, now,
          { ...context, before: null, after: auditResult });
        return draftProjection(draft);
      }));
  }

  async isDraft(id: string): Promise<boolean> {
    const [row] = await this.database.query('SELECT id FROM risk_assessment_drafts WHERE id=$1', [id]);
    return Boolean(row);
  }

  private async ownDraft(manager: EntityManager, actor: Actor, id: string): Promise<RiskDraftRow & { cif_id: string }> {
    const [draft] = await manager.query(`SELECT d.*,c.cif_id FROM risk_assessment_drafts d
      JOIN customers c ON c.id=d.customer_id WHERE d.id=$1`, [id]);
    if (!draft) throw new ApiError(404, 'NOT_FOUND', 'Resource not found');
    if (actor.role !== 'CUSTOMER' || actor.cifId !== draft.cif_id) throw new ApiError(403, 'FORBIDDEN', 'Access denied');
    return draft;
  }

  async challenge(actor: Actor, purpose: string, id: string, context: AuditContext) {
    const draft = await this.ownDraft(this.database.manager, actor, id);
    if (purpose !== CONFIRM_PURPOSE) throw new ApiError(400, 'OTP_PURPOSE_MISMATCH', 'OTP purpose does not match this operation');
    const delivery = await this.database.transaction(async manager => {
      await lockCustomer(manager, draft.cif_id, []);
      const current = await this.ownDraft(manager, actor, id);
      riskDraftUnexpired(current, this.options.clock.now());
      const delivery = await this.otp.issue(manager, actor.actorId, purpose, id, current.payload_hash);
      const result = { challengeId: delivery.challengeId, purpose, operationId: id };
      await appendAudit(manager, actor.actorId, delivery.challengeId, 'OTP_ISSUED', result, this.options.clock.now(),
        { ...context, before: null, after: result });
      return delivery;
    });
    // Network delivery starts only after all local locks have been released.
    await this.otp.deliver(delivery);
    return { challengeId: delivery.challengeId, expiresAt: delivery.expiresAt };
  }

  private async current(manager: EntityManager, customerId: string): Promise<RiskProfileRow | undefined> {
    const [service] = await manager.query('SELECT current_risk_profile_id FROM wealth_services WHERE customer_id=$1', [customerId]);
    if (!service) throw new ApiError(404, 'NOT_FOUND', 'Resource not found');
    if (!service.current_risk_profile_id) return undefined;
    const [profile] = await manager.query('SELECT * FROM risk_profiles WHERE id=$1 AND customer_id=$2', [service.current_risk_profile_id, customerId]);
    return profile;
  }

  async confirm(actor: Actor, id: string, body: RiskConfirmBody, key: string | undefined, context: AuditContext) {
    const initialDraft = await this.ownDraft(this.database.manager, actor, id);
    try {
      return await this.confirmTransaction(actor, id, body, key, context, initialDraft);
    } catch (error) {
      if (apiErrorCode(error) === 'OTP_INVALID') {
        await recordOutcome(this.database, 'FAILURE', actor.actorId, id, 'RISK_PROFILE_CONFIRM', 'OTP_INVALID', this.options.clock.now(), context);
      }
      throw error;
    }
  }

  private confirmTransaction(actor: Actor, id: string, body: RiskConfirmBody, key: string | undefined, context: AuditContext,
    initialDraft: { cif_id: string }) {
    return this.database.transaction(manager => idempotent(manager, actor.actorId, CONFIRM_PURPOSE, id, key, body,
      this.options.clock.now(), async () => {
        await lockCustomer(manager, initialDraft.cif_id, []);
        const draft = await this.ownDraft(manager, actor, id);
        const now = this.options.clock.now();
        riskDraftUnexpired(draft, now);
        const [questionnaire] = await manager.query(
          "SELECT 1 FROM risk_questionnaire_versions WHERE version=$1 AND status='ACTIVE' FOR SHARE", [draft.questionnaire_version]);
        if (!questionnaire) throw new ApiError(409, 'QUESTIONNAIRE_VERSION_MISMATCH', 'Questionnaire version is not current');
        if (body.expectedCurrentProfileVersion !== draft.expected_current_profile_version) {
          throw new ApiError(409, 'RISK_PROFILE_STALE', 'Risk profile changed; create a new preview');
        }
        const receipt = await this.otp.consume(manager, body.challengeId, body.code, actor.actorId, CONFIRM_PURPOSE, id, draft.payload_hash);
        const previous = await this.current(manager, draft.customer_id);
        if ((previous?.version ?? 0) !== draft.expected_current_profile_version) {
          throw new ApiError(409, 'RISK_PROFILE_STALE', 'Risk profile changed; create a new preview');
        }
        const profileId = randomUUID();
        const version = draft.expected_current_profile_version + 1;
        const [profile]: RiskProfileRow[] = await manager.query(`INSERT INTO risk_profiles
          (id,customer_id,draft_id,questionnaire_version,answers,score,category,max_product_risk,allocation,version,confirmed_at,expires_at,otp_receipt_ref,payload_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
          [profileId, draft.customer_id, id, draft.questionnaire_version, JSON.stringify(draft.answers), draft.score, draft.category,
            draft.max_product_risk, JSON.stringify(draft.allocation), version, now, profileExpiry(now), receipt, draft.payload_hash]);
        await manager.query("UPDATE wealth_services SET status='ACTIVE',current_risk_profile_id=$2 WHERE customer_id=$1", [draft.customer_id, profileId]);
        const result = profileProjection(profile, now);
        await appendSuccess(manager, actor.actorId, profileId, 'RISK_PROFILE_CONFIRMED', 'RiskProfileConfirmed',
          { customerId: draft.customer_id, profileId, version }, now,
          { ...context, before: { currentProfileId: previous?.id ?? null, version: previous?.version ?? 0 },
            after: { currentProfileId: profileId, version } });
        if (previous && draft.max_product_risk < previous.max_product_risk) {
          await manager.query(`INSERT INTO outbox_events(id,event_type,aggregate_id,payload,created_at)
            VALUES($1,'RiskHoldingsCheckRequested',$2,$3,$4)`, [randomUUID(), draft.customer_id,
            JSON.stringify({ customerId: draft.customer_id, profileId, previousProfileId: previous.id, checkHoldings: true, triggerDrift: true }), now]);
        }
        return result;
      }));
  }

  async profile(actor: Actor, customerId?: string) {
    const customer = customerId ? await this.access.staff(actor, customerId) : await this.access.own(actor);
    const current = await this.current(this.database.manager, customer.id);
    if (!current) return { current: null, holdingsCheck: null };
    const [pending] = await this.database.query(`SELECT id FROM outbox_events
      WHERE aggregate_id=$1 AND event_type='RiskHoldingsCheckRequested' AND payload->>'profileId'=$2 AND published_at IS NULL LIMIT 1`, [customer.id, current.id]);
    return { current: profileProjection(current, this.options.clock.now()),
      holdingsCheck: pending ? await this.holdings.pending(customer.id, current.id, current.max_product_risk) : null };
  }

  async history(actor: Actor, paging: { page: number; pageSize: number }, customerId?: string) {
    const customer = customerId ? await this.access.staff(actor, customerId) : await this.access.own(actor);
    const [count] = await this.database.query('SELECT count(*) AS total FROM risk_profiles WHERE customer_id=$1', [customer.id]);
    const rows: RiskProfileRow[] = await this.database.query('SELECT * FROM risk_profiles WHERE customer_id=$1 ORDER BY version DESC LIMIT $2 OFFSET $3',
      [customer.id, paging.pageSize, (paging.page - 1) * paging.pageSize]);
    const now = this.options.clock.now();
    return { items: rows.map(row => profileProjection(row, now)), total: Number(count.total), ...paging };
  }

  /** Reads the immutable current profile within a transaction owned and locked by the caller. */
  async eligibility(actor: Actor, customerId: string, manager: EntityManager, validAt: Date) {
    await this.access.authorize(actor, customerId, manager);
    const profile = await this.current(manager, customerId);
    if (!profile) throw new ApiError(422, 'RISK_PROFILE_REQUIRED', 'Confirmed risk profile is required');
    return { profileId: profile.id, version: profile.version, category: profile.category,
      maxProductRisk: profile.max_product_risk, allocation: profile.allocation,
      expiresAt: new Date(profile.expires_at).toISOString(), validAt: validAt.toISOString(),
      valid: validAt.getTime() < new Date(profile.expires_at).getTime() };
  }
}

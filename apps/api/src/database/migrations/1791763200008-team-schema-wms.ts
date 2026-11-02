import { readFileSync } from 'node:fs';
import type { MigrationInterface, QueryRunner } from 'typeorm';
import { MockActors1791763200000 } from './1791763200000-mock-actors.js';
import { Onboarding1791763200001 } from './1791763200001-onboarding.js';
import { AuditMetadata1791763200002 } from './1791763200002-audit-metadata.js';
import { RiskProfiles1791763200003 } from './1791763200003-risk-profiles.js';
import { QuestionnaireRetirement1791763200004 } from './1791763200004-questionnaire-retirement.js';
import { RmAssignment1791763200005 } from './1791763200005-rm-assignment.js';
import { VietnameseQuestionnaire1791763200006 } from './1791763200006-vietnamese-questionnaire.js';
import { CustomerNotifications1791763200007 } from './1791763200007-customer-notifications.js';

/** Team DDL, vendored byte-identical; the build copies it next to the compiled migrations. */
const TEAM_DDL = new URL('../team/wms_schema.sql', import.meta.url);

/**
 * Additive patches on top of the team DDL (names are new; nothing of the team's is renamed):
 * (a) rm_assignments.version is allocated per customer when omitted;
 * (b) composite FKs keep a risk profile / draft with the customer that owns it;
 * (c) one service consent per customer;
 * (d) a questionnaire version may only change ACTIVE -> RETIRED.
 */
const PATCHES = `
CREATE FUNCTION wms.fn_rm_assignment_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.version IS NULL THEN
    SELECT COALESCE(MAX(version), 0) + 1 INTO NEW.version FROM wms.rm_assignments WHERE customer_id = NEW.customer_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_rm_assignment_version BEFORE INSERT ON wms.rm_assignments
  FOR EACH ROW EXECUTE FUNCTION wms.fn_rm_assignment_version();

ALTER TABLE wms.risk_profiles ADD CONSTRAINT uq_risk_profile_owner UNIQUE (risk_profile_id, customer_id);
ALTER TABLE wms.risk_assessment_drafts ADD CONSTRAINT uq_draft_owner UNIQUE (draft_id, customer_id);
ALTER TABLE wms.wealth_services ADD CONSTRAINT fk_ws_current_profile_owner
  FOREIGN KEY (current_risk_profile_id, customer_id) REFERENCES wms.risk_profiles (risk_profile_id, customer_id);
ALTER TABLE wms.risk_profiles ADD CONSTRAINT fk_rp_draft_owner
  FOREIGN KEY (draft_id, customer_id) REFERENCES wms.risk_assessment_drafts (draft_id, customer_id);

ALTER TABLE wms.service_consents ADD CONSTRAINT uq_consent_customer UNIQUE (customer_id);

CREATE OR REPLACE FUNCTION wms.fn_questionnaire_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'ACTIVE' AND NEW.status = 'RETIRED'
     AND NEW.version = OLD.version AND NEW.questions IS NOT DISTINCT FROM OLD.questions
     AND NEW.effective_from = OLD.effective_from THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Phiên bản bộ câu hỏi % chỉ được chuyển từ ACTIVE sang RETIRED (BR-P1-03)', OLD.version;
END $$;
`;

const LEGACY_TABLES = ['customer_notifications', 'proposals', 'holdings_read_snapshots', 'risk_profiles', 'risk_assessment_drafts',
  'risk_questionnaire_versions', 'rm_assignment_history', 'investment_accounts', 'wealth_services', 'service_consents',
  'rm_capacity_reservations', 'onboarding_requests', 'otp_challenges', 'idempotency_records', 'audit_events', 'outbox_events',
  'customers', 'service_terms', 'mock_actors'];
const LEGACY_FUNCTIONS = ['reject_immutable_mutation', 'reject_used_questionnaire_mutation', 'allocate_assignment_version'];

/** The only changes to the team script: its destructive DROP SCHEMA is skipped and its session-wide SET becomes transaction-local. */
function teamDdl(): string {
  const original = readFileSync(TEAM_DDL, 'utf8');
  const withoutDrop = original.replace('DROP SCHEMA IF EXISTS wms CASCADE;', '');
  const local = withoutDrop.replace('SET search_path TO wms, public;', 'SET LOCAL search_path TO wms, public;');
  if (withoutDrop === original || local === withoutDrop) throw new Error('Team DDL no longer has the expected statements');
  return local;
}

/** Moves the demo P1 data model from the public schema to the team schema `wms` (R9). */
export class TeamSchemaWms1791763200008 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    // Reference content the repo owns (migrations 001/003/006) is carried over; everything else in the old tables is demo data.
    const questionnaires: Array<{ version: string; questions: unknown; status: string; effective_from: Date }> = await runner.query(
      "SELECT version,questions,status,effective_from FROM public.risk_questionnaire_versions ORDER BY (status='ACTIVE'),effective_from");
    const terms: Array<{ version: string; content: string; content_hash: string }> = await runner.query(
      'SELECT version,content,content_hash FROM public.service_terms');
    const [{ search_path: searchPath }] = await runner.query('SHOW search_path');

    await runner.query(teamDdl());
    await runner.query(PATCHES);
    for (const item of questionnaires) {
      await runner.query('INSERT INTO wms.risk_questionnaire_versions(version,questions,status,effective_from) VALUES($1,$2,$3,$4)',
        [item.version, JSON.stringify(item.questions), item.status, item.effective_from]);
    }
    // Effective long before any team terms so that team seed terms, when loaded, are the latest.
    for (const item of terms) {
      await runner.query('INSERT INTO wms.service_terms(terms_version,content,content_hash,effective_from) VALUES($1,$2,$3,$4)',
        [item.version, item.content, item.content_hash, '2024-01-01T00:00:00.000Z']);
    }
    await runner.query(`DROP TABLE IF EXISTS ${LEGACY_TABLES.map(name => `public.${name}`).join(', ')} CASCADE`);
    for (const name of LEGACY_FUNCTIONS) await runner.query(`DROP FUNCTION IF EXISTS public.${name}()`);
    await runner.query("SELECT set_config('search_path', $1, true)", [searchPath]);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP SCHEMA IF EXISTS wms CASCADE');
    // The pre-008 model is rebuilt empty by replaying its own migrations.
    for (const migration of [new MockActors1791763200000(), new Onboarding1791763200001(), new AuditMetadata1791763200002(),
      new RiskProfiles1791763200003(), new QuestionnaireRetirement1791763200004(), new RmAssignment1791763200005(),
      new VietnameseQuestionnaire1791763200006(), new CustomerNotifications1791763200007()]) {
      await migration.up(runner);
    }
  }
}

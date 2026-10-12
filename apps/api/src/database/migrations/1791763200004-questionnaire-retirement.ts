import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Retirement changes lifecycle metadata while used questionnaire content stays immutable. */
export class QuestionnaireRetirement1791763200004 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE OR REPLACE FUNCTION reject_used_questionnaire_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM risk_assessment_drafts WHERE questionnaire_version=OLD.version) THEN
          IF TG_OP='UPDATE' THEN
            IF OLD.status='ACTIVE' AND NEW.status='RETIRED'
              AND NEW.version IS NOT DISTINCT FROM OLD.version
              AND NEW.questions IS NOT DISTINCT FROM OLD.questions
              AND NEW.effective_from IS NOT DISTINCT FROM OLD.effective_from THEN
              RETURN NEW;
            END IF;
          END IF;
          RAISE EXCEPTION 'Used questionnaire is immutable';
        END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END;
    $$;`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE OR REPLACE FUNCTION reject_used_questionnaire_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM risk_assessment_drafts WHERE questionnaire_version=OLD.version) THEN
          RAISE EXCEPTION 'Used questionnaire is immutable';
        END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END;
    $$;`);
  }
}

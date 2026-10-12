import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Versioned demonstration content; ordered options carry server-owned points 1–5. */
const questions = [
  ['Investment objective', ['Preserve capital', 'Earn steady income', 'Balance income and growth', 'Seek long-term growth', 'Maximize long-term growth']],
  ['Investment horizon', ['Less than one year', 'One to two years', 'Two to five years', 'Five to ten years', 'More than ten years']],
  ['Tolerance for a temporary decline', ['No decline', 'Up to 5%', 'Up to 10%', 'Up to 20%', 'More than 20%']],
  ['Response to a falling market', ['Exit immediately', 'Reduce most exposure', 'Keep the current plan', 'Add a small amount', 'Increase exposure significantly']],
  ['Investment experience', ['No experience', 'Deposits only', 'Bonds and diversified funds', 'Equities and equity funds', 'A broad range of volatile investments']],
  ['Income stability', ['Very uncertain', 'Somewhat uncertain', 'Moderately stable', 'Stable', 'Very stable with several sources']],
  ['Emergency reserves', ['No reserves', 'Less than three months', 'Three to six months', 'Six to twelve months', 'More than twelve months']],
  ['Dependence on invested funds', ['Needed for essential spending now', 'Needed within one year', 'May be needed within three years', 'Unlikely to be needed soon', 'Not needed for foreseeable expenses']],
  ['Preference for return and volatility', ['Lowest volatility', 'Mostly stable returns', 'Moderate growth and volatility', 'Higher growth with volatility', 'Highest growth potential with large volatility']],
  ['Share of assets available for growth investing', ['Very little', 'A small share', 'A moderate share', 'A large share', 'Most of my investable assets']],
].map(([text, options], index) => ({ id: `q${index + 1}`, text,
  options: (options as string[]).map((option, optionIndex) => ({ id: `o${optionIndex + 1}`, text: option, points: optionIndex + 1 })) }));

export class RiskProfiles1791763200003 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE risk_questionnaire_versions (
        version text PRIMARY KEY, questions jsonb NOT NULL CHECK (jsonb_typeof(questions)='array' AND jsonb_array_length(questions)=10),
        status text NOT NULL CHECK (status IN ('ACTIVE','RETIRED')), effective_from timestamptz NOT NULL
      );
      CREATE UNIQUE INDEX one_active_questionnaire ON risk_questionnaire_versions(status) WHERE status='ACTIVE';
      CREATE TABLE risk_assessment_drafts (
        id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customers(id),
        questionnaire_version text NOT NULL REFERENCES risk_questionnaire_versions(version),
        answers jsonb NOT NULL CHECK (jsonb_typeof(answers)='array' AND jsonb_array_length(answers)=10),
        score integer NOT NULL CHECK (score BETWEEN 10 AND 50),
        category text NOT NULL CHECK (category IN ('CONSERVATIVE','BALANCED','GROWTH')),
        max_product_risk integer NOT NULL CHECK (max_product_risk BETWEEN 1 AND 5), allocation jsonb NOT NULL,
        expected_current_profile_version integer NOT NULL CHECK (expected_current_profile_version>=0),
        payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
        created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL CHECK (expires_at>created_at),
        UNIQUE(id,customer_id)
      );
      CREATE INDEX risk_drafts_customer ON risk_assessment_drafts(customer_id);
      CREATE TABLE risk_profiles (
        id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customers(id), draft_id uuid UNIQUE NOT NULL,
        questionnaire_version text NOT NULL REFERENCES risk_questionnaire_versions(version),
        answers jsonb NOT NULL, score integer NOT NULL CHECK (score BETWEEN 10 AND 50),
        category text NOT NULL CHECK (category IN ('CONSERVATIVE','BALANCED','GROWTH')),
        max_product_risk integer NOT NULL CHECK (max_product_risk BETWEEN 1 AND 5), allocation jsonb NOT NULL,
        version integer NOT NULL CHECK (version>0), confirmed_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
        otp_receipt_ref uuid UNIQUE NOT NULL, payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
        FOREIGN KEY(draft_id,customer_id) REFERENCES risk_assessment_drafts(id,customer_id),
        UNIQUE(customer_id,version), UNIQUE(id,customer_id)
      );
      ALTER TABLE wealth_services ADD CONSTRAINT current_risk_profile_owner
        FOREIGN KEY(current_risk_profile_id,customer_id) REFERENCES risk_profiles(id,customer_id);
      CREATE TRIGGER risk_profile_append_only BEFORE UPDATE OR DELETE ON risk_profiles
        FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
      CREATE TRIGGER risk_draft_immutable BEFORE UPDATE OR DELETE ON risk_assessment_drafts
        FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
      CREATE TRIGGER consent_append_only BEFORE UPDATE OR DELETE ON service_consents
        FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
      CREATE FUNCTION reject_used_questionnaire_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF EXISTS (SELECT 1 FROM risk_assessment_drafts WHERE questionnaire_version=OLD.version) THEN
            RAISE EXCEPTION 'Used questionnaire is immutable';
          END IF;
          IF TG_OP='DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END;
      $$;
      CREATE TRIGGER used_questionnaire_immutable BEFORE UPDATE OR DELETE ON risk_questionnaire_versions
        FOR EACH ROW EXECUTE FUNCTION reject_used_questionnaire_mutation();
      CREATE TABLE holdings_read_snapshots (
        id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customers(id), product_id text NOT NULL,
        product_risk integer NOT NULL CHECK (product_risk BETWEEN 1 AND 5), asset_class text NOT NULL,
        quantity numeric NOT NULL CHECK (quantity>=0), market_value numeric NOT NULL CHECK (market_value>=0),
        as_of timestamptz NOT NULL, provenance text NOT NULL
      );
      CREATE INDEX holdings_customer_product_time ON holdings_read_snapshots(customer_id,product_id,as_of DESC);
    `);
    await runner.query(`INSERT INTO risk_questionnaire_versions(version,questions,status,effective_from)
      VALUES($1,$2,'ACTIVE',$3)`, ['demo-risk-v1', JSON.stringify(questions), '2026-01-01T00:00:00.000Z']);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE wealth_services DROP CONSTRAINT current_risk_profile_owner;
      DROP TRIGGER consent_append_only ON service_consents;
      DROP TABLE holdings_read_snapshots,risk_profiles,risk_assessment_drafts,risk_questionnaire_versions;
      DROP FUNCTION reject_used_questionnaire_mutation();`);
  }
}

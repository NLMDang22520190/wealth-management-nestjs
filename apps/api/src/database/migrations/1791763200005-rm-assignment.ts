import type { MigrationInterface, QueryRunner } from 'typeorm';

export class RmAssignment1791763200005 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      ALTER TABLE rm_assignment_history ADD COLUMN version integer NULL,
        ADD COLUMN assigned_by text NULL, ADD COLUMN reason text NULL;
      WITH versions AS (SELECT id,row_number() OVER (PARTITION BY customer_id ORDER BY valid_from,id)::integer AS version
        FROM rm_assignment_history)
        UPDATE rm_assignment_history h SET version=v.version FROM versions v WHERE h.id=v.id;
      ALTER TABLE rm_assignment_history ALTER COLUMN version SET NOT NULL,
        ADD CONSTRAINT assignment_version_positive CHECK(version>0);
      ALTER TABLE rm_assignment_history ADD CONSTRAINT assignment_customer_version UNIQUE(customer_id,version);
      -- Legacy inserts omit version: first assignment is 1, later assignments remain monotonic.
      -- Explicit versions are never rewritten; the positive/unique constraints remain authoritative.
      CREATE FUNCTION allocate_assignment_version() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.version IS NULL THEN
            SELECT COALESCE(MAX(version),0)+1 INTO NEW.version FROM rm_assignment_history WHERE customer_id=NEW.customer_id;
          END IF;
          RETURN NEW;
        END;
      $$;
      CREATE TRIGGER assignment_version_default BEFORE INSERT ON rm_assignment_history
        FOR EACH ROW EXECUTE FUNCTION allocate_assignment_version();
      CREATE TABLE proposals (
        id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customers(id), author_rm_id uuid NOT NULL,
        status text NOT NULL CHECK(status IN ('PENDING_APPROVAL','EXECUTED','REJECTED','CANCELLED','EXPIRED','FAILED')),
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, cancellation_reason text NULL
      );
      CREATE INDEX proposals_customer_author_pending ON proposals(customer_id,author_rm_id) WHERE status='PENDING_APPROVAL';
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP TABLE proposals;
      DROP TRIGGER assignment_version_default ON rm_assignment_history;
      DROP FUNCTION allocate_assignment_version();
      ALTER TABLE rm_assignment_history DROP CONSTRAINT assignment_customer_version,
        DROP COLUMN version, DROP COLUMN assigned_by, DROP COLUMN reason;`);
  }
}

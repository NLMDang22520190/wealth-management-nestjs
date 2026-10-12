import { createHash } from 'node:crypto';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Onboarding1791763200001 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE service_terms (
        version text PRIMARY KEY, content text NOT NULL, content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$')
      );
      CREATE TABLE customers (
        id uuid PRIMARY KEY, cif_id text UNIQUE NOT NULL, name text NOT NULL, created_at timestamptz NOT NULL
      );
      CREATE TABLE onboarding_requests (
        id uuid PRIMARY KEY, cif_id text NOT NULL, customer_name text NOT NULL, selected_account_id text NOT NULL,
        rm_id uuid NOT NULL, team_id uuid NOT NULL,
        status text NOT NULL CHECK (status IN ('PENDING_CONSENT','CONFIRMED','EXPIRED')),
        terms_version text NOT NULL REFERENCES service_terms(version), terms_hash text NOT NULL,
        created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL
      );
      CREATE UNIQUE INDEX onboarding_pending_cif ON onboarding_requests(cif_id) WHERE status='PENDING_CONSENT';
      CREATE TABLE rm_capacity_reservations (
        id uuid PRIMARY KEY, onboarding_request_id uuid UNIQUE NOT NULL REFERENCES onboarding_requests(id),
        rm_id uuid NOT NULL, status text NOT NULL CHECK (status IN ('ACTIVE','CONSUMED','EXPIRED')), expires_at timestamptz NOT NULL
      );
      CREATE TABLE otp_challenges (
        id uuid PRIMARY KEY, actor_id text NOT NULL, purpose text NOT NULL, operation_id uuid NOT NULL,
        payload_hash text NOT NULL, code_hash text NOT NULL CHECK (code_hash ~ '^[a-f0-9]{64}$'), salt text NOT NULL,
        expires_at timestamptz NOT NULL, consumed_at timestamptz NULL, receipt_ref uuid NULL
      );
      CREATE TABLE service_consents (
        id uuid PRIMARY KEY, request_id uuid UNIQUE NOT NULL REFERENCES onboarding_requests(id),
        customer_id uuid UNIQUE NOT NULL REFERENCES customers(id), terms_version text NOT NULL REFERENCES service_terms(version),
        terms_hash text NOT NULL, otp_receipt_ref uuid UNIQUE NOT NULL, created_at timestamptz NOT NULL
      );
      CREATE TABLE wealth_services (
        id uuid PRIMARY KEY, customer_id uuid UNIQUE NOT NULL REFERENCES customers(id),
        status text NOT NULL, linked_payment_account_id text NOT NULL, consent_id uuid UNIQUE NOT NULL REFERENCES service_consents(id),
        current_risk_profile_id uuid NULL, created_at timestamptz NOT NULL
      );
      CREATE TABLE investment_accounts (
        id uuid PRIMARY KEY, customer_id uuid UNIQUE NOT NULL REFERENCES customers(id),
        currency text NOT NULL CHECK (currency='VND'), balance numeric NOT NULL DEFAULT 0 CHECK (balance >= 0), created_at timestamptz NOT NULL
      );
      CREATE TABLE rm_assignment_history (
        id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customers(id), rm_id uuid NOT NULL, team_id uuid NOT NULL,
        valid_from timestamptz NOT NULL, valid_to timestamptz NULL, provisional boolean NOT NULL
      );
      CREATE UNIQUE INDEX one_current_rm ON rm_assignment_history(customer_id) WHERE valid_to IS NULL;
      CREATE TABLE idempotency_records (
        scope text NOT NULL, key text NOT NULL, payload_hash text NOT NULL, response jsonb NOT NULL,
        created_at timestamptz NOT NULL, PRIMARY KEY(scope,key)
      );
      CREATE TABLE audit_events (
        id uuid PRIMARY KEY, action text NOT NULL, outcome text NOT NULL, actor_id text NOT NULL,
        resource_id uuid NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL
      );
      CREATE TABLE outbox_events (
        id uuid PRIMARY KEY, event_type text NOT NULL, aggregate_id uuid NOT NULL, payload jsonb NOT NULL,
        created_at timestamptz NOT NULL, published_at timestamptz NULL
      );
      CREATE FUNCTION reject_immutable_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Immutable record'; END;
      $$;
      CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
      CREATE TRIGGER terms_immutable BEFORE UPDATE OR DELETE ON service_terms FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
    `);
    const terms = 'Demo service terms: registration creates an investment account with zero balance. Investment decisions require the separate risk assessment and approval workflows. This sample is for demonstration only.';
    await runner.query('INSERT INTO service_terms(version,content,content_hash) VALUES($1,$2,$3)',
      ['demo-v1', terms, createHash('sha256').update(terms).digest('hex')]);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP TABLE outbox_events, audit_events, idempotency_records, rm_assignment_history,
      investment_accounts, wealth_services, service_consents, otp_challenges, rm_capacity_reservations,
      onboarding_requests, customers, service_terms; DROP FUNCTION reject_immutable_mutation();`);
  }
}

import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CustomerNotifications1791763200007 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE customer_notifications (
        id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customers(id),
        kind text NOT NULL CHECK(kind IN ('RISK_SURVEY_REMINDER')),
        message text NOT NULL, created_by text NOT NULL,
        created_at timestamptz NOT NULL, read_at timestamptz NULL
      );
      CREATE INDEX customer_notifications_customer_created ON customer_notifications(customer_id, created_at DESC);
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE customer_notifications;');
  }
}

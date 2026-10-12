import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AuditMetadata1791763200002 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query("ALTER TABLE audit_events ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb");
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE audit_events DROP COLUMN metadata');
  }
}

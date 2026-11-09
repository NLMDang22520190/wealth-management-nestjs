import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * UC-12 scans after a price change, a settlement or a new risk profile, and every alert must point at the snapshot it came from. The team DDL allows
 * one snapshot per customer per day, which would leave no room for the 17:00 one. Daily snapshots stay unique; event snapshots are not limited.
 */
export class SnapshotKind1791763200009 implements MigrationInterface {
  name = 'SnapshotKind1791763200009';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE wms.portfolio_snapshots ADD COLUMN snapshot_kind VARCHAR(10) NOT NULL DEFAULT 'DAILY',
        ADD CONSTRAINT chk_snapshot_kind CHECK (snapshot_kind IN ('DAILY', 'EVENT')),
        DROP CONSTRAINT portfolio_snapshots_customer_id_snapshot_date_key;
      CREATE UNIQUE INDEX ux_snapshot_daily ON wms.portfolio_snapshots (customer_id, snapshot_date) WHERE snapshot_kind = 'DAILY'`);
  }

  /** The table is append-only, so its trigger is off while event snapshots and the alerts pointing at them go. */
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM wms.drift_alerts WHERE snapshot_id IN (SELECT snapshot_id FROM wms.portfolio_snapshots WHERE snapshot_kind = 'EVENT');
      ALTER TABLE wms.portfolio_snapshots DISABLE TRIGGER trg_portfolio_snapshots_append_only;
      DELETE FROM wms.portfolio_snapshots WHERE snapshot_kind = 'EVENT';
      ALTER TABLE wms.portfolio_snapshots ENABLE TRIGGER trg_portfolio_snapshots_append_only;
      DROP INDEX wms.ux_snapshot_daily;
      ALTER TABLE wms.portfolio_snapshots DROP CONSTRAINT chk_snapshot_kind, DROP COLUMN snapshot_kind,
        ADD CONSTRAINT portfolio_snapshots_customer_id_snapshot_date_key UNIQUE (customer_id, snapshot_date)`);
  }
}

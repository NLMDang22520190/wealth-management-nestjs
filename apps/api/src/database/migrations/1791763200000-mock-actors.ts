import type { MigrationInterface, QueryRunner } from 'typeorm';

export class MockActors1791763200000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE public.mock_actors (
      actor_id text PRIMARY KEY,
      subject_id text UNIQUE NOT NULL,
      role text NOT NULL CHECK (role IN ('RM', 'LEADER', 'CUSTOMER')),
      cif_id text NULL,
      rm_id uuid NULL,
      team_id uuid NULL,
      active boolean NOT NULL DEFAULT true
    )`);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE public.mock_actors');
  }
}

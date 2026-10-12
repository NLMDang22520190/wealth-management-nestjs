import type { DataSource } from 'typeorm';

export const actors = {
  rm: {
    actorId: 'rm-alpha', subjectId: 'mock-rm-alpha', role: 'RM', cifId: null,
    rmId: '11111111-1111-4111-8111-111111111111',
    teamId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  },
  leader: {
    actorId: 'leader-alpha', subjectId: 'mock-leader-alpha', role: 'LEADER', cifId: null,
    rmId: null, teamId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  },
  customer: {
    actorId: 'customer-alpha', subjectId: 'mock-customer-alpha', role: 'CUSTOMER',
    cifId: '00000101', rmId: null, teamId: null,
  },
  otherCustomer: {
    actorId: 'customer-beta', subjectId: 'mock-customer-beta', role: 'CUSTOMER',
    cifId: '00000102', rmId: null, teamId: null,
  },
} as const;

/** Test actors are synthetic and do not depend on the demo seed. Schema comes from migrations. */
export async function seedTestActors(database: DataSource) {
  for (const actor of Object.values(actors)) {
    await database.query(
      `INSERT INTO mock_actors (actor_id, subject_id, role, cif_id, rm_id, team_id, active)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       ON CONFLICT (actor_id) DO UPDATE SET
       subject_id = EXCLUDED.subject_id, role = EXCLUDED.role, cif_id = EXCLUDED.cif_id,
       rm_id = EXCLUDED.rm_id, team_id = EXCLUDED.team_id, active = true`,
      [actor.actorId, actor.subjectId, actor.role, actor.cifId, actor.rmId, actor.teamId],
    );
  }
}

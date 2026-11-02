import type { DataSource } from 'typeorm';

/**
 * Single place for fixture actors (R9, team schema `wms`).
 * Staff log in by `staff_users.employee_code`, customers by CIF; JWT `sub` = `iam_subject`
 * (staff) or `'cust.' || lower(cif)` (customers). Fixture codes are synthetic and do not collide with the
 * team demo seed (NV0001..NV0005, CIF100001..CIF100005); API tests never load that seed.
 * A customer exists in `wms.customers` only after UC-01 confirm, but may log in as soon as an
 * onboarding request exists for its CIF (AC4). A customer that must log in without any invitation needs
 * `insertCustomerRow` (used for `otherCustomer` in s1 and for `customer` in s0).
 */
export type Sql = (text: string, params?: unknown[]) => Promise<any[]>;
export const viaDataSource = (database: DataSource): Sql => (text, params) => database.query(text, params);
export const viaPg = (client: { query(text: string, params?: unknown[]): Promise<{ rows: any[] }> }): Sql =>
  async (text, params) => (await client.query(text, params)).rows;

export const TEAM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const TEAM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const teams = {
  a: { teamId: TEAM_A, teamCode: 'TEST-A', teamName: 'Synthetic team A' },
  b: { teamId: TEAM_B, teamCode: 'TEST-B', teamName: 'Synthetic team B' },
} as const;

/** The six fields `GET /auth/me` returns today (JSON naming is unchanged in S1). */
export type Identity = {
  actorId: string; subjectId: string; role: 'RM' | 'LEADER' | 'CUSTOMER'; cifId: string | null;
  rmId: string | null; teamId: string | null;
};
export const publicIdentity = (actor: Identity): Identity => ({ actorId: actor.actorId, subjectId: actor.subjectId, role: actor.role,
  cifId: actor.cifId, rmId: actor.rmId, teamId: actor.teamId });

export const actors = {
  rm: {
    actorId: 'NV0102', subjectId: 'iam.nv0102', role: 'RM', cifId: null,
    rmId: '11111111-1111-4111-8111-111111111111', teamId: TEAM_A,
  },
  leader: {
    actorId: 'NV0101', subjectId: 'iam.nv0101', role: 'LEADER', cifId: null,
    rmId: null, teamId: TEAM_A,
  },
  customer: {
    actorId: '00000101', subjectId: 'cust.00000101', role: 'CUSTOMER',
    cifId: '00000101', rmId: null, teamId: null,
  },
  otherCustomer: {
    actorId: '00000102', subjectId: 'cust.00000102', role: 'CUSTOMER',
    cifId: '00000102', rmId: null, teamId: null,
  },
} as const;

/** A third customer used by tests that need a foreign-team customer (logs in via its invitation). */
export const gamma = { actorId: '00000103', subjectId: 'cust.00000103', role: 'CUSTOMER', cifId: '00000103', rmId: null, teamId: null } as const;

const staffActor = (actorId: string, rmId: string, teamId: string): Identity => ({ actorId, subjectId: `iam.${actorId.toLowerCase()}`, role: 'RM', cifId: null, rmId, teamId });
/** Extra staff, inserted on demand with `insertStaff`. `leader` staff ids are listed in `leaderStaffIds`. */
export const staff = {
  replacement: staffActor('NV0103', '22222222-2222-4222-8222-222222222222', TEAM_A),
  third: staffActor('NV0104', '33333333-3333-4333-8333-333333333333', TEAM_A),
  foreign: staffActor('NV0105', '44444444-4444-4444-8444-444444444444', TEAM_B),
  inactive: staffActor('NV0106', '55555555-5555-4555-8555-555555555555', TEAM_A),
  idle: staffActor('NV0108', '66666666-6666-4666-8666-666666666666', TEAM_A),
  foreignLeader: { actorId: 'NV0107', subjectId: 'iam.nv0107', role: 'LEADER', cifId: null, rmId: null, teamId: TEAM_B } as Identity,
};
export const leaderStaffIds: Record<string, string> = {
  [actors.leader.actorId]: 'dddddddd-dddd-4ddd-8ddd-dddddddd0101',
  [staff.foreignLeader.actorId]: 'dddddddd-dddd-4ddd-8ddd-dddddddd0107',
};
/** `staff_users.staff_id` of a staff fixture (RM: the rmId; LEADER: from `leaderStaffIds`). */
export function staffIdOf(actor: Identity): string {
  const id = actor.rmId ?? leaderStaffIds[actor.actorId];
  if (!id) throw new Error(`No staff id for ${actor.actorId}`);
  return id;
}

export async function insertTeam(sql: Sql, team: { teamId: string; teamCode: string; teamName: string }) {
  await sql('INSERT INTO wms.teams(team_id,team_code,team_name) VALUES($1,$2,$3) ON CONFLICT (team_id) DO NOTHING', [team.teamId, team.teamCode, team.teamName]);
}

export async function insertStaff(sql: Sql, actor: Identity, options: { active?: boolean; maxCustomers?: number } = {}) {
  const team = Object.values(teams).find(candidate => candidate.teamId === actor.teamId);
  if (!team || !actor.teamId) throw new Error('Staff fixtures belong to a known fixture team');
  await insertTeam(sql, team);
  const staffId = staffIdOf(actor);
  await sql(`INSERT INTO wms.staff_users(staff_id,iam_subject,employee_code,full_name,role,team_id,max_customers,is_active)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [staffId, actor.subjectId, actor.actorId, `Synthetic ${actor.role} ${actor.actorId}`, actor.role,
    actor.teamId, options.maxCustomers ?? 80, options.active ?? true]);
  if (actor.role === 'LEADER') await sql('UPDATE wms.teams SET leader_id=$1 WHERE team_id=$2 AND leader_id IS NULL', [staffId, actor.teamId]);
}

/** A customer row that exists before UC-01 (needed only to log in without an invitation). */
export async function insertCustomerRow(sql: Sql, actor: Identity, fullName = 'Synthetic fixture customer') {
  await sql(`INSERT INTO wms.customers(customer_id,cif_id,iam_subject,full_name,date_of_birth)
    VALUES(gen_random_uuid(),$1,$2,$3,'1990-01-01')`, [actor.cifId, actor.subjectId, fullName]);
}

/** Default staff of every API fixture: team A with its leader and one RM. Schema comes from migrations. */
export async function seedTestActors(database: DataSource) {
  const sql = viaDataSource(database);
  await insertTeam(sql, teams.a);
  await insertStaff(sql, actors.leader);
  await insertStaff(sql, actors.rm);
}

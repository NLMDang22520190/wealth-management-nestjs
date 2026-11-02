export type ActorRole = 'RM' | 'LEADER' | 'CUSTOMER';
export interface Actor {
  /** Login id: staff `employee_code` or customer CIF. */
  actorId: string;
  subjectId: string;
  role: ActorRole;
  cifId: string | null;
  /** `staff_users.staff_id` of an RM; null for leaders and customers (public shape of `/auth/me`). */
  rmId: string | null;
  teamId: string | null;
  /** `staff_users.staff_id` of any staff actor (RM or leader); null for customers. Server-side only. */
  staffId: string | null;
}
/** The six fields `/auth/me` exposes. */
export const publicIdentity = (actor: Actor) => ({ actorId: actor.actorId, subjectId: actor.subjectId, role: actor.role,
  cifId: actor.cifId, rmId: actor.rmId, teamId: actor.teamId });

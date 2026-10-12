export type ActorRole = 'RM' | 'LEADER' | 'CUSTOMER';
export interface Actor {
  actorId: string;
  subjectId: string;
  role: ActorRole;
  cifId: string | null;
  rmId: string | null;
  teamId: string | null;
}

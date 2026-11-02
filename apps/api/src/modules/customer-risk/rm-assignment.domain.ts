import { ApiProperty } from '@nestjs/swagger';
import { text, uuid } from '../../platform/validation.js';

export class RmAssignmentBody {
  // reason is VARCHAR(500) in the team schema.
  static readonly fields = { targetRmId: uuid, reason: (value: unknown) => text(value) && (value as string).length <= 500,
    expectedAssignmentVersion: (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0 };
  @ApiProperty({ format: 'uuid' }) targetRmId!: string;
  @ApiProperty({ maxLength: 500 }) reason!: string;
  @ApiProperty({ minimum: 1 }) expectedAssignmentVersion!: number;
}

export interface AssignmentRow {
  assignment_id: string; customer_id: string; rm_id: string; team_id: string; version: number;
}

export function assignmentProjection(row: AssignmentRow, changed: boolean, cancelledProposals = 0) {
  return { customerId: row.customer_id, rmId: row.rm_id, teamId: row.team_id, version: row.version, changed, cancelledProposals };
}

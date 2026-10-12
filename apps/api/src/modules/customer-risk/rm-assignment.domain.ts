import { ApiProperty } from '@nestjs/swagger';
import { text, uuid } from '../../platform/validation.js';

export class RmAssignmentBody {
  static readonly fields = { targetRmId: uuid, reason: text,
    expectedAssignmentVersion: (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0 };
  @ApiProperty({ format: 'uuid' }) targetRmId!: string;
  @ApiProperty() reason!: string;
  @ApiProperty({ minimum: 1 }) expectedAssignmentVersion!: number;
}

export interface AssignmentRow {
  id: string; customer_id: string; rm_id: string; team_id: string; version: number;
}

export function assignmentProjection(row: AssignmentRow, changed: boolean) {
  return { customerId: row.customer_id, rmId: row.rm_id, teamId: row.team_id, version: row.version, changed };
}

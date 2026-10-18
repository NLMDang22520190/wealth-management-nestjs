import { ApiProperty } from '@nestjs/swagger';
import { uuid } from '../../platform/validation.js';

export const REMINDER_COOLDOWN_MS = 24 * 3_600_000;
export const REMINDER_MESSAGE = 'Trưởng nhóm nhắc bạn hoàn thành khảo sát rủi ro (10 câu hỏi) để hồ sơ được xử lý.';

export class RiskSurveyReminderBody {
  // customerIds is optional: omitted means every team customer without a valid risk profile.
  static readonly fields = { customerIds: (value: unknown) => value === undefined
    || (Array.isArray(value) && value.length <= 500 && value.every(uuid)) };
  @ApiProperty({ type: [String], format: 'uuid', required: false }) customerIds?: string[];
}

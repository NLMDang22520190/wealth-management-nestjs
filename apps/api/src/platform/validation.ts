import { Injectable } from '@nestjs/common';
import type { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { ApiError } from './http.js';

type FieldRule = (value: unknown) => boolean;
interface ValidatedBody { readonly fields: Readonly<Record<string, FieldRule>>; }
export const text: FieldRule = value => typeof value === 'string' && value.trim().length > 0;
export const uuid: FieldRule = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export class MockTokenBody {
  static readonly fields = { actorId: text };
  @ApiProperty() actorId!: string;
}
export class OtpChallengeBody {
  static readonly fields = { purpose: text, operationId: uuid };
  @ApiProperty() purpose!: string;
  @ApiProperty({ format: 'uuid' }) operationId!: string;
}

@Injectable()
export class StrictBodyPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'body') return value;
    const schema = metadata.metatype as unknown as ValidatedBody | undefined;
    if (!schema?.fields) return value;
    const body = value as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !Object.hasOwn(schema.fields, key))
      || Object.entries(schema.fields).some(([key, rule]) => !rule(body[key]))) {
      // Values and unexpected field names are deliberately absent from errors and logs.
      throw new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed');
    }
    return body;
  }
}

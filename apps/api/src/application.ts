import 'reflect-metadata';
import type { INestApplication, LoggerService } from '@nestjs/common';
import type { DataSource } from 'typeorm';

export interface ApplicationOptions {
  databaseUrl: string;
  environment: 'test' | 'production';
  mockEnabled: boolean;
  jwtSecret: string;
  clock: { now(): Date };
  logger: LoggerService;
}

export interface Application {
  app: INestApplication;
  dataSource: DataSource;
}

export async function createApplication(_options: ApplicationOptions): Promise<Application> {
  throw new Error('NOT_IMPLEMENTED');
}

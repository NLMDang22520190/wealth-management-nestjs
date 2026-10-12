import 'reflect-metadata';
import { Module } from '@nestjs/common';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import { AuthModule } from './auth/auth.module.js';
import { BusinessRoutesModule } from './business/business-routes.module.js';
import { DatabaseModule } from './database/database.module.js';
import { MockActors1791763200000 } from './database/migrations/1791763200000-mock-actors.js';
import { Onboarding1791763200001 } from './database/migrations/1791763200001-onboarding.js';
import { AuditMetadata1791763200002 } from './database/migrations/1791763200002-audit-metadata.js';
import { RiskProfiles1791763200003 } from './database/migrations/1791763200003-risk-profiles.js';
import { CustomerRiskModule } from './modules/customer-risk/onboarding.module.js';
import type { CoreBanking } from './modules/customer-risk/onboarding.domain.js';
import type { OtpDelivery } from './platform/otp.service.js';
import { validateConfiguration } from './platform/configuration.js';
import { ApiErrorFilter, requestContext } from './platform/http.js';
import { PlatformModule } from './platform/platform.module.js';
import { RuntimeModule } from './platform/runtime.module.js';
import { StrictBodyPipe } from './platform/validation.js';

export interface ApplicationOptions {
  databaseUrl: string;
  environment: 'development' | 'test' | 'production';
  mockEnabled: boolean;
  jwtSecret: string;
  clock: { now(): Date };
  logger: LoggerService;
  coreBanking?: CoreBanking;
  otpDelivery?: (delivery: OtpDelivery) => void | Promise<void>;
}

export interface Application {
  app: INestApplication;
  dataSource: DataSource;
}

@Module({})
class ApplicationModule {}

export async function createApplication(options: ApplicationOptions): Promise<Application> {
  validateConfiguration(options);
  const dataSource = new DataSource({
    type: 'postgres', url: options.databaseUrl, synchronize: false,
    migrations: [MockActors1791763200000, Onboarding1791763200001, AuditMetadata1791763200002, RiskProfiles1791763200003], migrationsTableName: 'migrations',
    logging: false,
  });
  let app: INestApplication | undefined;
  try {
    await dataSource.initialize();
    await dataSource.runMigrations({ transaction: 'all' });
    app = await NestFactory.create({
      module: ApplicationModule,
      imports: [RuntimeModule.register(options), DatabaseModule.register(dataSource), AuthModule, PlatformModule, CustomerRiskModule, BusinessRoutesModule],
    }, { logger: options.logger });
    app.setGlobalPrefix('api/v1');
    app.use(requestContext);
    app.useGlobalPipes(new StrictBodyPipe());
    app.useGlobalFilters(new ApiErrorFilter(options.logger));
    const document = SwaggerModule.createDocument(app, new DocumentBuilder()
      .setTitle('Wealth Management — Part 1').setVersion('0.1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'bearer').build());
    SwaggerModule.setup('api/v1/docs', app, document, { jsonDocumentUrl: 'api/v1/openapi.json' });
    await app.init();
    return { app, dataSource };
  } catch {
    if (app) await app.close();
    if (dataSource.isInitialized) await dataSource.destroy();
    // Connection strings and driver messages must not escape the bootstrap boundary.
    throw new Error('Application initialization failed');
  }
}

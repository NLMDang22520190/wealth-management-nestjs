import { Global, Injectable, Module } from '@nestjs/common';
import type { DynamicModule, OnApplicationShutdown } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(private readonly database: DataSource) {}
  async onApplicationShutdown(): Promise<void> {
    if (this.database.isInitialized) await this.database.destroy();
  }
}

@Global()
@Module({})
export class DatabaseModule {
  static register(database: DataSource): DynamicModule {
    return { module: DatabaseModule, providers: [{ provide: DataSource, useValue: database }, DatabaseLifecycle], exports: [DataSource] };
  }
}

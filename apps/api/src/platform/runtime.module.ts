import { Global, Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { ApplicationOptions } from '../application.js';

export const RUNTIME_OPTIONS = Symbol('RUNTIME_OPTIONS');

@Global()
@Module({})
export class RuntimeModule {
  static register(options: ApplicationOptions): DynamicModule {
    return { module: RuntimeModule, providers: [{ provide: RUNTIME_OPTIONS, useValue: options }], exports: [RUNTIME_OPTIONS] };
  }
}

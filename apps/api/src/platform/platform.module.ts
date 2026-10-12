import { Controller, Get, Module } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import { Public } from '../auth/guards.js';
import { ApiError } from './http.js';

@Public()
@ApiTags('Health')
@Controller('health')
class HealthController {
  constructor(private readonly database: DataSource) {}
  @Get('live')
  live() { return { status: 'ok' }; }
  @Get('ready')
  async ready() {
    try { await this.database.query('SELECT 1'); }
    catch { throw new ApiError(503, 'UNAVAILABLE', 'Service unavailable'); }
    return { status: 'ok', database: 'up' };
  }
}

@Module({ controllers: [HealthController] })
export class PlatformModule {}

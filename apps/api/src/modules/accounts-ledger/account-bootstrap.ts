import { randomUUID } from 'node:crypto';
import { Injectable, Module } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

/** P2 bridge: creates the investment account; financial posting belongs to later UCs. */
@Injectable()
export class AccountBootstrap {
  async create(manager: EntityManager, customerId: string, now: Date): Promise<string> {
    const id = randomUUID();
    await manager.query(`INSERT INTO investment_accounts(id,customer_id,currency,balance,created_at)
      VALUES($1,$2,'VND',0,$3)`, [id, customerId, now]);
    return id;
  }
}

@Module({ providers: [AccountBootstrap], exports: [AccountBootstrap] })
export class AccountsLedgerModule {}

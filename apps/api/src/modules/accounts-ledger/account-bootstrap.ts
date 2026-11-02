import { randomUUID } from 'node:crypto';
import { Injectable, Module } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

/** P2 bridge: creates the investment account and its ledger account; financial posting belongs to later UCs. */
@Injectable()
export class AccountBootstrap {
  async create(manager: EntityManager, customerId: string, cifId: string, now: Date): Promise<string> {
    // Numbering is serialized across customers: 'WM' + 10 digits, next after the highest existing number.
    await manager.query("SELECT pg_advisory_xact_lock(hashtextextended('account-no',0))");
    const [next] = await manager.query(`SELECT COALESCE(max(substring(account_no from 3)::bigint),0)+1 AS next
      FROM wms.investment_accounts WHERE account_no ~ '^WM[0-9]{10}$'`);
    const accountNo = `WM${String(next.next).padStart(10, '0')}`;
    const id = randomUUID();
    await manager.query(`INSERT INTO wms.investment_accounts(account_id,account_no,customer_id,cif_id,currency,balance,opened_at)
      VALUES($1,$2,$3,$4,'VND',0,$5)`, [id, accountNo, customerId, cifId, now]);
    await manager.query(`INSERT INTO wms.ledger_accounts(code,name,type,investment_account_id)
      VALUES($1,$2,'CUSTOMER_INVESTMENT',$3)`, [`CI-${accountNo}`, `Tài khoản đầu tư ${accountNo}`, id]);
    return id;
  }
}

@Module({ providers: [AccountBootstrap], exports: [AccountBootstrap] })
export class AccountsLedgerModule {}

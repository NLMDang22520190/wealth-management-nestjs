import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

export interface JournalInput {
  accountId: string; cashTxnId: string; description: string; now: Date;
  /** Credit raises and debit lowers the investment account (NFR-P2-03: balance = credits - debits). */
  customerSide: 'DEBIT' | 'CREDIT';
  amount: string;
  /** Opposite-side lines on system ledger accounts; their amounts add up to `amount`. */
  counter: Array<{ code: string; amount: string }>;
  /** The withdrawal hold becomes the deduction. */
  consumeHold?: boolean;
}

const opposite = (side: string) => (side === 'DEBIT' ? 'CREDIT' : 'DEBIT');

/** The only writer of `ledger_entries`. The caller holds the account row lock; the schema trigger rejects unbalanced journals at commit. */
@Injectable()
export class LedgerService {
  async post(manager: EntityManager, input: JournalInput): Promise<void> {
    await this.scopeBalanceTrigger(manager);
    const journalId = randomUUID();
    const balanceAfter = await this.moveBalance(manager, input.accountId, input.customerSide, input.amount, input.consumeHold ? input.amount : '0');
    const [customer] = await manager.query('SELECT ledger_account_id FROM wms.ledger_accounts WHERE investment_account_id=$1', [input.accountId]);
    await this.insert(manager, { journalId, cashTxnId: input.cashTxnId, ledgerAccountId: customer.ledger_account_id, side: input.customerSide,
      amount: input.amount, balanceAfter, reversalOf: null, description: input.description, now: input.now });
    for (const line of input.counter) {
      const [system] = await manager.query('SELECT ledger_account_id FROM wms.ledger_accounts WHERE code=$1', [line.code]);
      await this.insert(manager, { journalId, cashTxnId: input.cashTxnId, ledgerAccountId: system.ledger_account_id, side: opposite(input.customerSide),
        amount: line.amount, balanceAfter: null, reversalOf: null, description: input.description, now: input.now });
    }
  }

  /** Corrections never edit a row: each original entry gets an opposite entry pointing at it (BR-19). */
  async reverse(manager: EntityManager, accountId: string, cashTxnId: string, description: string, now: Date): Promise<void> {
    await this.scopeBalanceTrigger(manager);
    const entries: Array<{ entry_id: string; ledger_account_id: string; side: string; amount: string; investment_account_id: string | null }> = await manager.query(
      `SELECT e.entry_id::text,e.ledger_account_id,e.side::text AS side,e.amount::text AS amount,l.investment_account_id FROM wms.ledger_entries e
       JOIN wms.ledger_accounts l USING(ledger_account_id)
       WHERE e.cash_txn_id=$1 AND e.reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM wms.ledger_entries r WHERE r.reversal_of=e.entry_id) ORDER BY e.entry_id`, [cashTxnId]);
    const journalId = randomUUID();
    for (const entry of entries) {
      const side = opposite(entry.side);
      const balanceAfter = entry.investment_account_id ? await this.moveBalance(manager, accountId, side, entry.amount, '0') : null;
      await this.insert(manager, { journalId, cashTxnId, ledgerAccountId: entry.ledger_account_id, side, amount: entry.amount, balanceAfter,
        reversalOf: entry.entry_id, description, now });
    }
  }

  /** The team's deferred balance trigger names `ledger_entries` without a schema and runs at COMMIT, so the transaction must resolve it to `wms`. */
  private async scopeBalanceTrigger(manager: EntityManager): Promise<void> {
    await manager.query("SELECT set_config('search_path', 'wms, public', true)");
  }

  private async moveBalance(manager: EntityManager, accountId: string, side: string, amount: string, consumedHold: string): Promise<string> {
    // A plain UPDATE ... RETURNING through EntityManager.query yields [rows, affected].
    const [rows]: Array<Array<{ balance: string }>> = await manager.query(`UPDATE wms.investment_accounts
      SET balance=balance${side === 'CREDIT' ? '+' : '-'}$2::numeric,held_amount=held_amount-$3::numeric,version=version+1
      WHERE account_id=$1 RETURNING balance::text AS balance`, [accountId, amount, consumedHold]);
    return rows![0]!.balance;
  }

  private async insert(manager: EntityManager, row: { journalId: string; cashTxnId: string; ledgerAccountId: string; side: string; amount: string;
    balanceAfter: string | null; reversalOf: string | null; description: string; now: Date }): Promise<void> {
    await manager.query(`INSERT INTO wms.ledger_entries(journal_id,cash_txn_id,ledger_account_id,side,amount,balance_after,reversal_of,description,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [row.journalId, row.cashTxnId, row.ledgerAccountId, row.side, row.amount, row.balanceAfter, row.reversalOf, row.description, row.now]);
  }
}

import type { EntityManager } from 'typeorm';

export interface AccountRow {
  account_id: string; account_no: string; customer_id: string; cif_id: string; balance: string; held_amount: string; available: string; status: string;
}
export interface OrderRow {
  txn_id: string; ref_no: string; account_id: string; txn_type: 'DEPOSIT' | 'WITHDRAWAL' | 'MATURITY_SETTLEMENT'; amount: string; status: string;
  failure_reason: string | null; created_at: Date; completed_at: Date | null; casa_no: string | null; retry_count: number | null;
  needs_manual_review: boolean | null; otp_challenge_id: string | null; otp_status: string | null; otp_expires_at: Date | null; otp_consumed_at: Date | null;
  customer_id: string; cif_id: string; principal_amount: string | null; interest_amount: string | null;
}

const ACCOUNT_COLUMNS = 'account_id,account_no,customer_id,cif_id,balance::text AS balance,held_amount::text AS held_amount,(balance-held_amount)::text AS available,status::text AS status';

export async function accountOfCif(manager: EntityManager, cifId: string): Promise<AccountRow | undefined> {
  const [row] = await manager.query(`SELECT ${ACCOUNT_COLUMNS} FROM wms.investment_accounts WHERE cif_id=$1`, [cifId]);
  return row;
}

/** Row lock on the account: every balance change of one account is serialized here. */
export async function lockAccount(manager: EntityManager, accountId: string): Promise<AccountRow> {
  const [row] = await manager.query(`SELECT ${ACCOUNT_COLUMNS} FROM wms.investment_accounts WHERE account_id=$1 FOR UPDATE`, [accountId]);
  return row;
}

export const ORDER_SELECT = `SELECT c.txn_id,c.ref_no,c.account_id,c.txn_type::text AS txn_type,c.amount::text AS amount,c.status::text AS status,c.failure_reason,c.created_at,c.completed_at,
    COALESCE(d.source_casa_no,w.dest_casa_no) AS casa_no,COALESCE(d.retry_count,w.retry_count)::int AS retry_count,w.needs_manual_review,
    o.challenge_id AS otp_challenge_id,o.status::text AS otp_status,o.expires_at AS otp_expires_at,o.consumed_at AS otp_consumed_at,
    a.customer_id,a.cif_id,m.principal_amount::text AS principal_amount,m.interest_amount::text AS interest_amount
  FROM wms.cash_transactions c
  JOIN wms.investment_accounts a ON a.account_id=c.account_id
  LEFT JOIN wms.deposit_transactions d ON d.txn_id=c.txn_id
  LEFT JOIN wms.withdrawal_transactions w ON w.txn_id=c.txn_id
  LEFT JOIN wms.maturity_settlements m ON m.txn_id=c.txn_id
  LEFT JOIN wms.otp_challenges o ON o.challenge_id=COALESCE(d.otp_challenge_id,w.otp_challenge_id)`;

export async function loadOrder(manager: EntityManager, txnId: string, lock = false): Promise<OrderRow | undefined> {
  const [row] = await manager.query(`${ORDER_SELECT} WHERE c.txn_id=$1${lock ? ' FOR UPDATE OF c' : ''}`, [txnId]);
  return row;
}

/** Team reference format, numbered per prefix and Vietnam day; the lock serializes the counter until commit. */
export async function nextRefNo(manager: EntityManager, prefix: string, vietnamDay: string): Promise<string> {
  const stem = `${prefix}-${vietnamDay.replaceAll('-', '')}-`;
  await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`cash-ref:${stem}`]);
  const [row] = await manager.query(`SELECT COALESCE(max(substring(ref_no from $2)::int),0)+1 AS next FROM wms.cash_transactions WHERE ref_no LIKE $1`,
    [`${stem}%`, `^${stem}(\\d+)$`]);
  return `${stem}${String(row.next).padStart(4, '0')}`;
}

export function orderView(order: OrderRow, account: Pick<AccountRow, 'balance' | 'available'>) {
  return { txnId: order.txn_id, refNo: order.ref_no, txnType: order.txn_type, amount: order.amount, casaNo: order.casa_no, status: order.status,
    failureReason: order.failure_reason, createdAt: order.created_at.toISOString(), completedAt: order.completed_at ? order.completed_at.toISOString() : null,
    balance: account.balance, availableBalance: account.available };
}

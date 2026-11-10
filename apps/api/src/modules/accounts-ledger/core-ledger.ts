/** Core Banking money operations. `refNo` makes a retry of the same order safe on the Core side. */
export interface CoreLedgerRequest { refNo: string; casaNo: string; amount: string; }
export type CorePosting = { outcome: 'POSTED'; coreRef: string } | { outcome: 'REJECTED'; reason: string };
export type CoreStatus = { outcome: 'POSTED'; coreRef: string } | { outcome: 'NOT_POSTED' };

export interface CoreLedger {
  debit(request: CoreLedgerRequest): Promise<CorePosting>;
  credit(request: CoreLedgerRequest): Promise<CorePosting>;
  status(request: CoreLedgerRequest): Promise<CoreStatus>;
  casaBalance(casaNo: string): Promise<string>;
}

/** NFR-P2-11 allows 3 seconds per request, so an unanswered Core call is given up after 2. */
const CORE_TIMEOUT_MS = 2000;

export async function withCoreTimeout<T>(call: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([call, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('CORE_TIMEOUT')), CORE_TIMEOUT_MS);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

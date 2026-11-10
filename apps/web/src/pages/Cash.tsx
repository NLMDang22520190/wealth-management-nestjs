import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiFailure, api, describe, intentDone, intentKey } from '../api';
import { formatDateTime, formatVnd } from '../format';
import { AlertAction, BusyButton, Choice, Empty, ErrorAlert, Fact, Facts, Field, Loading, OtpCodeInput, OtpInbox, PageTitle, Panel, choiceInput, invalidProps, useLoad } from '../ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';

/** Decimal strings from the API are only ever regrouped as text. */
export const money = (value: string) => formatVnd(value.replace(/\.00$/, ''));

export const typeLabels: Record<string, string> = { DEPOSIT: 'Nạp tiền', WITHDRAWAL: 'Rút tiền', MATURITY_SETTLEMENT: 'Tất toán tiền gửi' };
const statusLabels: Record<string, string> = { INIT: 'Khởi tạo', PENDING: 'Đang xử lý', SUCCESS: 'Thành công', FAILED: 'Thất bại' };
const statusVariants = { INIT: 'wait', PENDING: 'wait', SUCCESS: 'ok', FAILED: 'bad' } as const;
const reasonLabels: Record<string, string> = {
  OTP_INVALID: 'Mã OTP không đúng', OTP_EXPIRED: 'Mã OTP đã hết hạn', CORE_REJECTED: 'Ngân hàng lõi từ chối', CORE_NOT_POSTED: 'Ngân hàng lõi chưa hạch toán',
  BACK_OFFICE_RESOLVED: 'Back-office đã chốt thất bại', ACCOUNT_NOT_ACTIVE: 'Tài khoản đầu tư không hoạt động', INSUFFICIENT_AVAILABLE_BALANCE: 'Số dư không đủ',
};
const entryAccounts: Record<string, string> = { CUSTOMER_INVESTMENT: 'Tài khoản đầu tư', CORE_CLEARING: 'Trung gian Core', TERM_DEPOSIT: 'Tiền gửi có kỳ hạn', INTEREST_PAYABLE: 'Lãi phải trả' };

export function StatusBadge({ status }: { status: string }) {
  return <Badge variant={statusVariants[status as keyof typeof statusVariants] ?? 'wait'}>{statusLabels[status] ?? status}</Badge>;
}

interface Txn {
  txnId: string; refNo: string; txnType: string; amount: string; status: string; failureReason: string | null; casaNo: string | null;
  principalAmount: string | null; interestAmount: string | null; createdAt: string; completedAt: string | null;
}
interface Entry { entryId: string; accountType: string; side: string; amount: string; balanceAfter: string | null; reversalOf: string | null }
interface Page<T> { items: T[]; total: number; page: number; pageSize: number }

function TxnEntries({ url }: { url: string }) {
  const detail = useLoad(signal => api<{ entries: Entry[] }>(url, { signal }), [url]);
  if (detail.loading && !detail.data) return <Loading />;
  if (detail.error) return <ErrorAlert>{describe(detail.error)}</ErrorAlert>;
  if (!detail.data || detail.data.entries.length === 0) return <p className="m-0 mt-2 text-muted-foreground">Giao dịch này chưa có bút toán.</p>;
  return (
    <ul className="m-0 mt-2 grid list-none gap-1 p-0 text-[0.9rem]" aria-label="Bút toán">
      {detail.data.entries.map(entry => (
        <li key={entry.entryId} className="flex flex-wrap justify-between gap-x-3 rounded-md bg-muted px-3 py-1.5">
          <span>{entry.side === 'DEBIT' ? 'Nợ' : 'Có'} · {entryAccounts[entry.accountType] ?? entry.accountType}{entry.reversalOf ? ' (bút toán đảo)' : ''}</span>
          <strong className="tabular-nums">{money(entry.amount)}</strong>
        </li>
      ))}
    </ul>
  );
}

function TxnRow({ txn, basePath }: { txn: Txn; basePath: string }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-lg border bg-card px-3.5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="font-semibold">{typeLabels[txn.txnType] ?? txn.txnType}</span>
        <strong className="tabular-nums">{money(txn.amount)}</strong>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.9rem] text-muted-foreground">
        <StatusBadge status={txn.status} />
        <span className="break-all">{txn.refNo}</span>
        <span>{formatDateTime(txn.createdAt)}</span>
      </div>
      {txn.failureReason ? <p className="m-0 mt-1 text-[0.9rem] text-destructive">{reasonLabels[txn.failureReason] ?? txn.failureReason}</p> : null}
      {txn.interestAmount ? <p className="m-0 mt-1 text-[0.9rem]">Gốc {money(txn.principalAmount ?? '0')}, lãi {money(txn.interestAmount)}</p> : null}
      <Button type="button" variant="link" className="min-h-11 p-0" aria-expanded={open} aria-label={`Xem bút toán ${txn.refNo}`} onClick={() => setOpen(value => !value)}>{open ? 'Ẩn bút toán' : 'Xem bút toán'}</Button>
      {open ? <TxnEntries url={`${basePath}/${txn.txnId}`} /> : null}
    </li>
  );
}

/** UC-07: one read-only list for customer, staff and back-office; the server decides the scope from `basePath` and the token. */
export function CashHistory({ basePath, version = 0, query = '' }: { basePath: string; version?: number; query?: string }) {
  const typeId = useId();
  const statusId = useId();
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const params = new URLSearchParams(query);
  if (type) params.set('type', type);
  if (status) params.set('status', status);
  params.set('page', String(page));
  const list = useLoad(signal => api<Page<Txn>>(`${basePath}?${params.toString()}`, { signal }), [basePath, params.toString(), version]);
  const lastPage = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;
  return (
    <>
      <div className="grid gap-x-3 sm:grid-cols-2">
        <Field label="Loại giao dịch" htmlFor={typeId}>
          <NativeSelect id={typeId} className="w-full" value={type} onChange={event => { setType(event.target.value); setPage(1); }}>
            <NativeSelectOption value="">Tất cả</NativeSelectOption>
            {Object.entries(typeLabels).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}
          </NativeSelect>
        </Field>
        <Field label="Trạng thái giao dịch" htmlFor={statusId}>
          <NativeSelect id={statusId} className="w-full" value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}>
            <NativeSelectOption value="">Tất cả</NativeSelectOption>
            {Object.entries(statusLabels).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}
          </NativeSelect>
        </Field>
      </div>
      {list.loading && !list.data ? <Loading /> : null}
      {list.error ? <ErrorAlert>{describe(list.error)} <AlertAction onClick={list.reload}>Thử lại</AlertAction></ErrorAlert> : null}
      {list.data && list.data.items.length === 0 ? <Empty>Chưa có giao dịch trong khoảng thời gian này.</Empty> : null}
      {list.data && list.data.items.length > 0 ? (
        <>
          <ul className="m-0 grid list-none gap-2 p-0">{list.data.items.map(txn => <TxnRow key={txn.txnId} txn={txn} basePath={basePath} />)}</ul>
          {lastPage > 1 ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <Button type="button" variant="outline" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Trang trước</Button>
              <span role="status" className="text-[0.9rem] text-muted-foreground">Trang {page}/{lastPage}</span>
              <Button type="button" variant="outline" disabled={page >= lastPage} onClick={() => setPage(value => value + 1)}>Trang sau</Button>
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}

interface AccountView {
  accountNo: string; balance: string; heldAmount: string; availableBalance: string; status: string;
  remainingDepositLimit: string; remainingWithdrawalLimit: string; casaAccounts: Array<{ casaNo: string; balance: string }>;
}
interface Order { txnId: string; refNo: string; amount: string; challengeId: string; expiresAt: string }
interface OrderResult { refNo: string; txnType: string; amount: string; status: string; failureReason: string | null; balance: string }
type Kind = 'DEPOSIT' | 'WITHDRAWAL';

const routes: Record<Kind, { path: string; casaField: string }> = { DEPOSIT: { path: 'deposits', casaField: 'sourceCasaNo' }, WITHDRAWAL: { path: 'withdrawals', casaField: 'destCasaNo' } };
const ORDER_ENDING_CODES = new Set(['OTP_INVALID', 'OTP_EXPIRED', 'ACCOUNT_NOT_ACTIVE', 'INSUFFICIENT_AVAILABLE_BALANCE', 'TXN_NOT_CONFIRMABLE']);

/** Text a person types ("5.000.000" or "1000000,50") to the API's decimal string; null when it is not an amount. A dot only groups thousands. */
function parseAmount(raw: string): string | null {
  const text = raw.trim();
  if (!/^(\d+|\d{1,3}(\.\d{3})+)(,\d{1,2})?$/.test(text)) return null;
  const cleaned = text.replaceAll('.', '').replace(',', '.');
  return /^\d{1,18}(\.\d{1,2})?$/.test(cleaned) ? cleaned : null;
}

function amountProblem(failure: unknown): string | null {
  if (!(failure instanceof ApiFailure)) return null;
  const details = failure.details as { remaining?: string; maxAmount?: string } | undefined;
  if (failure.code === 'AMOUNT_BELOW_MINIMUM') return `Số tiền tối thiểu là ${money('1000000')}.`;
  if (failure.code === 'DAILY_LIMIT_EXCEEDED') return `Vượt hạn mức trong ngày. Hạn mức còn lại: ${money(details?.remaining ?? '0')}.`;
  if (failure.code === 'INSUFFICIENT_AVAILABLE_BALANCE') return `Số tiền vượt số dư khả dụng. Tối đa có thể rút: ${money(details?.maxAmount ?? '0')}.`;
  return null;
}

function resultMessage(result: OrderResult): { text: string; good: boolean } {
  if (result.status === 'SUCCESS') return { text: 'Giao dịch thành công', good: true };
  if (result.status === 'PENDING') return { text: 'Giao dịch đang xử lý. Kết quả sẽ có sau khi đối soát với ngân hàng lõi.', good: false };
  return { text: result.txnType === 'WITHDRAWAL' ? 'Rút tiền không thành công, đã hoàn tiền' : 'Nạp tiền không thành công', good: false };
}

function OrderFlow({ account, onChanged }: { account: AccountView; onChanged: () => void }) {
  const casaId = useId();
  const amountId = useId();
  const amountBox = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<Kind | null>(null);
  const [casaNo, setCasaNo] = useState(account.casaAccounts[0]?.casaNo ?? '');
  const [raw, setRaw] = useState('');
  const [step, setStep] = useState<'form' | 'review' | 'otp' | 'ended' | 'result'>('form');
  const [amountError, setAmountError] = useState<string | null>(null);
  const [kindError, setKindError] = useState<string | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [code, setCode] = useState('');
  const [result, setResult] = useState<OrderResult | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [focusAmount, setFocusAmount] = useState(0);
  useEffect(() => { if (focusAmount > 0) amountBox.current?.focus(); }, [focusAmount]);

  const amount = parseAmount(raw);
  const fieldError = (message: string) => { setAmountError(message); setStep('form'); setFocusAmount(value => value + 1); };

  const proceed = (event: FormEvent) => {
    event.preventDefault();
    setFailure(null); setAmountError(null); setKindError(null);
    if (!kind) { setKindError('Chọn loại lệnh.'); return; }
    if (!amount) { fieldError('Nhập số tiền hợp lệ, ví dụ 5.000.000.'); return; }
    if (BigInt(amount.split('.')[0]!) < 1_000_000n) { fieldError(`Số tiền tối thiểu là ${money('1000000')}.`); return; }
    setStep('review');
  };

  const create = async () => {
    if (!kind || !amount) return;
    setBusy(true); setFailure(null);
    const route = routes[kind];
    const name = `cash-order-${kind}`;
    try {
      const created = await api<Order>(`/me/${route.path}`, { key: intentKey(name, `${casaNo}:${amount}`), body: { [route.casaField]: casaNo, amount } });
      intentDone(name);
      setOrder(created); setCode(''); setStep('otp');
      onChanged();
    } catch (error) {
      const problem = amountProblem(error);
      if (problem) { intentDone(name); fieldError(problem); }
      else setFailure(error);
    } finally { setBusy(false); }
  };

  const confirm = async () => {
    if (!kind || !order) return;
    setBusy(true); setFailure(null);
    const name = `cash-confirm-${order.txnId}`;
    try {
      const done = await api<OrderResult>(`/me/${routes[kind].path}/${order.txnId}/confirm`, { key: intentKey(name, `${order.challengeId}:${code}`), body: { challengeId: order.challengeId, code } });
      intentDone(name);
      setResult(done); setStep('result');
      onChanged();
    } catch (error) {
      setFailure(error);
      if (error instanceof ApiFailure && ORDER_ENDING_CODES.has(error.code)) { intentDone(name); setStep('ended'); onChanged(); }
    } finally { setBusy(false); }
  };

  const restart = () => { setStep('form'); setOrder(null); setResult(null); setCode(''); setRaw(''); setFailure(null); setAmountError(null); };

  if (step === 'result' && result) {
    const message = resultMessage(result);
    return (
      <Panel title="Kết quả lệnh" tone={message.good ? 'success' : 'plain'} focusOnMount>
        <p className={message.good ? 'font-semibold text-ok' : 'font-semibold'}>{message.text}</p>
        <Facts>
          <Fact label="Mã giao dịch"><span className="break-all">{result.refNo}</span></Fact>
          <Fact label="Số tiền">{money(result.amount)}</Fact>
          <Fact label="Số dư sau giao dịch">{money(result.balance)}</Fact>
        </Facts>
        <Button type="button" onClick={restart}>Tạo lệnh mới</Button>
      </Panel>
    );
  }
  if (step === 'ended') {
    return (
      <Panel key="ended" title="Lệnh không hoàn tất" focusOnMount>
        <ErrorAlert>Lệnh đã bị hủy. {describe(failure)}</ErrorAlert>
        <Button type="button" onClick={restart}>Tạo lệnh mới</Button>
      </Panel>
    );
  }
  return (
    <Panel title="Lệnh nạp hoặc rút">
      {step === 'form' ? (
        <form onSubmit={proceed} noValidate>
          <fieldset className="m-0 mb-3 border-0 p-0" aria-describedby={kindError ? `${amountId}-kind` : undefined}>
            <legend className="mb-1.5 text-sm font-medium">Loại lệnh</legend>
            <div className="grid gap-x-3 sm:grid-cols-2">
              <Choice><input type="radio" name="cash-kind" className={choiceInput} checked={kind === 'DEPOSIT'} onChange={() => setKind('DEPOSIT')} /><span>Nạp tiền</span></Choice>
              <Choice><input type="radio" name="cash-kind" className={choiceInput} checked={kind === 'WITHDRAWAL'} onChange={() => setKind('WITHDRAWAL')} /><span>Rút tiền</span></Choice>
            </div>
            {kindError ? <p id={`${amountId}-kind`} className="m-0 text-[0.85rem] font-medium text-destructive">{kindError}</p> : null}
          </fieldset>
          <Field label="Tài khoản thanh toán" htmlFor={casaId}>
            <NativeSelect id={casaId} className="w-full" value={casaNo} onChange={event => setCasaNo(event.target.value)}>
              {account.casaAccounts.map(item => <NativeSelectOption key={item.casaNo} value={item.casaNo}>{item.casaNo} · {money(item.balance)}</NativeSelectOption>)}
            </NativeSelect>
          </Field>
          <Field label="Số tiền (VND)" htmlFor={amountId} error={amountError}>
            <Input ref={amountBox} id={amountId} inputMode="decimal" autoComplete="off" value={raw} onChange={event => setRaw(event.target.value)} {...invalidProps(`${amountId}-error`, amountError)} />
          </Field>
          <Button type="submit" disabled={account.casaAccounts.length === 0}>Tiếp tục</Button>
        </form>
      ) : null}
      {step === 'review' && kind && amount ? (
        <>
          <Facts>
            <Fact label="Loại lệnh">{typeLabels[kind]}</Fact>
            <Fact label="Tài khoản thanh toán"><span className="break-all">{casaNo}</span></Fact>
            <Fact label="Số tiền">{money(amount)}</Fact>
          </Facts>
          <div className="flex flex-wrap gap-2">
            <BusyButton type="button" busy={busy} onClick={() => void create()}>Xác nhận lệnh</BusyButton>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setStep('form')}>Quay lại</Button>
          </div>
        </>
      ) : null}
      {step === 'otp' && order ? (
        <>
          <p>Lệnh {order.refNo}: {money(order.amount)}. Mã có hiệu lực đến {formatDateTime(order.expiresAt)}. Nhập sai mã, lệnh sẽ bị hủy.</p>
          <OtpInbox key={`inbox-${order.challengeId}`} challengeId={order.challengeId} />
          <OtpCodeInput key={order.challengeId} onChange={setCode} disabled={busy} />
          <BusyButton type="button" busy={busy} disabled={code.length < 6} onClick={() => void confirm()}>Xác nhận OTP</BusyButton>
        </>
      ) : null}
      {failure ? <ErrorAlert>{describe(failure, { SERVICE_INACTIVE: 'Dịch vụ chưa hoạt động. Hãy hoàn thành khảo sát rủi ro trước.' })}</ErrorAlert> : null}
    </Panel>
  );
}

interface ResultItem extends Txn { completedAt: string }

/** UC-05, UC-06 and the customer's own UC-07. */
export function Cash() {
  const [version, setVersion] = useState(0);
  const account = useLoad(signal => api<AccountView>('/me/investment-account', { signal }), [version]);
  const results = useLoad(signal => api<{ items: ResultItem[] }>('/me/cash-notifications', { signal }), [version]);
  const [seen, setSeen] = useState<AccountView | undefined>();
  useEffect(() => { if (account.data) setSeen(account.data); }, [account.data]);
  const view = account.data ?? seen;
  return (
    <>
      <PageTitle title="Nạp và rút tiền" hint="Tiền chỉ chuyển giữa tài khoản đầu tư và tài khoản thanh toán chính chủ của bạn." />
      {account.loading && !view ? <Loading skeleton /> : null}
      {account.error ? <ErrorAlert>{describe(account.error, { ACCOUNT_NOT_FOUND: 'Bạn chưa có tài khoản đầu tư. Hãy đồng ý lời mời dịch vụ trước.' })} <AlertAction onClick={account.reload}>Thử lại</AlertAction></ErrorAlert> : null}
      {view ? (
        <>
          <Panel title="Tài khoản đầu tư">
            <Facts>
              <Fact label="Số tài khoản"><span className="break-all">{view.accountNo}</span></Fact>
              <Fact label="Số dư">{money(view.balance)}</Fact>
              <Fact label="Đang phong tỏa">{money(view.heldAmount)}</Fact>
              <Fact label="Số dư khả dụng">{money(view.availableBalance)}</Fact>
              <Fact label="Hạn mức nạp còn lại hôm nay">{money(view.remainingDepositLimit)}</Fact>
              <Fact label="Hạn mức rút còn lại hôm nay">{money(view.remainingWithdrawalLimit)}</Fact>
            </Facts>
          </Panel>
          <OrderFlow account={view} onChanged={() => setVersion(value => value + 1)} />
          <Panel title="Kết quả giao dịch gần đây">
            {results.error ? <ErrorAlert>{describe(results.error)}</ErrorAlert> : null}
            {results.data && results.data.items.length === 0 ? <Empty>Chưa có giao dịch nào hoàn tất.</Empty> : null}
            {results.data && results.data.items.length > 0 ? (
              <ul className="m-0 grid list-none gap-2 p-0">
                {results.data.items.slice(0, 5).map(item => (
                  <li key={item.txnId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border bg-card px-3.5 py-2.5">
                    <span>{typeLabels[item.txnType] ?? item.txnType} · {money(item.amount)}</span>
                    <StatusBadge status={item.status} />
                  </li>
                ))}
              </ul>
            ) : null}
          </Panel>
          <Panel title="Lịch sử giao dịch"><CashHistory basePath="/me/cash-transactions" version={version} /></Panel>
        </>
      ) : null}
    </>
  );
}

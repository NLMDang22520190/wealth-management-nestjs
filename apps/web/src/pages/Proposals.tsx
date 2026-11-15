import { useId, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ApiFailure, api, describe, intentDone, intentKey } from '../api';
import { formatDateTime } from '../format';
import { AlertAction, BusyButton, Empty, ErrorAlert, Fact, Facts, Field, Loading, PageTitle, Panel, invalidProps, useLoad } from '../ui';
import { money } from './Cash';
import { plainNumber } from './Prices';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';

export interface ProposalLeg {
  legId: string; legNo: number; action: string; assetCode: string; assetName: string; quantity: string; expectedPrice: string; estimatedAmount: string;
  executedPrice: string | null; executedAmount: string | null;
}
export interface Proposal {
  proposalId: string; proposalCode: string; customerId: string; fullName: string; status: string; totalEstimatedBuy: string; totalEstimatedSell: string; cashAtCreation: string;
  note: string | null; rejectionReason: string | null; cancelReason: string | null; failureReason: string | null; createdAt: string; expiresAt: string; closedAt: string | null;
  legs: ProposalLeg[];
}

export const actionLabels: Record<string, string> = { BUY: 'Mua', SELL: 'Bán', OPEN: 'Mở tiền gửi', SETTLE: 'Tất toán tiền gửi' };
const statusLabels: Record<string, string> = { PENDING_APPROVAL: 'Chờ duyệt', APPROVED: 'Đã duyệt', EXECUTING: 'Đang khớp', EXECUTED: 'Đã khớp lệnh', REJECTED: 'Khách từ chối',
  CANCELLED: 'RM đã hủy', EXPIRED: 'Hết hạn', FAILED: 'Thất bại' };
const statusVariants: Record<string, 'wait' | 'ok' | 'bad' | 'outline'> = { PENDING_APPROVAL: 'wait', EXECUTED: 'ok', FAILED: 'bad', REJECTED: 'outline', CANCELLED: 'outline', EXPIRED: 'outline' };
export const failureLabels: Record<string, string> = { SLIPPAGE_EXCEEDED: 'Giá thị trường lệch quá 5% so với giá dự kiến', INSUFFICIENT_FUNDS_FOR_EXECUTION: 'Không đủ tiền khi khớp lệnh',
  HOLDING_UNAVAILABLE: 'Tài sản cần bán không còn đủ', EXECUTION_ERROR: 'Lỗi khi khớp lệnh' };

export function ProposalStatus({ status }: { status: string }) {
  return <Badge variant={statusVariants[status] ?? 'wait'}>{statusLabels[status] ?? status}</Badge>;
}

/** One proposal: its legs, totals and outcome. `children` holds the actions the viewer may take. */
export function ProposalCard({ proposal, children }: { proposal: Proposal; children?: ReactNode }) {
  return (
    <li className="rounded-lg border bg-card px-3.5 py-3">
      <p className="m-0 mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold"><span className="break-all">{proposal.proposalCode}</span><ProposalStatus status={proposal.status} /></p>
      <p className="m-0 mb-2 text-[0.9rem] text-muted-foreground">{proposal.fullName} · tạo lúc {formatDateTime(proposal.createdAt)}{proposal.status === 'PENDING_APPROVAL' ? ` · hết hạn ${formatDateTime(proposal.expiresAt)}` : ''}</p>
      <ul className="m-0 mb-2 grid list-none gap-1 p-0" aria-label={`Chân lệnh của ${proposal.proposalCode}`}>
        {proposal.legs.map(leg => (
          <li key={leg.legId} className="flex flex-wrap justify-between gap-x-3 rounded-md bg-muted px-3 py-1.5 text-[0.92rem]">
            <span className="min-w-0 break-words">{actionLabels[leg.action]} {leg.assetCode}{leg.action === 'BUY' || leg.action === 'SELL' ? ` · ${plainNumber(leg.quantity)} × ${plainNumber(leg.executedPrice ?? leg.expectedPrice)}` : ''}</span>
            <strong className="tabular-nums">{money(leg.executedAmount ?? leg.estimatedAmount)}</strong>
          </li>
        ))}
      </ul>
      <Facts>
        <Fact label="Tổng mua dự kiến">{money(proposal.totalEstimatedBuy)}</Fact>
        <Fact label="Tổng bán dự kiến">{money(proposal.totalEstimatedSell)}</Fact>
        <Fact label="Tiền mặt lúc lập">{money(proposal.cashAtCreation)}</Fact>
      </Facts>
      {proposal.note ? <p className="m-0 mb-1 text-[0.92rem]">Ghi chú: {proposal.note}</p> : null}
      {proposal.failureReason ? <p className="m-0 mb-1 text-[0.92rem] text-destructive">{failureLabels[proposal.failureReason] ?? proposal.failureReason}</p> : null}
      {proposal.rejectionReason ? <p className="m-0 mb-1 text-[0.92rem]">Lý do từ chối: {proposal.rejectionReason}</p> : null}
      {proposal.cancelReason ? <p className="m-0 mb-1 text-[0.92rem]">Lý do hủy: {proposal.cancelReason}</p> : null}
      {children}
    </li>
  );
}

function CancelDialog({ proposal, onClose, onDone }: { proposal: Proposal; onClose: () => void; onDone: () => void }) {
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(null); setReasonError(null);
    if (reason.trim().length < 10) { setReasonError('Nhập lý do từ 10 ký tự.'); document.getElementById(reasonId)?.focus(); return; }
    setBusy(true);
    const name = `proposal-cancel-${proposal.proposalId}`;
    try {
      await api(`/proposals/${proposal.proposalId}/cancel`, { key: intentKey(name, reason), body: { reason: reason.trim() } });
      intentDone(name);
      onDone();
    } catch (error) { setFailure(error); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent showCloseButton={false} className="gap-3 p-6 sm:max-w-[460px]">
        <DialogHeader><DialogTitle className="text-[1.15rem] leading-snug font-semibold">Hủy đề xuất</DialogTitle></DialogHeader>
        <form onSubmit={event => void submit(event)} noValidate>
          <p className="break-all">{proposal.proposalCode}</p>
          <Field label="Lý do hủy" htmlFor={reasonId} error={reasonError}>
            <Textarea id={reasonId} maxLength={255} value={reason} onChange={event => setReason(event.target.value)} {...invalidProps(`${reasonId}-error`, reasonError)} />
          </Field>
          {failure ? <ErrorAlert>{describe(failure)}</ErrorAlert> : null}
          <DialogFooter className="-mx-6 -mb-6 mt-2 p-4">
            <Button type="button" variant="outline" onClick={onClose}>Đóng</Button>
            <BusyButton type="submit" busy={busy}>Xác nhận hủy</BusyButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Proposals of one customer on the staff screens; the RM may withdraw a pending one (UC-14), the leader only reads. */
export function CustomerProposals({ customerId, canManage = false }: { customerId: string; canManage?: boolean }) {
  const list = useLoad(signal => api<{ items: Proposal[] }>(`/customers/${customerId}/proposals`, { signal }), [customerId]);
  const [cancelling, setCancelling] = useState<Proposal | null>(null);
  const [notice, setNotice] = useState('');
  return (
    <Panel title="Đề xuất đầu tư">
      {canManage ? <p className="mb-3"><a href={`#/rm/customers/${customerId}/proposals/new`} className="font-semibold">Tạo đề xuất</a></p> : null}
      <p role="status" className="m-0 min-h-6">{notice}</p>
      {list.loading && !list.data ? <Loading /> : null}
      {list.error ? <ErrorAlert>{describe(list.error)} <AlertAction onClick={list.reload}>Thử lại</AlertAction></ErrorAlert> : null}
      {list.data && list.data.items.length === 0 ? <Empty>Khách chưa có đề xuất nào.</Empty> : null}
      {list.data && list.data.items.length > 0 ? (
        <ul className="m-0 grid list-none gap-2 p-0">
          {list.data.items.map(proposal => (
            <ProposalCard key={proposal.proposalId} proposal={proposal}>
              {canManage && proposal.status === 'PENDING_APPROVAL'
                ? <Button type="button" variant="outline" aria-label={`Hủy đề xuất ${proposal.proposalCode}`} onClick={() => setCancelling(proposal)}>Hủy đề xuất</Button> : null}
            </ProposalCard>
          ))}
        </ul>
      ) : null}
      {cancelling ? <CancelDialog key={cancelling.proposalId} proposal={cancelling} onClose={() => setCancelling(null)}
        onDone={() => { setNotice(`Đã hủy đề xuất ${cancelling.proposalCode}.`); setCancelling(null); list.reload(); }} /> : null}
    </Panel>
  );
}

/** RM overview of the proposals of their customers. */
export function RmProposals() {
  const filterId = useId();
  const [status, setStatus] = useState('');
  const list = useLoad(signal => api<{ items: Proposal[] }>(`/rm/proposals${status ? `?status=${status}` : ''}`, { signal }), [status]);
  return (
    <>
      <PageTitle title="Đề xuất đầu tư" hint="Đề xuất của các khách đang phụ trách. Đề xuất chờ duyệt hết hạn sau 24 giờ." />
      <Panel title="Danh sách đề xuất">
        <Field label="Trạng thái" htmlFor={filterId} className="max-w-[260px]">
          <NativeSelect id={filterId} className="w-full" value={status} onChange={event => setStatus(event.target.value)}>
            <NativeSelectOption value="">Tất cả</NativeSelectOption>
            {Object.entries(statusLabels).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}
          </NativeSelect>
        </Field>
        {list.loading && !list.data ? <Loading /> : null}
        {list.error ? <ErrorAlert>{describe(list.error)}</ErrorAlert> : null}
        {list.data && list.data.items.length === 0 ? <Empty>Không có đề xuất nào.</Empty> : null}
        {list.data && list.data.items.length > 0 ? (
          <ul className="m-0 grid list-none gap-2 p-0">
            {list.data.items.map(proposal => (
              <ProposalCard key={proposal.proposalId} proposal={proposal}><a href={`#/rm/customers/${proposal.customerId}`}>Mở trang khách hàng</a></ProposalCard>
            ))}
          </ul>
        ) : null}
      </Panel>
    </>
  );
}

// ---- UC-13 form ----

interface Holding { holdingId: string; assetId: string; assetCode: string; assetName: string; assetClass: string; quantity: string; principal: string; unitPrice: string | null }
interface Product { assetId: string; assetCode: string; assetName: string; assetClass: string; riskLevel: number; latestPrice: string | null }
interface Row { id: number; action: 'BUY' | 'SELL' | 'OPEN' | 'SETTLE'; target: string; value: string }

/** Exact decimal text to an integer at `scale` digits; display only, never sent. */
function scaled(value: string, scale: number): bigint | null {
  const match = /^(\d+)(?:[.,](\d*))?$/.exec(value.trim());
  if (!match) return null;
  const fraction = (match[2] ?? '').slice(0, scale).padEnd(scale, '0');
  return BigInt(match[1]!) * 10n ** BigInt(scale) + BigInt(fraction || '0');
}
const centsText = (cents: bigint) => { const digits = cents.toString().padStart(3, '0'); return `${digits.slice(0, -2)}.${digits.slice(-2)}`; };

/** Quantity (6 decimals) times price (4 decimals), rounded half up to the cent, in BigInt. */
function estimateCents(quantity: string, price: string | null): bigint {
  const q = scaled(quantity, 6);
  const p = price ? scaled(price, 4) : null;
  if (q === null || p === null) return 0n;
  return (q * p + 5n * 10n ** 7n) / 10n ** 8n;
}

export function NewProposal({ customerId, alertId }: { customerId: string; alertId?: string }) {
  const noteId = useId();
  const portfolio = useLoad(signal => api<{ cash: string; items: Holding[] }>(`/customers/${customerId}/portfolio`, { signal }), [customerId]);
  const products = useLoad(signal => api<{ items: Product[] }>('/products', { signal }), []);
  const [rows, setRows] = useState<Row[]>([{ id: 1, action: 'BUY', target: '', value: '' }]);
  const [note, setNote] = useState('');
  const [rowError, setRowError] = useState<{ index: number; text: string } | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Proposal | null>(null);
  const holdings = portfolio.data?.items ?? [];
  const market = (holding: Holding) => holding.assetClass !== 'TERM_DEPOSIT';
  const options = (row: Row) => {
    if (row.action === 'BUY') return (products.data?.items ?? []).filter(item => item.assetClass !== 'TERM_DEPOSIT').map(item => ({ value: item.assetId, label: `${item.assetCode} · mức ${item.riskLevel}` }));
    if (row.action === 'OPEN') return (products.data?.items ?? []).filter(item => item.assetClass === 'TERM_DEPOSIT').map(item => ({ value: item.assetId, label: `${item.assetCode} · mức ${item.riskLevel}` }));
    return holdings.filter(item => (row.action === 'SELL') === market(item)).map(item => ({ value: item.holdingId, label: `${item.assetCode} · ${row.action === 'SELL' ? plainNumber(item.quantity) : money(item.principal)}` }));
  };
  const estimate = (row: Row): bigint => {
    if (row.action === 'OPEN') return scaled(row.value, 2) ?? 0n;
    if (row.action === 'BUY') return estimateCents(row.value, products.data?.items.find(item => item.assetId === row.target)?.latestPrice ?? null);
    const holding = holdings.find(item => item.holdingId === row.target);
    if (!holding) return 0n;
    return row.action === 'SETTLE' ? scaled(holding.principal, 2) ?? 0n : estimateCents(row.value, holding.unitPrice);
  };
  const buys = rows.filter(row => row.action === 'BUY' || row.action === 'OPEN').reduce((total, row) => total + estimate(row), 0n);
  const sells = rows.filter(row => row.action === 'SELL' || row.action === 'SETTLE').reduce((total, row) => total + estimate(row), 0n);
  const cash = portfolio.data ? scaled(portfolio.data.cash, 2) ?? 0n : 0n;
  const update = (id: number, change: Partial<Row>) => { setRowError(null); setRows(previous => previous.map(row => (row.id === id ? { ...row, ...change } : row))); };
  const fieldId = (index: number, part: string) => `${noteId}-leg-${index}-${part}`;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(null); setRowError(null);
    const missing = rows.findIndex(row => !row.target || (row.action !== 'SETTLE' && !row.value.trim()));
    if (missing >= 0) {
      setRowError({ index: missing, text: 'Chọn tài sản và nhập số lượng hoặc số tiền.' });
      document.getElementById(fieldId(missing, rows[missing]!.target ? 'value' : 'target'))?.focus();
      return;
    }
    const legs = rows.map(row => ({ action: row.action, ...(row.action === 'BUY' || row.action === 'OPEN' ? { assetId: row.target } : { holdingId: row.target }),
      ...(row.action === 'BUY' || row.action === 'SELL' ? { quantity: row.value.trim().replace(',', '.') } : {}), ...(row.action === 'OPEN' ? { amount: row.value.trim().replace(',', '.') } : {}) }));
    const body = { legs, ...(note.trim() ? { note: note.trim() } : {}), ...(alertId ? { driftAlertId: alertId } : {}) };
    const name = `proposal-create-${customerId}`;
    setBusy(true);
    try {
      const created = await api<Proposal>(`/customers/${customerId}/proposals`, { key: intentKey(name, JSON.stringify(body)), body });
      intentDone(name);
      setDone(created);
    } catch (error) {
      const legNo = error instanceof ApiFailure ? (error.details as { legNo?: number } | undefined)?.legNo : undefined;
      if (legNo) { setRowError({ index: legNo - 1, text: describe(error) }); document.getElementById(fieldId(legNo - 1, 'target'))?.focus(); }
      else setFailure(error);
    } finally { setBusy(false); }
  };

  if (done) {
    return (
      <Panel title="Đã tạo đề xuất" focusOnMount>
        <p>Đề xuất {done.proposalCode} đã gửi tới khách và chờ duyệt trong 24 giờ.</p>
        <p className="m-0"><a href={`#/rm/customers/${customerId}`}>Quay lại trang khách hàng</a></p>
      </Panel>
    );
  }
  return (
    <>
      <p className="mb-3 text-[0.9rem]"><a href={`#/rm/customers/${customerId}`}>Quay lại trang khách hàng</a></p>
      <PageTitle title="Tạo đề xuất" hint={alertId ? 'Đề xuất tái cân bằng cho cảnh báo lệch đã chọn.' : 'Bán và tất toán được khớp trước, mua và mở tiền gửi sau.'} />
      {portfolio.error || products.error ? <ErrorAlert>{describe(portfolio.error ?? products.error)}</ErrorAlert> : null}
      {portfolio.loading || products.loading ? <Loading /> : null}
      <Panel title="Chân lệnh">
        <form onSubmit={event => void submit(event)} noValidate>
          <ol className="m-0 mb-3 grid list-none gap-3 p-0">
            {rows.map((row, index) => {
              const error = rowError?.index === index ? rowError.text : null;
              return (
                <li key={row.id} className="rounded-lg border bg-card px-3.5 py-3" data-invalid={error ? true : undefined}>
                  <p className="m-0 mb-2 font-semibold">Chân lệnh {index + 1}</p>
                  <div className="grid gap-x-3 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)]">
                    <Field label={`Loại lệnh ${index + 1}`} htmlFor={fieldId(index, 'action')}>
                      <NativeSelect id={fieldId(index, 'action')} className="w-full" value={row.action} onChange={event => update(row.id, { action: event.target.value as Row['action'], target: '', value: '' })}>
                        {Object.entries(actionLabels).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}
                      </NativeSelect>
                    </Field>
                    <Field label={`Tài sản ${index + 1}`} htmlFor={fieldId(index, 'target')}>
                      <NativeSelect id={fieldId(index, 'target')} className="w-full" value={row.target} onChange={event => update(row.id, { target: event.target.value })}
                        {...invalidProps(`${fieldId(index, 'target')}-error`, error)}>
                        <NativeSelectOption value="">Chọn</NativeSelectOption>
                        {options(row).map(option => <NativeSelectOption key={option.value} value={option.value}>{option.label}</NativeSelectOption>)}
                      </NativeSelect>
                    </Field>
                    {row.action === 'SETTLE' ? null : (
                      <Field label={row.action === 'OPEN' ? `Số tiền gửi ${index + 1}` : `Số lượng ${index + 1}`} htmlFor={fieldId(index, 'value')}>
                        <Input id={fieldId(index, 'value')} inputMode="decimal" autoComplete="off" value={row.value} onChange={event => update(row.id, { value: event.target.value })} />
                      </Field>
                    )}
                  </div>
                  {error ? <p id={`${fieldId(index, 'target')}-error`} className="m-0 mb-2 text-[0.92rem] font-medium text-destructive">{error}</p> : null}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[0.92rem] text-muted-foreground">Ước tính: {money(centsText(estimate(row)))}</span>
                    {rows.length > 1 ? <Button type="button" variant="outline" size="sm" onClick={() => setRows(previous => previous.filter(item => item.id !== row.id))}>Bỏ chân lệnh {index + 1}</Button> : null}
                  </div>
                </li>
              );
            })}
          </ol>
          <Button type="button" variant="outline" className="mb-4" disabled={rows.length >= 20}
            onClick={() => setRows(previous => [...previous, { id: Math.max(...previous.map(row => row.id)) + 1, action: 'BUY', target: '', value: '' }])}>Thêm chân lệnh</Button>
          <Facts>
            <Fact label="Tiền mặt khả dụng">{money(centsText(cash))}</Fact>
            <Fact label="Tổng bán ước tính">{money(centsText(sells))}</Fact>
            <Fact label="Tổng mua ước tính">{money(centsText(buys))}</Fact>
          </Facts>
          {buys > cash + sells ? <p className="m-0 mb-3 font-semibold text-destructive" role="status">Tổng mua vượt tiền mặt cộng tiền bán dự kiến.</p> : null}
          <Field label="Ghi chú cho khách" htmlFor={noteId}><Textarea id={noteId} maxLength={500} value={note} onChange={event => setNote(event.target.value)} /></Field>
          {failure ? <ErrorAlert>{describe(failure)}</ErrorAlert> : null}
          <BusyButton type="submit" busy={busy}>Gửi đề xuất</BusyButton>
        </form>
      </Panel>
    </>
  );
}

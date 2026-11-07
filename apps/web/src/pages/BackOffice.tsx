import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { api, describe, intentDone, intentKey } from '../api';
import { formatDate, formatDateTime } from '../format';
import { AlertAction, BusyButton, Empty, ErrorAlert, Fact, Facts, Field, Loading, PageTitle, Panel, invalidProps, useLoad } from '../ui';
import { CashHistory, money, typeLabels } from './Cash';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';

interface QueueItem { txnId: string; refNo: string; txnType: string; amount: string; cifId: string; retryCount: number; createdAt: string }
interface MaturityRun { asOf: string; settled: number; skipped: number; failed: Array<{ holdingId: string; code: string }>; ranAt?: string }
interface ReconciliationRun { checked: number; succeeded: number; failed: number; unanswered: number; expired: number; recovered: number }

const dayText = (asOf: string) => formatDate(`${asOf}T12:00:00+07:00`);

function ResolveDialog({ item, onClose, onResolved }: { item: QueueItem; onClose: () => void; onResolved: () => void }) {
  const outcomeId = useId();
  const noteId = useId();
  const [outcome, setOutcome] = useState('SUCCESS');
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(null); setNoteError(null);
    if (!note.trim()) { setNoteError('Nhập ghi chú đối chiếu.'); document.getElementById(noteId)?.focus(); return; }
    setBusy(true);
    const name = `resolve-${item.txnId}`;
    try {
      await api(`/back-office/cash-transactions/${item.txnId}/resolve`, { key: intentKey(name, `${outcome}:${note}`), body: { outcome, note: note.trim() } });
      intentDone(name);
      onResolved();
    } catch (error) { setFailure(error); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent showCloseButton={false} className="gap-3 p-6 sm:max-w-[460px]">
        <DialogHeader><DialogTitle className="text-[1.15rem] leading-snug font-semibold">Chốt giao dịch</DialogTitle></DialogHeader>
        <form onSubmit={event => void submit(event)} noValidate>
          <p className="break-all">{item.refNo} · {money(item.amount)}</p>
          <Field label="Kết quả" htmlFor={outcomeId}>
            <NativeSelect id={outcomeId} className="w-full" value={outcome} onChange={event => setOutcome(event.target.value)}>
              <NativeSelectOption value="SUCCESS">Ngân hàng lõi đã hạch toán: thành công</NativeSelectOption>
              <NativeSelectOption value="FAILED">Ngân hàng lõi chưa hạch toán: thất bại</NativeSelectOption>
            </NativeSelect>
          </Field>
          <Field label="Ghi chú" htmlFor={noteId} error={noteError}>
            <Textarea id={noteId} maxLength={500} value={note} onChange={event => setNote(event.target.value)} {...invalidProps(`${noteId}-error`, noteError)} />
          </Field>
          {failure ? <ErrorAlert>{describe(failure)}</ErrorAlert> : null}
          <DialogFooter className="-mx-6 -mb-6 mt-2 p-4">
            <Button type="button" variant="outline" onClick={onClose}>Hủy</Button>
            <BusyButton type="submit" busy={busy}>Xác nhận chốt</BusyButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Search() {
  const cifId = useId();
  const [draft, setDraft] = useState('');
  const [cif, setCif] = useState<string | null>(null);
  return (
    <Panel title="Tra cứu giao dịch">
      <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); setCif(draft.trim()); }}>
        <Field label="Mã CIF" htmlFor={cifId} className="mb-0 flex-[1_1_180px]"><Input id={cifId} autoComplete="off" value={draft} onChange={event => setDraft(event.target.value)} /></Field>
        <Button type="submit" variant="outline">Tra cứu</Button>
      </form>
      {cif !== null ? <div className="mt-3"><CashHistory basePath="/back-office/cash-transactions" query={cif ? `cifId=${encodeURIComponent(cif)}` : ''} /></div> : null}
    </Panel>
  );
}

/** Process 2c queue and UC-08 report. The manual job triggers exist only while mocks are enabled; the server answers 404 otherwise. */
export function BackOffice() {
  const dateId = useId();
  const [version, setVersion] = useState(0);
  const queue = useLoad(signal => api<{ items: QueueItem[] }>('/back-office/cash-transactions?needsReview=true&pageSize=100', { signal }), [version]);
  const runs = useLoad(signal => api<{ items: MaturityRun[] }>('/back-office/maturity-runs', { signal }), [version]);
  const [resolving, setResolving] = useState<QueueItem | null>(null);
  const [asOf, setAsOf] = useState('');
  const [rounds, setRounds] = useState(0);
  const [jobText, setJobText] = useState('');
  const [jobFailure, setJobFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => setVersion(value => value + 1);

  const reconcile = async () => {
    setBusy(true); setJobFailure(null);
    try {
      const run = await api<ReconciliationRun>('/demo/jobs/reconciliation', { method: 'POST' });
      const round = rounds + 1;
      setRounds(round);
      setJobText(`Đối soát lượt ${round}: kiểm tra ${run.checked}, thành công ${run.succeeded}, thất bại ${run.failed}, chưa có phản hồi ${run.unanswered}, lệnh hết hạn OTP ${run.expired}.`);
      refresh();
    } catch (error) { setJobFailure(error); } finally { setBusy(false); }
  };
  const settle = async () => {
    setBusy(true); setJobFailure(null);
    try {
      const run = await api<MaturityRun>('/demo/jobs/maturity-settlement', { body: asOf ? { asOf } : {} });
      setJobText(`Tất toán ngày ${dayText(run.asOf)}: thành công ${run.settled}, bỏ qua ${run.skipped}, lỗi ${run.failed.length}.`);
      refresh();
    } catch (error) { setJobFailure(error); } finally { setBusy(false); }
  };

  return (
    <>
      <PageTitle title="Vận hành dòng tiền" hint="Chốt các giao dịch treo sau 3 lượt đối soát và theo dõi kết quả tất toán tiền gửi." />
      <Panel title="Giao dịch cần xử lý">
        {queue.loading && !queue.data ? <Loading /> : null}
        {queue.error ? <ErrorAlert>{describe(queue.error)} <AlertAction onClick={queue.reload}>Thử lại</AlertAction></ErrorAlert> : null}
        {queue.data && queue.data.items.length === 0 ? <Empty>Không có giao dịch nào cần xử lý.</Empty> : null}
        {queue.data && queue.data.items.length > 0 ? (
          <ul className="m-0 grid list-none gap-2 p-0">
            {queue.data.items.map(item => (
              <li key={item.txnId} className="rounded-lg border bg-card px-3.5 py-3">
                <Facts>
                  <Fact label="Giao dịch">{typeLabels[item.txnType] ?? item.txnType}</Fact>
                  <Fact label="Số tiền">{money(item.amount)}</Fact>
                  <Fact label="Khách hàng">{item.cifId}</Fact>
                  <Fact label="Mã tham chiếu"><span className="break-all">{item.refNo}</span></Fact>
                  <Fact label="Tạo lúc">{formatDateTime(item.createdAt)}</Fact>
                </Facts>
                <Button type="button" aria-label={`Chốt giao dịch ${item.refNo}`} onClick={() => setResolving(item)}>Chốt giao dịch</Button>
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>
      {resolving ? <ResolveDialog key={resolving.txnId} item={resolving} onClose={() => setResolving(null)} onResolved={() => { setResolving(null); refresh(); }} /> : null}
      <Panel title="Chạy tác vụ (demo)">
        <div className="flex flex-wrap items-end gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={() => void reconcile()}>Chạy đối soát</Button>
          <Field label="Ngày chạy" htmlFor={dateId} className="mb-0 flex-[1_1_180px]"><Input id={dateId} type="date" value={asOf} onChange={event => setAsOf(event.target.value)} /></Field>
          <Button type="button" variant="outline" disabled={busy} onClick={() => void settle()}>Chạy tất toán</Button>
        </div>
        <p role="status" data-testid="job-result" className="m-0 mt-3 min-h-6">{jobText}</p>
        {jobFailure ? <ErrorAlert>{describe(jobFailure)}</ErrorAlert> : null}
      </Panel>
      <Panel title="Báo cáo tất toán">
        {runs.error ? <ErrorAlert>{describe(runs.error)}</ErrorAlert> : null}
        {runs.data && runs.data.items.length === 0 ? <Empty>Chưa có lượt tất toán nào.</Empty> : null}
        {runs.data && runs.data.items.length > 0 ? (
          <ul className="m-0 grid list-none gap-2 p-0">
            {runs.data.items.map(run => (
              <li key={`${run.ranAt}-${run.asOf}`} className="rounded-lg border bg-card px-3.5 py-2.5">
                <p className="m-0 font-semibold">Ngày {dayText(run.asOf)}: thành công {run.settled}, bỏ qua {run.skipped}, lỗi {run.failed.length}</p>
                {run.ranAt ? <p className="m-0 text-[0.9rem] text-muted-foreground">Chạy lúc {formatDateTime(run.ranAt)}</p> : null}
                {run.failed.map(item => <p key={item.holdingId} className="m-0 text-[0.9rem] break-all text-destructive">Lỗi khoản {item.holdingId}</p>)}
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>
      <Search />
    </>
  );
}

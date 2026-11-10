import { useId, useState } from 'react';
import { api, describe, intentDone, intentKey } from '../api';
import { AlertAction, BusyButton, Empty, ErrorAlert, Fact, Facts, Field, Loading, PageTitle, Panel, invalidProps, useLoad } from '../ui';
import { dayText, plainNumber, priceTypeLabels } from './Prices';
import type { PendingPrice } from './Prices';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';

function DecisionDialog({ item, onClose, onDecided }: { item: PendingPrice; onClose: () => void; onDecided: (text: string) => void }) {
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const decide = async (decision: 'approve' | 'reject') => {
    setFailure(null); setReasonError(null);
    if (!reason.trim()) { setReasonError('Nhập lý do.'); document.getElementById(reasonId)?.focus(); return; }
    setBusy(decision);
    const name = `price-${decision}-${item.pricingId}`;
    try {
      await api(`/back-office/prices/${item.pricingId}/${decision}`, { key: intentKey(name, reason), body: { reason: reason.trim() } });
      intentDone(name);
      onDecided(`${decision === 'approve' ? 'Đã duyệt' : 'Đã từ chối'} giá ${item.assetCode}.`);
    } catch (error) { setFailure(error); } finally { setBusy(null); }
  };
  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent showCloseButton={false} className="gap-3 p-6 sm:max-w-[460px]">
        <DialogHeader><DialogTitle className="text-[1.15rem] leading-snug font-semibold">Duyệt giá</DialogTitle></DialogHeader>
        <p className="m-0 break-words">{item.assetCode}: {item.previousValue ? plainNumber(item.previousValue) : 'chưa có'} → {plainNumber(item.value)}</p>
        <Field label="Lý do" htmlFor={reasonId} error={reasonError}>
          <Textarea id={reasonId} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} {...invalidProps(`${reasonId}-error`, reasonError)} />
        </Field>
        {failure ? <ErrorAlert>{describe(failure)}</ErrorAlert> : null}
        <DialogFooter className="-mx-6 -mb-6 mt-2 p-4">
          <Button type="button" variant="outline" disabled={busy !== null} onClick={onClose}>Hủy</Button>
          <BusyButton type="button" variant="outline" busy={busy === 'reject'} disabled={busy !== null} onClick={() => void decide('reject')}>Từ chối giá</BusyButton>
          <BusyButton type="button" busy={busy === 'approve'} disabled={busy !== null} onClick={() => void decide('approve')}>Duyệt giá</BusyButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** BR-15: the second person. The server refuses anyone else, and refuses a manager deciding on a price they entered. */
export function PriceApprovals() {
  const pending = useLoad(signal => api<{ items: PendingPrice[] }>('/back-office/prices/pending', { signal }), []);
  const [deciding, setDeciding] = useState<PendingPrice | null>(null);
  const [notice, setNotice] = useState('');
  return (
    <>
      <PageTitle title="Duyệt giá" hint="Giá biến động trên 20% chỉ được dùng để định giá sau khi được duyệt." />
      <p role="status" className="m-0 min-h-6">{notice}</p>
      <Panel title="Giá cần duyệt">
        {pending.loading && !pending.data ? <Loading /> : null}
        {pending.error ? <ErrorAlert>{describe(pending.error)} <AlertAction onClick={pending.reload}>Thử lại</AlertAction></ErrorAlert> : null}
        {pending.data && pending.data.items.length === 0 ? <Empty>Không có giá nào cần duyệt.</Empty> : null}
        {pending.data && pending.data.items.length > 0 ? (
          <ul className="m-0 grid list-none gap-2 p-0">
            {pending.data.items.map(item => (
              <li key={item.pricingId} className="rounded-lg border bg-card px-3.5 py-3">
                <p className="m-0 mb-2 font-semibold break-words">{item.assetName} <span className="font-normal text-muted-foreground">({item.assetCode})</span></p>
                <Facts>
                  <Fact label="Loại giá">{priceTypeLabels[item.priceType]}</Fact>
                  <Fact label="Giá cũ">{item.previousValue ? plainNumber(item.previousValue) : 'Chưa có'}</Fact>
                  <Fact label="Giá mới">{plainNumber(item.value)}</Fact>
                  <Fact label="Thay đổi">{item.changePct ? `${plainNumber(item.changePct)}%` : 'Không áp dụng'}</Fact>
                  <Fact label="Ngày hiệu lực">{dayText(item.effectiveDate)}</Fact>
                  <Fact label="Người nhập">{item.makerCode}</Fact>
                </Facts>
                <Button type="button" aria-label={`Xử lý giá ${item.assetCode}`} onClick={() => setDeciding(item)}>Xử lý</Button>
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>
      {deciding ? <DecisionDialog key={deciding.pricingId} item={deciding} onClose={() => setDeciding(null)} onDecided={text => { setDeciding(null); setNotice(text); pending.reload(); }} /> : null}
    </>
  );
}

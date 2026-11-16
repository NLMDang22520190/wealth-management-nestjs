import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiFailure, api, describe, intentDone, intentKey } from '../api';
import { BusyButton, Empty, ErrorAlert, Field, Loading, OtpCodeInput, OtpInbox, PageTitle, Panel, invalidProps, useLoad } from '../ui';
import { ProposalCard, failureLabels } from './Proposals';
import type { Proposal } from './Proposals';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';

interface Challenge { challengeId: string; expiresAt: string }

function RejectDialog({ proposal, onClose, onDone }: { proposal: Proposal; onClose: () => void; onDone: () => void }) {
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(null); setReasonError(null);
    if (!reason.trim()) { setReasonError('Nhập lý do từ chối.'); document.getElementById(reasonId)?.focus(); return; }
    setBusy(true);
    const name = `proposal-reject-${proposal.proposalId}`;
    try {
      await api(`/me/proposals/${proposal.proposalId}/reject`, { key: intentKey(name, reason), body: { reason: reason.trim() } });
      intentDone(name);
      onDone();
    } catch (error) { setFailure(error); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent showCloseButton={false} className="gap-3 p-6 sm:max-w-[460px]">
        <DialogHeader><DialogTitle className="text-[1.15rem] leading-snug font-semibold">Từ chối đề xuất</DialogTitle></DialogHeader>
        <form onSubmit={event => void submit(event)} noValidate>
          <Field label="Lý do từ chối" htmlFor={reasonId} error={reasonError}>
            <Textarea id={reasonId} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} {...invalidProps(`${reasonId}-error`, reasonError)} />
          </Field>
          {failure ? <ErrorAlert>{describe(failure)}</ErrorAlert> : null}
          <DialogFooter className="-mx-6 -mb-6 mt-2 p-4">
            <Button type="button" variant="outline" onClick={onClose}>Đóng</Button>
            <BusyButton type="submit" busy={busy}>Xác nhận từ chối</BusyButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** UC-15 for the customer: the slippage check and OTP happen on the server; this only collects the code. */
function Approval({ proposal, onFinished }: { proposal: Proposal; onFinished: (result: Proposal | null, failure?: unknown) => void }) {
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [rejections, setRejections] = useState(0);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true); setFailure(null);
    const name = `proposal-challenge-${proposal.proposalId}`;
    try {
      setChallenge(await api<Challenge>(`/me/proposals/${proposal.proposalId}/approval-challenge`, { key: intentKey(name, proposal.proposalId), method: 'POST' }));
      intentDone(name);
      setCode('');
    } catch (error) {
      if (error instanceof ApiFailure && ['SLIPPAGE_EXCEEDED', 'PROPOSAL_EXPIRED', 'PROPOSAL_NOT_PENDING'].includes(error.code)) onFinished(null, error);
      else setFailure(error);
    } finally { setBusy(false); }
  };
  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    if (!challenge) return;
    setFailure(null); setCodeError(null);
    if (code.length !== 6) { setCodeError('Nhập đủ 6 chữ số.'); setRejections(value => value + 1); return; }
    setBusy(true);
    const name = `proposal-approve-${proposal.proposalId}`;
    try {
      const result = await api<Proposal>(`/me/proposals/${proposal.proposalId}/approve`, { key: intentKey(name, `${challenge.challengeId}:${code}`), body: { challengeId: challenge.challengeId, code } });
      intentDone(name);
      onFinished(result);
    } catch (error) {
      if (error instanceof ApiFailure && error.code === 'OTP_INVALID') { setCodeError('Mã OTP không đúng. Thử lại (tối đa 3 lần cho mỗi mã).'); setRejections(value => value + 1); }
      else if (error instanceof ApiFailure && ['OTP_EXPIRED', 'OTP_ATTEMPTS_EXCEEDED'].includes(error.code)) { setChallenge(null); setFailure(error); }
      else setFailure(error);
    } finally { setBusy(false); }
  };
  if (!challenge) {
    return (
      <>
        <BusyButton type="button" busy={busy} aria-label={`Phê duyệt ${proposal.proposalCode}`} onClick={() => void start()}>Phê duyệt và đầu tư</BusyButton>
        {failure ? <ErrorAlert>{describe(failure)}</ErrorAlert> : null}
      </>
    );
  }
  return (
    <form className="mt-2" onSubmit={event => void confirm(event)} noValidate>
      <p className="m-0 mb-2">Nhập mã Smart OTP để ký duyệt đề xuất {proposal.proposalCode}.</p>
      <OtpInbox key={`inbox-${challenge.challengeId}`} challengeId={challenge.challengeId} />
      <OtpCodeInput key={challenge.challengeId} onChange={setCode} disabled={busy} error={codeError} focusToken={rejections || undefined} />
      {failure ? <ErrorAlert>{describe(failure)}</ErrorAlert> : null}
      <BusyButton type="submit" busy={busy}>Xác nhận OTP</BusyButton>
    </form>
  );
}

const outcomeText = (result: Proposal) => (result.status === 'EXECUTED'
  ? 'Giao dịch đã được khớp lệnh. Danh mục của bạn đã được cập nhật.'
  : `Đề xuất không thực hiện được: ${failureLabels[result.failureReason ?? ''] ?? result.failureReason}. Số dư và danh mục giữ nguyên.`);

export function MyProposals() {
  const [version, setVersion] = useState(0);
  const list = useLoad(signal => api<{ items: Proposal[] }>('/me/proposals', { signal }), [version]);
  const [rejecting, setRejecting] = useState<Proposal | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const finished = (result: Proposal | null, failure?: unknown) => {
    setOutcome(result ? outcomeText(result) : describe(failure));
    setVersion(value => value + 1);
  };
  return (
    <>
      <PageTitle title="Đề xuất đầu tư" hint="Đề xuất từ chuyên viên tư vấn có hiệu lực 24 giờ. Phê duyệt cần mã Smart OTP." />
      {outcome ? (
        <Panel title="Kết quả duyệt" focusOnMount key={outcome}>
          <p className="m-0">{outcome}</p>
          <p className="m-0 mt-2"><a href="#/portfolio">Xem danh mục</a></p>
        </Panel>
      ) : null}
      <p role="status" className="m-0 min-h-6">{notice}</p>
      <Panel title="Đề xuất của tôi">
        {list.loading && !list.data ? <Loading /> : null}
        {list.error ? <ErrorAlert>{describe(list.error)}</ErrorAlert> : null}
        {list.data && list.data.items.length === 0 ? <Empty>Bạn chưa có đề xuất nào.</Empty> : null}
        {list.data && list.data.items.length > 0 ? (
          <ul className="m-0 grid list-none gap-2 p-0">
            {list.data.items.map(proposal => (
              <ProposalCard key={proposal.proposalId} proposal={proposal}>
                {proposal.status === 'PENDING_APPROVAL' ? (
                  <div className="mt-2 grid gap-2">
                    <Approval proposal={proposal} onFinished={finished} />
                    <Button type="button" variant="outline" className="justify-self-start" aria-label={`Từ chối ${proposal.proposalCode}`} onClick={() => setRejecting(proposal)}>Từ chối</Button>
                  </div>
                ) : null}
              </ProposalCard>
            ))}
          </ul>
        ) : null}
      </Panel>
      {rejecting ? <RejectDialog key={rejecting.proposalId} proposal={rejecting} onClose={() => setRejecting(null)}
        onDone={() => { setNotice(`Đã từ chối đề xuất ${rejecting.proposalCode}.`); setRejecting(null); setVersion(value => value + 1); }} /> : null}
    </>
  );
}

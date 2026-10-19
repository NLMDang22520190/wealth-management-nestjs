import { useState } from 'react';
import { ApiFailure, api, describe, intentDone, intentKey } from '../api';
import { formatDateTime } from '../format';
import { AlertAction, Choice, Empty, ErrorAlert, Fact, Facts, Loading, OtpCodeInput, OtpInbox, PageTitle, Panel, ResendCode, choiceInput, useLoad } from '../ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface Invitation { id: string; status: string; expiresAt: string; termsVersion: string }
interface Detail extends Invitation { terms: string }
interface Challenge { challengeId: string; expiresAt: string }

const statusText: Record<string, string> = { PENDING_CONSENT: 'Chờ đồng ý', EXPIRED: 'Đã hết hạn', CONFIRMED: 'Đã đồng ý' };
const statusVariant = { PENDING_CONSENT: 'wait', EXPIRED: 'bad', CONFIRMED: 'ok' } as const;

function InvitationCard({ item }: { item: Invitation }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [code, setCode] = useState('');
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const guarded = async (work: () => Promise<void>) => {
    setBusy(true); setFailure(null);
    try { await work(); } catch (error) { setFailure(error); } finally { setBusy(false); }
  };
  const readTerms = () => guarded(async () => setDetail(await api<Detail>(`/me/onboarding-requests/${item.id}`)));
  const sendOtp = () => guarded(async () => {
    setCode('');
    setChallenge(await api<Challenge>('/otp/challenges', { body: { purpose: 'SERVICE_CONSENT', operationId: item.id } }));
  });
  const confirm = () => guarded(async () => {
    if (!challenge) return;
    if (!/^\d{6}$/.test(code)) throw new Error('otp-format');
    const name = `consent-${item.id}`;
    await api('/me/onboarding-requests/' + item.id + '/confirm', { key: intentKey(name, `${challenge.challengeId}:${code}`),
      body: { challengeId: challenge.challengeId, code } });
    intentDone(name);
    setDone(true);
  });

  if (done) {
    return (
      <Panel key="done" title="Đăng ký dịch vụ" tone="success" focusOnMount>
        <p className="font-semibold text-ok">Đã đồng ý dịch vụ</p>
        <p>Chờ đánh giá rủi ro. Mở mục Khảo sát rủi ro để hoàn tất hồ sơ.</p>
      </Panel>
    );
  }
  const pending = item.status === 'PENDING_CONSENT';
  // A rejected code is shown at the code boxes as well as in the page alert.
  const otpError = failure instanceof Error && failure.message === 'otp-format' ? 'Nhập đủ 6 chữ số của mã OTP.'
    : failure instanceof ApiFailure && failure.code.startsWith('OTP_') ? describe(failure) : null;
  return (
    <Panel key="open" title={`Lời mời đăng ký dịch vụ, điều khoản ${item.termsVersion}`}>
      <Facts>
        <Fact label="Trạng thái"><Badge variant={statusVariant[item.status as keyof typeof statusVariant] ?? 'wait'}>{statusText[item.status] ?? item.status}</Badge></Fact>
        <Fact label="Hiệu lực đến">{formatDateTime(item.expiresAt)}</Fact>
      </Facts>
      {item.status === 'EXPIRED' ? <p className="text-muted-foreground">Lời mời đã hết hạn. Liên hệ RM để nhận lời mời mới.</p> : null}
      {pending && !detail ? <Button type="button" onClick={() => void readTerms()} disabled={busy}>Xem điều khoản</Button> : null}
      {pending && detail ? (
        <>
          <section className="my-3 max-h-[280px] overflow-auto rounded-lg border bg-muted px-4 py-3.5" aria-labelledby={`terms-${item.id}`}>
            <h3 id={`terms-${item.id}`} className="mt-0 text-[0.95rem] font-semibold">Điều khoản dịch vụ</h3>
            <p className="m-0 whitespace-pre-wrap">{detail.terms}</p>
          </section>
          <Choice>
            <input type="checkbox" className={choiceInput} checked={agreed} onChange={event => setAgreed(event.target.checked)} />
            <span>Tôi đã đọc và đồng ý với điều khoản</span>
          </Choice>
          <Button type="button" onClick={() => void sendOtp()} disabled={!agreed || busy}>Gửi mã OTP</Button>
          {challenge ? (
            <div className="mt-4 border-t pt-4">
              <OtpInbox key={`inbox-${challenge.challengeId}`} challengeId={challenge.challengeId} />
              <p className="text-muted-foreground">Mã có hiệu lực đến {formatDateTime(challenge.expiresAt)}.</p>
              <OtpCodeInput key={challenge.challengeId} onChange={setCode} disabled={busy} error={otpError} focusToken={otpError ? failure : null} />
              <ResendCode key={`resend-${challenge.challengeId}`} onResend={() => void sendOtp()} busy={busy} />
              <Button type="button" onClick={() => void confirm()} disabled={busy || code.length < 6}>Xác nhận đồng ý</Button>
            </div>
          ) : null}
        </>
      ) : null}
      {busy ? <Loading label="Đang xử lý…" /> : null}
      {failure ? <ErrorAlert>{failure instanceof Error && failure.message === 'otp-format'
        ? 'Mã OTP gồm đúng 6 chữ số.' : describe(failure)}</ErrorAlert> : null}
    </Panel>
  );
}

/** UC01 (customer): own invitations, immutable terms, bound OTP, explicit confirmation. */
export function Invitations() {
  const list = useLoad(signal => api<{ items: Invitation[] }>('/me/onboarding-requests', { signal }), []);
  return (
    <>
      <PageTitle title="Lời mời dịch vụ" hint="Đọc điều khoản, nhận mã OTP và tự nhập mã để đồng ý sử dụng dịch vụ." />
      {list.loading && !list.data ? <Loading skeleton /> : null}
      {list.error ? <ErrorAlert>{describe(list.error)} <AlertAction onClick={list.reload}>Thử lại</AlertAction></ErrorAlert> : null}
      {list.data && list.data.items.length === 0 ? <Empty>Bạn chưa có lời mời nào. RM sẽ gửi lời mời khi đăng ký dịch vụ cho bạn.</Empty> : null}
      {list.data?.items.map(item => <InvitationCard key={item.id} item={item} />)}
    </>
  );
}

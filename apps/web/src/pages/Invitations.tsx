import { useState } from 'react';
import { api, describe, intentDone, intentKey } from '../api';
import { formatDateTime } from '../format';
import { Empty, ErrorAlert, Loading, OtpInbox, PageTitle, Panel, useLoad } from '../ui';

interface Invitation { id: string; status: string; expiresAt: string; termsVersion: string }
interface Detail extends Invitation { terms: string }
interface Challenge { challengeId: string; expiresAt: string }

const statusText: Record<string, string> = { PENDING_CONSENT: 'Chờ đồng ý', EXPIRED: 'Đã hết hạn', CONFIRMED: 'Đã đồng ý' };
const statusClass: Record<string, string> = { PENDING_CONSENT: 'wait', EXPIRED: 'bad', CONFIRMED: 'ok' };

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
      <Panel title="Đăng ký dịch vụ" className="success">
        <p className="success-line">Đã đồng ý dịch vụ</p>
        <p>Chờ đánh giá rủi ro. Mở mục Khảo sát rủi ro để hoàn tất hồ sơ.</p>
      </Panel>
    );
  }
  const pending = item.status === 'PENDING_CONSENT';
  return (
    <Panel title={`Lời mời đăng ký dịch vụ, điều khoản ${item.termsVersion}`}>
      <dl className="facts">
        <div><dt>Trạng thái</dt><dd><span className={`badge ${statusClass[item.status] ?? 'wait'}`}>{statusText[item.status] ?? item.status}</span></dd></div>
        <div><dt>Hiệu lực đến</dt><dd>{formatDateTime(item.expiresAt)}</dd></div>
      </dl>
      {item.status === 'EXPIRED' ? <p className="hint">Lời mời đã hết hạn. Liên hệ RM để nhận lời mời mới.</p> : null}
      {pending && !detail ? <button type="button" onClick={() => void readTerms()} disabled={busy}>Xem điều khoản</button> : null}
      {pending && detail ? (
        <>
          <section className="terms" aria-labelledby={`terms-${item.id}`}>
            <h3 id={`terms-${item.id}`}>Điều khoản dịch vụ</h3>
            <p className="terms-text">{detail.terms}</p>
          </section>
          <label className="choice">
            <input type="checkbox" checked={agreed} onChange={event => setAgreed(event.target.checked)} />
            <span>Tôi đã đọc và đồng ý với điều khoản</span>
          </label>
          <button type="button" onClick={() => void sendOtp()} disabled={!agreed || busy}>Gửi mã OTP</button>
          {challenge ? (
            <div className="otp-step">
              <OtpInbox challengeId={challenge.challengeId} />
              <p className="hint">Mã có hiệu lực đến {formatDateTime(challenge.expiresAt)}.</p>
              <div className="field">
                <label htmlFor={`otp-${item.id}`}>Mã OTP</label>
                <input id={`otp-${item.id}`} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode="numeric" autoComplete="off" maxLength={6} />
              </div>
              <button type="button" onClick={() => void confirm()} disabled={busy}>Xác nhận đồng ý</button>
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
      {list.loading && !list.data ? <Loading /> : null}
      {list.error ? <ErrorAlert>{describe(list.error)} <button type="button" className="link" onClick={list.reload}>Thử lại</button></ErrorAlert> : null}
      {list.data && list.data.items.length === 0 ? <Empty>Bạn chưa có lời mời nào. RM sẽ gửi lời mời khi đăng ký dịch vụ cho bạn.</Empty> : null}
      {list.data?.items.map(item => <InvitationCard key={item.id} item={item} />)}
    </>
  );
}

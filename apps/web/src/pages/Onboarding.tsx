import { useState } from 'react';
import type { FormEvent } from 'react';
import { api, describe, intentDone, intentKey } from '../api';
import { formatDateTime } from '../format';
import { ErrorAlert, Loading, PageTitle, Panel } from '../ui';

interface Lookup {
  cifRef: string; name: string; dateOfBirth: string; active: boolean; eligible: boolean;
  accounts: Array<{ id: string; currency: string }>;
}
interface Invitation { id: string; status: string; expiresAt: string; termsVersion: string }

/** UC01 (RM): look up a customer in Core, pick one of their own VND accounts, create an invitation. */
export function Onboarding() {
  const [cif, setCif] = useState('');
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [account, setAccount] = useState('');
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState<'lookup' | 'create' | null>(null);

  const search = async (event: FormEvent) => {
    event.preventDefault();
    const reference = cif.trim();
    if (!reference) { setFailure({ validation: 'Nhập mã CIF hoặc định danh của khách hàng.' }); return; }
    setBusy('lookup'); setFailure(null); setLookup(null); setInvitation(null); setAccount('');
    try { setLookup(await api<Lookup>('/onboarding/customer-lookup', { body: { cifRef: reference } })); }
    catch (error) { setFailure(error); }
    finally { setBusy(null); }
  };

  const create = async () => {
    if (!lookup || !account) return;
    const name = `invite-${lookup.cifRef}`;
    setBusy('create'); setFailure(null);
    try {
      const created = await api<Invitation>('/onboarding/requests', { key: intentKey(name, account),
        body: { cifRef: lookup.cifRef, selectedAccountId: account } });
      intentDone(name);
      setInvitation(created);
    } catch (error) { setFailure(error); }
    finally { setBusy(null); }
  };

  const message = (() => {
    if (!failure) return null;
    if (typeof failure === 'object' && 'validation' in failure) return String((failure as { validation: string }).validation);
    return describe(failure);
  })();

  return (
    <>
      <PageTitle title="Đăng ký khách hàng" hint="Tra cứu khách hàng từ hệ thống lõi, chọn tài khoản VND của chính khách hàng và gửi lời mời dịch vụ." />
      <form className="inline-form" onSubmit={event => void search(event)}>
        <div className="field">
          <label htmlFor="cif">Mã CIF hoặc định danh</label>
          <input id="cif" value={cif} onChange={event => setCif(event.target.value)} autoComplete="off" inputMode="text" />
        </div>
        <button type="submit" disabled={busy !== null}>Tra cứu</button>
      </form>
      {busy === 'lookup' ? <Loading label="Đang tra cứu…" /> : null}
      {message ? <ErrorAlert>{message}</ErrorAlert> : null}

      {lookup && !invitation ? (
        <Panel title="Thông tin khách hàng">
          <dl className="facts">
            <div><dt>Họ tên</dt><dd>{lookup.name}</dd></div>
            <div><dt>Mã CIF</dt><dd>{lookup.cifRef}</dd></div>
            <div><dt>Ngày sinh</dt><dd>{lookup.dateOfBirth.split('-').reverse().join('/')}</dd></div>
            <div><dt>Điều kiện đăng ký</dt><dd>{lookup.eligible ? <span className="badge ok">Đủ điều kiện</span> : <span className="badge bad">Chưa đủ điều kiện</span>}</dd></div>
          </dl>
          {lookup.eligible && lookup.accounts.length > 0 ? (
            <fieldset className="choices">
              <legend>Tài khoản VND của khách hàng</legend>
              {lookup.accounts.map(item => (
                <label key={item.id} className="choice">
                  <input type="radio" name="account" value={item.id} checked={account === item.id} onChange={() => setAccount(item.id)} />
                  <span>Tài khoản {item.currency} <code>{item.id}</code></span>
                </label>
              ))}
            </fieldset>
          ) : <p className="hint">Khách hàng chưa có tài khoản VND hợp lệ hoặc chưa đủ điều kiện nên chưa thể tạo lời mời.</p>}
          <button type="button" onClick={() => void create()} disabled={!lookup.eligible || !account || busy !== null}>Tạo lời mời</button>
        </Panel>
      ) : null}

      {invitation ? (
        <Panel title="Lời mời đã gửi" className="success">
          <p className="success-line">Đã tạo lời mời</p>
          <dl className="facts">
            <div><dt>Trạng thái</dt><dd><span className="badge wait">Chờ khách hàng đồng ý</span></dd></div>
            <div><dt>Hiệu lực đến</dt><dd>{formatDateTime(invitation.expiresAt)}</dd></div>
            <div><dt>Phiên bản điều khoản</dt><dd>{invitation.termsVersion}</dd></div>
          </dl>
        </Panel>
      ) : null}
    </>
  );
}

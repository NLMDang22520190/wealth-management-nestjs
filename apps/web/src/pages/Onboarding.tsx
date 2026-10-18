import { useState } from 'react';
import type { FormEvent } from 'react';
import { api, describe, intentDone, intentKey } from '../api';
import { formatDateTime } from '../format';
import { Check } from 'lucide-react';
import { BusyButton, Choice, ErrorAlert, Fact, Facts, Field, Loading, PageTitle, Panel, choiceInput } from '../ui';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

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
    } catch (error) { setFailure({ validation: describe(error, { RATE_LIMITED: 'Bạn đã tạo quá nhiều lời mời trong một phút. Vui lòng thử lại sau.' }) }); }
    finally { setBusy(null); }
  };

  const steps = ['Tra cứu', 'Chọn tài khoản', 'Gửi lời mời'];
  const currentStep = invitation ? steps.length : account ? 2 : lookup ? 1 : 0;

  const message = (() => {
    if (!failure) return null;
    if (typeof failure === 'object' && 'validation' in failure) return String((failure as { validation: string }).validation);
    return describe(failure);
  })();

  return (
    <>
      <PageTitle title="Đăng ký khách hàng" hint="Tra cứu khách hàng từ hệ thống lõi, chọn tài khoản VND của chính khách hàng và gửi lời mời dịch vụ." />
      <ol className="m-0 mb-5 flex list-none p-0" aria-label="Tiến trình đăng ký">
        {steps.map((label, index) => {
          const done = index < currentStep;
          const current = index === currentStep;
          return (
            <li key={label} aria-current={current ? 'step' : undefined}
              className={cn('relative flex min-w-0 flex-1 items-center gap-2.5 font-medium text-muted-foreground max-[480px]:flex-col max-[480px]:items-start max-[480px]:gap-1.5 max-[480px]:text-[0.85rem]',
                'not-first:before:mr-0.5 not-first:before:block not-first:before:h-0.5 not-first:before:min-w-2.5 not-first:before:flex-[0_1_28px] max-[480px]:before:hidden',
                index <= currentStep ? 'not-first:before:bg-primary' : 'not-first:before:bg-input', current && 'font-semibold text-foreground', done && 'text-accent-foreground')}>
              <span aria-hidden="true" className={cn('grid size-7 flex-none place-items-center rounded-full border-[1.5px] border-input bg-card text-[0.82rem] font-bold text-muted-foreground',
                current && 'border-primary bg-primary text-primary-foreground ring-4 ring-accent', done && 'border-primary bg-accent text-accent-foreground')}>
                {done ? <Check className="size-4" strokeWidth={2.5} /> : index + 1}
              </span>
              <span className="min-w-0">{label}{done ? <span className="sr-only"> đã xong</span> : null}</span>
            </li>
          );
        })}
      </ol>
      <form className="mt-2 mb-3 flex flex-wrap items-end gap-x-3" onSubmit={event => void search(event)}>
        <Field label="Mã CIF hoặc định danh" htmlFor="cif" className="flex-[1_1_240px]">
          <Input id="cif" value={cif} onChange={event => setCif(event.target.value)} autoComplete="off" inputMode="text" />
        </Field>
        <BusyButton type="submit" busy={busy === 'lookup'} disabled={busy !== null} className="mb-3.5">Tra cứu</BusyButton>
      </form>
      {busy === 'lookup' ? <Loading label="Đang tra cứu…" /> : null}
      {message ? <ErrorAlert>{message}</ErrorAlert> : null}

      {lookup && !invitation ? (
        <Panel title="Thông tin khách hàng">
          <Facts>
            <Fact label="Họ tên">{lookup.name}</Fact>
            <Fact label="Mã CIF">{lookup.cifRef}</Fact>
            <Fact label="Ngày sinh">{lookup.dateOfBirth.split('-').reverse().join('/')}</Fact>
            <Fact label="Điều kiện đăng ký">{lookup.eligible ? <Badge variant="ok">Đủ điều kiện</Badge> : <Badge variant="bad">Chưa đủ điều kiện</Badge>}</Fact>
          </Facts>
          {lookup.eligible && lookup.accounts.length > 0 ? (
            <fieldset className="m-0 mb-4 min-w-0 border-0 p-0">
              <legend className="mb-2 p-0 font-semibold">Tài khoản VND của khách hàng</legend>
              {lookup.accounts.map(item => (
                <Choice key={item.id}>
                  <input type="radio" className={choiceInput} name="account" value={item.id} checked={account === item.id} onChange={() => setAccount(item.id)} />
                  <span>Tài khoản {item.currency} <code>{item.id}</code></span>
                </Choice>
              ))}
            </fieldset>
          ) : <p className="text-muted-foreground">Khách hàng chưa có tài khoản VND hợp lệ hoặc chưa đủ điều kiện nên chưa thể tạo lời mời.</p>}
          <BusyButton type="button" onClick={() => void create()} busy={busy === 'create'} disabled={!lookup.eligible || !account || busy !== null}>Tạo lời mời</BusyButton>
        </Panel>
      ) : null}

      {invitation ? (
        <Panel title="Lời mời đã gửi" tone="success">
          <p className="font-semibold text-ok">Đã tạo lời mời</p>
          <Facts>
            <Fact label="Trạng thái"><Badge variant="wait">Chờ khách hàng đồng ý</Badge></Fact>
            <Fact label="Hiệu lực đến">{formatDateTime(invitation.expiresAt)}</Fact>
            <Fact label="Phiên bản điều khoản">{invitation.termsVersion}</Fact>
          </Facts>
        </Panel>
      ) : null}
    </>
  );
}

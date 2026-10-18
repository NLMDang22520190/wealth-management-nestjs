import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FormEvent } from 'react';
import { ArrowLeftRight, Bell, ClipboardCheck, Mail, ShieldCheck, UserPlus, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api, describe, setToken } from './api';
import { Assignments } from './pages/Assignments';
import { CustomerDetail, CustomerList } from './pages/Customers';
import { Invitations } from './pages/Invitations';
import { Onboarding } from './pages/Onboarding';
import { RiskProfile } from './pages/RiskProfile';
import { RiskSurvey } from './pages/RiskSurvey';
import { ErrorAlert, useLoad } from './ui';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { cn } from '@/lib/utils';

type Role = 'RM' | 'LEADER' | 'CUSTOMER';
interface Session { actorId: string; role: Role; serial: number }

// Trusted demo actors seeded by `seed:demo`; the server remains the only authority on what each may do.
const demoActors = [
  { id: 'rm-alpha', label: 'rm-alpha (RM)' },
  { id: 'rm-beta', label: 'rm-beta (RM)' },
  { id: 'leader-alpha', label: 'leader-alpha (Trưởng nhóm)' },
  { id: 'customer-alpha', label: 'customer-alpha (Khách hàng)' },
  { id: 'customer-beta', label: 'customer-beta (Khách hàng)' },
];

// Starting points shown before a role is chosen; each card switches to that demo actor.
const roleCards = [
  { actorId: 'rm-alpha', title: 'Chuyên viên quan hệ khách hàng', body: 'Tra cứu khách trên hệ thống lõi, gửi lời mời dịch vụ và theo dõi danh mục khách đang phụ trách.' },
  { actorId: 'customer-alpha', title: 'Khách hàng', body: 'Đồng ý điều khoản, làm khảo sát khẩu vị rủi ro và xác nhận hồ sơ bằng mã OTP.' },
  { actorId: 'leader-alpha', title: 'Trưởng nhóm', body: 'Xem tải của từng chuyên viên và chuyển khách giữa các chuyên viên trong nhóm.' },
];

const icons: Record<string, LucideIcon> = {
  '#/onboarding': UserPlus,
  '#/rm/customers': Users,
  '#/invitations': Mail,
  '#/risk-survey': ClipboardCheck,
  '#/risk-profile': ShieldCheck,
  '#/assignments': ArrowLeftRight,
};

const navigation: Record<Role, Array<{ path: string; label: string }>> = {
  RM: [{ path: '#/onboarding', label: 'Đăng ký khách hàng' }, { path: '#/rm/customers', label: 'Khách phụ trách' }],
  CUSTOMER: [{ path: '#/invitations', label: 'Lời mời dịch vụ' }, { path: '#/risk-survey', label: 'Khảo sát rủi ro' },
    { path: '#/risk-profile', label: 'Hồ sơ rủi ro' }],
  LEADER: [{ path: '#/assignments', label: 'Phân công RM' }],
};

function useHash(): string {
  return useSyncExternalStore(
    notify => { window.addEventListener('hashchange', notify); return () => window.removeEventListener('hashchange', notify); },
    () => window.location.hash,
  );
}

function RoleSwitch({ session, choice, onChoice, busy, failure, onSubmit }: {
  session: Session | null; choice: string; onChoice: (actorId: string) => void; busy: boolean; failure: unknown; onSubmit: () => void;
}) {
  const submit = (event: FormEvent) => { event.preventDefault(); onSubmit(); };
  return (
    <form className="flex flex-col gap-1.5 rounded-lg bg-white/6 p-2.5" onSubmit={submit}>
      <label htmlFor="demo-role" className="text-[0.78rem] font-medium text-sidebar-foreground">Vai trò demo</label>
      <div className="flex flex-wrap gap-2 lg:flex-col">
        <NativeSelect id="demo-role" className="flex-[1_1_160px] lg:flex-none" value={choice} onChange={event => onChoice(event.target.value)}>
          {demoActors.map(actor => <NativeSelectOption key={actor.id} value={actor.id}>{actor.label}</NativeSelectOption>)}
        </NativeSelect>
        <Button type="submit" variant="outline" disabled={busy} className="flex-none border-white/45 bg-transparent whitespace-nowrap text-sidebar-foreground hover:border-white/80 hover:bg-white/10 hover:text-sidebar-foreground disabled:border-white/25 disabled:bg-transparent disabled:text-sidebar-foreground/70 lg:w-full">Chuyển vai</Button>
      </div>
      <p className="m-0 text-[0.8rem] text-[#f0d39a]" aria-live="polite">{session ? `Đang dùng vai: ${session.actorId}` : 'Chưa chọn vai'}</p>
      {failure ? <ErrorAlert>{describe(failure)}</ErrorAlert> : null}
    </form>
  );
}

interface Notification { id: string; kind: string; message: string; createdAt: string; readAt: string | null }

/** Unread leader reminders for the signed-in customer, shown above every screen until dismissed. */
function NotificationBanner({ onDismissed }: { onDismissed: () => void }) {
  const list = useLoad(signal => api<{ items: Notification[] }>('/notifications', { signal }), []);
  const [read, setRead] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const unread = (list.data?.items ?? []).filter(item => !item.readAt && !read.includes(item.id));
  if (unread.length === 0) return null;
  const markRead = async (id: string) => {
    setBusy(id); setFailure(null);
    try { await api(`/notifications/${id}/read`, { method: 'POST', body: {} }); setRead(previous => [...previous, id]); onDismissed(); }
    catch (error) { setFailure(error); }
    finally { setBusy(null); }
  };
  return (
    <section role="region" aria-label="Thông báo" className="mb-5 grid gap-2">
      {unread.map(item => (
        <div key={item.id} className="grid gap-2.5 rounded-xl border border-wait/30 bg-wait-soft px-4 py-3 text-wait">
          <div className="flex items-start gap-3">
            <Bell aria-hidden="true" className="mt-1 size-4 flex-none" />
            <p className="m-0 min-w-0 flex-1 font-semibold">Trưởng nhóm nhắc bạn hoàn thành khảo sát rủi ro (10 câu hỏi)</p>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pl-7">
            <a href="#/risk-survey" className="font-semibold underline underline-offset-4">Làm khảo sát</a>
            <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => void markRead(item.id)}>Đã xem</Button>
          </div>
        </div>
      ))}
      {failure ? <ErrorAlert>{describe(failure)}</ErrorAlert> : null}
    </section>
  );
}

function Screen({ session, hash }: { session: Session; hash: string }) {
  const route = hash.replace(/^#/, '') || '/';
  const detail = /^\/rm\/customers\/([^/]+)$/.exec(route);
  switch (session.role) {
    case 'RM':
      if (route === '/onboarding') return <Onboarding />;
      if (route === '/rm/customers') return <CustomerList />;
      if (detail) return <CustomerDetail customerId={detail[1]!} />;
      break;
    case 'CUSTOMER':
      if (route === '/invitations') return <Invitations />;
      if (route === '/risk-survey') return <RiskSurvey />;
      if (route === '/risk-profile') return <RiskProfile />;
      break;
    case 'LEADER':
      if (route === '/assignments') return <Assignments />;
      break;
  }
  const first = navigation[session.role][0]!;
  return (
    <section className="max-w-[920px]">
      <h2 className="mt-2 mb-2 text-[1.9rem] leading-tight font-bold lg:text-[2.2rem]">Chọn một mục để bắt đầu</h2>
      <p>Mục này không dành cho vai hiện tại. Dùng thanh điều hướng, hoặc mở <a href={first.path}>{first.label}</a>.</p>
    </section>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [choice, setChoice] = useState(demoActors[0]!.id);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const serial = useRef(0);
  const hash = useHash();
  const main = useRef<HTMLElement>(null);
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    main.current?.focus({ preventScroll: true });
  }, [hash]);

  const become = async (actorId: string) => {
    setChoice(actorId); setBusy(true); setFailure(null);
    try {
      const issued = await api<{ accessToken: string }>('/mock-auth/token', { body: { actorId }, auth: false });
      setToken(issued.accessToken);
      const me = await api<{ role: Role }>('/auth/me');
      serial.current += 1;
      setSession({ actorId, role: me.role, serial: serial.current });
      window.location.hash = navigation[me.role][0]!.path;
    } catch (error) { setFailure(error); } finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[264px_minmax(0,1fr)] lg:bg-[linear-gradient(to_right,var(--sidebar)_264px,var(--background)_264px)]">
      <header className="flex flex-col gap-3 bg-sidebar px-4 pt-3.5 pb-3 text-white lg:sticky lg:top-0 lg:h-screen lg:gap-[22px] lg:px-4 lg:py-[22px] [&_:focus-visible]:outline-[#ffd877]">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
          <svg className="size-[30px] flex-none text-gold" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="9" fill="currentColor" />
            <path d="M7 21c3-1 4-9 7-9s3 6 6 6 3-7 5-9" fill="none" stroke="#102a4c" strokeWidth="2.6" strokeLinecap="round" />
          </svg>
          <h1 className="m-0 text-[1.3rem] leading-tight font-bold">WealthFlow</h1>
          <span className="rounded-full bg-gold/15 px-2.5 py-0.5 text-xs font-medium text-[#f0d39a]">Môi trường demo</span>
        </div>
        {session ? (
          <nav aria-label="Điều hướng chính" className="lg:flex-1">
            <ul className="m-0 flex list-none flex-wrap gap-1 p-0 lg:flex-col">
              {navigation[session.role].map(item => {
                const Icon = icons[item.path]!;
                const current = hash === item.path || (item.path === '#/rm/customers' && hash.startsWith('#/rm/customers/'));
                return (
                  <li key={item.path} className="flex-none">
                    <a href={item.path} aria-current={current ? 'page' : undefined}
                      className={cn('flex items-center gap-2.5 rounded-lg px-3 py-2.5 font-medium whitespace-nowrap no-underline transition-colors',
                        current ? 'bg-white font-semibold text-sidebar' : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-white')}>
                      <Icon className={cn('size-5 flex-none', current && 'text-primary')} strokeWidth={1.8} aria-hidden="true" />{item.label}
                    </a>
                  </li>
                );
              })}
            </ul>
          </nav>
        ) : null}
        <RoleSwitch session={session} choice={choice} onChoice={setChoice} busy={busy} failure={failure} onSubmit={() => void become(choice)} />
      </header>
      <main ref={main} tabIndex={-1} className="mx-auto w-full max-w-[1080px] px-4 pt-6 pb-16 md:px-8 md:pt-8 md:pb-[72px] lg:m-0 lg:max-w-[1120px] lg:px-12 lg:pt-10 lg:pb-20">
        {session ? (
          <>
            {session.role === 'CUSTOMER' ? <NotificationBanner key={session.serial} onDismissed={() => main.current?.focus({ preventScroll: true })} /> : null}
            <Screen key={`${session.serial}:${hash.startsWith('#/rm/customers/') ? 'detail' : hash}`} session={session} hash={hash} />
          </>
        ) : (
            <section className="max-w-[920px]">
              <h2 className="mt-2 mb-2 text-[1.9rem] leading-tight font-bold lg:text-[2.2rem]">Chọn vai demo để bắt đầu</h2>
              <p className="mb-6 max-w-[60ch] text-muted-foreground">Đây là môi trường demo với dữ liệu tổng hợp. Chọn một vai bên dưới, hoặc dùng bộ chọn vai rồi bấm Chuyển vai.</p>
              <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(230px,1fr))] gap-3.5 p-0">
                {roleCards.map(card => (
                  <li key={card.actorId} className="flex">
                    <Card className="w-full gap-2 p-5 shadow-sm [--card-spacing:--spacing(0)]">
                      <h3 className="m-0 text-[1.05rem] font-semibold">{card.title}</h3>
                      <p className="m-0 mb-1.5 flex-1 text-muted-foreground">{card.body}</p>
                      <Button type="button" variant="outline" className="self-start" disabled={busy} onClick={() => void become(card.actorId)}>Dùng vai {card.actorId}</Button>
                    </Card>
                  </li>
                ))}
              </ul>
            </section>
          )}
      </main>
    </div>
  );
}

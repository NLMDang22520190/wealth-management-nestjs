import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { api, describe, setToken } from './api';
import { Assignments } from './pages/Assignments';
import { CustomerDetail, CustomerList } from './pages/Customers';
import { Invitations } from './pages/Invitations';
import { Onboarding } from './pages/Onboarding';
import { RiskProfile } from './pages/RiskProfile';
import { RiskSurvey } from './pages/RiskSurvey';
import { ErrorAlert } from './ui';

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

const icons: Record<string, ReactNode> = {
  '#/onboarding': <path d="M15 19a6 6 0 0 0-12 0M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm10-3v6m3-3h-6" />,
  '#/rm/customers': <path d="M17 20a5 5 0 0 0-10 0M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm7 8a4 4 0 0 0-3-3.9M17 4.1a4 4 0 0 1 0 7.8M5 20a4 4 0 0 1 3-3.9M7 4.1a4 4 0 0 0 0 7.8" />,
  '#/invitations': <path d="M4 6h16v12H4zM4 7l8 6 8-6" />,
  '#/risk-survey': <path d="M9 4h6v3H9zM7 5H5v16h14V5h-2M8 12l2 2 4-4M8 17h8" />,
  '#/risk-profile': <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Zm-3 9 2 2 4-4" />,
  '#/assignments': <path d="M7 7h12l-3-3M17 17H5l3 3M19 7v4M5 17v-4" />,
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

function Icon({ path }: { path: string }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {icons[path]}
    </svg>
  );
}

function RoleSwitch({ session, choice, onChoice, busy, failure, onSubmit }: {
  session: Session | null; choice: string; onChoice: (actorId: string) => void; busy: boolean; failure: unknown; onSubmit: () => void;
}) {
  const submit = (event: FormEvent) => { event.preventDefault(); onSubmit(); };
  return (
    <form className="role-switch" onSubmit={submit}>
      <label htmlFor="demo-role">Vai trò demo</label>
      <div className="role-row">
        <select id="demo-role" value={choice} onChange={event => onChoice(event.target.value)}>
          {demoActors.map(actor => <option key={actor.id} value={actor.id}>{actor.label}</option>)}
        </select>
        <button type="submit" disabled={busy}>Chuyển vai</button>
      </div>
      <p className="current-role" aria-live="polite">{session ? `Đang dùng vai: ${session.actorId}` : 'Chưa chọn vai'}</p>
      {failure ? <ErrorAlert>{describe(failure)}</ErrorAlert> : null}
    </form>
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
    <section className="welcome">
      <h2>Chọn một mục để bắt đầu</h2>
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
    <div className="app">
      <header className="masthead">
        <div className="masthead-row">
          <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="9" fill="currentColor" />
            <path d="M7 21c3-1 4-9 7-9s3 6 6 6 3-7 5-9" fill="none" stroke="#102a4c" strokeWidth="2.6" strokeLinecap="round" />
          </svg>
          <h1>WealthFlow</h1>
          <span className="demo-flag">Môi trường demo</span>
        </div>
        {session ? (
          <nav aria-label="Điều hướng chính">
            <ul>
              {navigation[session.role].map(item => (
                <li key={item.path}>
                  <a href={item.path} aria-current={hash === item.path || (item.path === '#/rm/customers' && hash.startsWith('#/rm/customers/')) ? 'page' : undefined}>
                    <Icon path={item.path} />{item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
        <RoleSwitch session={session} choice={choice} onChoice={setChoice} busy={busy} failure={failure} onSubmit={() => void become(choice)} />
      </header>
      <main ref={main} tabIndex={-1}>
        {session ? <Screen key={`${session.serial}:${hash.startsWith('#/rm/customers/') ? 'detail' : hash}`} session={session} hash={hash} />
          : (
            <section className="welcome">
              <h2>Chọn vai demo để bắt đầu</h2>
              <p className="hint">Đây là môi trường demo với dữ liệu tổng hợp. Chọn một vai bên dưới, hoặc dùng bộ chọn vai rồi bấm Chuyển vai.</p>
              <ul className="role-cards">
                {roleCards.map(card => (
                  <li key={card.actorId}>
                    <h3>{card.title}</h3>
                    <p>{card.body}</p>
                    <button type="button" className="secondary" disabled={busy} onClick={() => void become(card.actorId)}>Dùng vai {card.actorId}</button>
                  </li>
                ))}
              </ul>
            </section>
          )}
      </main>
    </div>
  );
}

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FormEvent } from 'react';
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

function RoleSwitch({ session, onSwitched }: { session: Session | null; onSwitched: (next: Session) => void }) {
  const [choice, setChoice] = useState(session?.actorId ?? demoActors[0]!.id);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const serial = useRef(0);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setFailure(null);
    try {
      const issued = await api<{ accessToken: string }>('/mock-auth/token', { body: { actorId: choice }, auth: false });
      setToken(issued.accessToken);
      const me = await api<{ role: Role }>('/auth/me');
      serial.current += 1;
      onSwitched({ actorId: choice, role: me.role, serial: serial.current });
    } catch (error) { setFailure(error); } finally { setBusy(false); }
  };

  return (
    <form className="role-switch" onSubmit={event => void submit(event)}>
      <label htmlFor="demo-role">Vai trò demo</label>
      <select id="demo-role" value={choice} onChange={event => setChoice(event.target.value)}>
        {demoActors.map(actor => <option key={actor.id} value={actor.id}>{actor.label}</option>)}
      </select>
      <button type="submit" disabled={busy}>Chuyển vai</button>
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
  const hash = useHash();
  const main = useRef<HTMLElement>(null);
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    main.current?.focus({ preventScroll: true });
  }, [hash]);

  const switched = (next: Session) => {
    setSession(next);
    window.location.hash = navigation[next.role][0]!.path;
  };

  return (
    <div className="app">
      <header className="masthead">
        <div className="masthead-row">
          <h1>WealthFlow</h1>
          <span className="demo-flag">Môi trường demo</span>
        </div>
        <RoleSwitch session={session} onSwitched={switched} />
        {session ? (
          <nav aria-label="Điều hướng chính">
            <ul>
              {navigation[session.role].map(item => (
                <li key={item.path}>
                  <a href={item.path} aria-current={hash === item.path || (item.path === '#/rm/customers' && hash.startsWith('#/rm/customers/')) ? 'page' : undefined}>{item.label}</a>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
      </header>
      <main ref={main} tabIndex={-1}>
        {session ? <Screen key={`${session.serial}:${hash.startsWith('#/rm/customers/') ? 'detail' : hash}`} session={session} hash={hash} />
          : (
            <section className="welcome">
              <h2>Chọn vai demo để bắt đầu</h2>
              <p>Đây là môi trường demo với dữ liệu tổng hợp. Chọn một vai ở phía trên rồi bấm Chuyển vai.</p>
            </section>
          )}
      </main>
    </div>
  );
}

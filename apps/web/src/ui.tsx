import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api, describe, isAbort } from './api';

export interface Loaded<T> { data: T | undefined; error: unknown; loading: boolean; reload: () => void }

/** Loads data for a screen. Previous data is dropped when a reload fails, so stale private data never stays visible. */
export function useLoad<T>(load: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[]): Loaded<T> {
  const [state, setState] = useState<{ data: T | undefined; error: unknown; loading: boolean }>({ data: undefined, error: undefined, loading: true });
  const [tick, setTick] = useState(0);
  const run = useCallback(load, deps);
  useEffect(() => {
    const controller = new AbortController();
    setState(previous => ({ ...previous, loading: true, error: undefined }));
    run(controller.signal).then(
      data => { if (!controller.signal.aborted) setState({ data, error: undefined, loading: false }); },
      (error: unknown) => { if (!isAbort(error) && !controller.signal.aborted) setState({ data: undefined, error, loading: false }); },
    );
    return () => controller.abort();
  }, [run, tick]);
  return { ...state, reload: () => setTick(value => value + 1) };
}

export function ErrorAlert({ children }: { children: ReactNode }) {
  return <div role="alert" className="alert">{children}</div>;
}

export function Loading({ label = 'Đang tải…' }: { label?: string }) {
  return <p role="status" className="loading"><span className="spinner" aria-hidden="true" />{label}</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function Panel({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  const id = `panel-${title.replace(/[^\p{L}\p{N}]+/gu, '-')}`;
  return (
    <section className={`panel ${className ?? ''}`} aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {children}
    </section>
  );
}

export function PageTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <header className="page-title">
      <h2>{title}</h2>
      {hint ? <p className="hint">{hint}</p> : null}
    </header>
  );
}

interface DemoCode { code: string; expiresAt: string }

/** Demo inbox: only opened by the user, then shows the code to type by hand; never fills the OTP field. */
export function OtpInbox({ challengeId }: { challengeId: string }) {
  const [opened, setOpened] = useState<DemoCode | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true); setFailure(null);
    try { setOpened(await api<DemoCode>(`/me/otp-challenges/${challengeId}/demo-code`)); }
    catch (error) { setFailure(error); }
    finally { setBusy(false); }
  };
  return (
    <div className="inbox-wrap">
      <button type="button" className="secondary" onClick={() => void open()} disabled={busy}>Xem hộp thư OTP demo</button>
      {failure ? <ErrorAlert>{describe(failure)}</ErrorAlert> : null}
      {opened ? (
        <section className="inbox" aria-labelledby={`inbox-${challengeId}`}>
          <h3 id={`inbox-${challengeId}`}>Hộp thư OTP demo</h3>
          <p>Mã xác thực của bạn là <strong className="otp-code">{opened.code}</strong>. Nhập mã này vào ô Mã OTP.</p>
        </section>
      ) : null}
    </div>
  );
}

export interface Allocation { cash: number; deposit: number; bond: number; fund: number }

const allocationRows: Array<[keyof Allocation, string]> = [['cash', 'Tiền mặt'], ['deposit', 'Tiền gửi'], ['bond', 'Trái phiếu'], ['fund', 'Chứng chỉ quỹ']];

/** Server-owned risk result details: maximum product risk and the target asset allocation. */
export function AllocationSummary({ maxProductRisk, allocation }: { maxProductRisk: number; allocation: Allocation }) {
  return (
    <>
      <p>Rủi ro sản phẩm tối đa: {maxProductRisk}</p>
      <ul className="allocation" aria-label="Phân bổ tài sản">
        {allocationRows.map(([key, label]) => <li key={key}><span>{label}</span><strong>{allocation[key]}%</strong></li>)}
      </ul>
    </>
  );
}

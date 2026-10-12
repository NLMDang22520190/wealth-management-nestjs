import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClipboardEvent, KeyboardEvent, ReactNode } from 'react';
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

const OTP_LENGTH = 6;
const RESEND_SECONDS = 30;

/** Six single-digit boxes. Owns its digits: remount it (change `key`) to clear it. Reports the digits typed so far; six means complete. */
export function OtpCodeInput({ onChange, disabled }: { onChange: (code: string) => void; disabled?: boolean }) {
  const [digits, setDigits] = useState<string[]>(() => Array.from({ length: OTP_LENGTH }, () => ''));
  const boxes = useRef<Array<HTMLInputElement | null>>([]);
  const update = (next: string[]) => { setDigits(next); onChange(next.join('')); };
  const focusBox = (position: number) => boxes.current[Math.max(0, Math.min(OTP_LENGTH - 1, position))]?.focus();

  const type = (position: number, raw: string) => {
    const typed = raw.replace(/\D/g, '');
    const next = [...digits];
    next[position] = typed.slice(-1);
    update(next);
    if (typed && position < OTP_LENGTH - 1) focusBox(position + 1);
  };
  const press = (position: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace' && digits[position] === '' && position > 0) { event.preventDefault(); focusBox(position - 1); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); focusBox(position - 1); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); focusBox(position + 1); }
  };
  const paste = (position: number, event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData('text') || event.clipboardData.getData('text/plain');
    const pasted = text.replace(/\D/g, '');
    if (!pasted) return;
    event.preventDefault();
    const next = [...digits];
    const start = pasted.length >= OTP_LENGTH ? 0 : position;
    [...pasted.slice(0, OTP_LENGTH - start)].forEach((digit, offset) => { next[start + offset] = digit; });
    update(next);
    focusBox(Math.min(start + pasted.length, OTP_LENGTH) - 1);
  };

  return (
    <div role="group" aria-label="Mã OTP" className="otp-boxes">
      {digits.map((digit, position) => (
        <input key={position} ref={element => { boxes.current[position] = element; }} className="otp-box" aria-label={`Chữ số ${position + 1}`}
          value={digit} maxLength={1} inputMode="numeric" autoComplete={position === 0 ? 'one-time-code' : 'off'} disabled={disabled}
          onChange={event => type(position, event.target.value)} onKeyDown={event => press(position, event)}
          onPaste={event => paste(position, event)} onFocus={event => event.target.select()} />
      ))}
    </div>
  );
}

/** Countdown, then a button to request a fresh code. Remount (change `key`) when a new challenge is issued. */
export function ResendCode({ onResend, busy }: { onResend: () => void; busy: boolean }) {
  const [left, setLeft] = useState(RESEND_SECONDS);
  useEffect(() => {
    if (left <= 0) return undefined;
    const timer = setTimeout(() => setLeft(value => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [left]);
  return left > 0
    ? <p className="hint resend">Gửi lại mã sau {left}s</p>
    : <button type="button" className="secondary resend" onClick={onResend} disabled={busy}>Gửi lại mã</button>;
}

export interface Allocation { cash: number; deposit: number; bond: number; fund: number }

const allocationRows: Array<[keyof Allocation, string]> = [['cash', 'Tiền mặt'], ['deposit', 'Tiền gửi'], ['bond', 'Trái phiếu'], ['fund', 'Chứng chỉ quỹ']];

/** Server-owned risk result details: maximum product risk and the target asset allocation. */
export function AllocationSummary({ maxProductRisk, allocation }: { maxProductRisk: number; allocation: Allocation }) {
  return (
    <>
      <p className="max-risk">Rủi ro sản phẩm tối đa: {maxProductRisk}</p>
      <div className="allocation-bar" aria-hidden="true">
        {allocationRows.map(([key]) => <span key={key} className={`seg-${key}`} style={{ width: `${allocation[key]}%` }} />)}
      </div>
      <ul className="allocation" aria-label="Phân bổ tài sản">
        {allocationRows.map(([key, label]) => <li key={key}><span><i className={`dot seg-${key}`} aria-hidden="true" />{label}</span><strong>{allocation[key]}%</strong></li>)}
      </ul>
    </>
  );
}

/** Risk category as a colour-coded chip; the visible text stays the plain Vietnamese label. */
export function RiskChip({ category, label }: { category: string; label: string }) {
  return <span className={`chip risk-${category.toLowerCase()}`}>{label}</span>;
}

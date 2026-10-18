import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClipboardEvent, ComponentProps, KeyboardEvent, ReactNode } from 'react';
import { CircleAlert, Loader2 } from 'lucide-react';
import { api, describe, isAbort } from './api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

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
  return (
    <Alert variant="destructive" role="alert" className="my-2.5 border-destructive/30 bg-destructive/10">
      <CircleAlert aria-hidden="true" />
      <AlertDescription className="font-medium text-destructive">{children}</AlertDescription>
    </Alert>
  );
}

/** Inline action inside an ErrorAlert (retry, reload): a link-styled button. */
export function AlertAction({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return <Button type="button" variant="link" className="p-0 font-semibold text-destructive" onClick={onClick}>{children}</Button>;
}

export function Loading({ label = 'Đang tải…', skeleton = false }: { label?: string; skeleton?: boolean }) {
  return (
    <div role="status" className="my-2 text-muted-foreground">
      <p className="m-0 flex items-center gap-2.5"><Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />{label}</p>
      {skeleton ? <Skeleton aria-hidden="true" className="mt-3 h-24 w-full rounded-xl" /> : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-input bg-muted px-4 py-7 text-center text-muted-foreground">{children}</p>;
}

const tones = {
  plain: { card: '', title: 'text-muted-foreground' },
  success: { card: 'bg-[#f5fbf7] ring-[#a9d6bd]', title: 'text-muted-foreground' },
  preview: { card: 'ring-2 ring-primary shadow-lg shadow-primary/10', title: 'text-muted-foreground' },
  aum: { card: 'bg-linear-to-br from-sidebar to-sidebar-accent text-white ring-sidebar [&_p]:text-sidebar-foreground', title: 'text-sidebar-foreground' },
} as const;

export function Panel({ title, children, tone = 'plain' }: { title: string; children: ReactNode; tone?: keyof typeof tones }) {
  const id = `panel-${title.replace(/[^\p{L}\p{N}]+/gu, '-')}`;
  return (
    <Card role="region" aria-labelledby={id} className={cn('my-4 [--card-spacing:--spacing(5)] shadow-sm', tones[tone].card)}>
      <CardHeader><CardTitle id={id} className={tones[tone].title}>{title}</CardTitle></CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function PageTitle({ title, hint, actions }: { title: string; hint?: string; actions?: ReactNode }) {
  return (
    <header className="mb-5 flex items-center justify-between gap-x-4">
      <div className="min-w-0">
        <h2 className="m-0 mb-1.5 text-[1.65rem] leading-tight font-bold">{title}</h2>
        {hint ? <p className="m-0 max-w-[64ch] text-muted-foreground">{hint}</p> : null}
      </div>
      {actions ? <div className="flex flex-none flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-3">{actions}</div> : null}
    </header>
  );
}

/** Label + control stack used by every form. */
export function Field({ label, htmlFor, children, className }: { label: string; htmlFor: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('mb-3.5 flex min-w-0 flex-col gap-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

/** A whole-row choice around a native radio/checkbox, so keyboard and screen readers behave natively. */
export function Choice({ children }: { children: ReactNode }) {
  return (
    <label className="mb-2 flex scroll-mt-24 cursor-pointer items-start gap-3 rounded-lg border bg-card px-3.5 py-3 transition-colors hover:border-input has-checked:border-primary has-checked:bg-accent has-checked:ring-1 has-checked:ring-primary has-focus-visible:ring-3 has-focus-visible:ring-ring/50">
      {children}
    </label>
  );
}
export const choiceInput = 'mt-1 size-[18px] flex-none accent-primary';

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
    <div>
      <Button type="button" variant="outline" onClick={() => void open()} disabled={busy}>Xem hộp thư OTP demo</Button>
      {failure ? <ErrorAlert>{describe(failure)}</ErrorAlert> : null}
      {opened ? (
        <section className="my-2.5 mb-3.5 rounded-lg border border-[#efd9a3] bg-wait-soft px-4 py-3" aria-labelledby={`inbox-${challengeId}`}>
          <h3 id={`inbox-${challengeId}`} className="m-0 mb-1 text-[0.9rem] font-semibold text-wait">Hộp thư OTP demo</h3>
          <p className="m-0">Mã xác thực của bạn là <strong className="font-mono text-[1.35rem] leading-tight font-bold tracking-[0.18em] tabular-nums">{opened.code}</strong>. Nhập mã này vào ô Mã OTP.</p>
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
    if (typed.length > 1) { spread(position, typed); return; }
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
  const spread = (position: number, pasted: string) => {
    const next = [...digits];
    const start = pasted.length >= OTP_LENGTH ? 0 : position;
    Array.from(pasted.slice(0, OTP_LENGTH - start)).forEach((digit, offset) => { next[start + offset] = digit; });
    update(next);
    focusBox(Math.min(start + pasted.length, OTP_LENGTH) - 1);
  };
  const paste = (position: number, event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData('text') || event.clipboardData.getData('text/plain');
    const pasted = text.replace(/\D/g, '');
    if (!pasted) return;
    event.preventDefault();
    spread(position, pasted);
  };

  return (
    <div role="group" aria-label="Mã OTP" className="mt-1 mb-3 flex gap-1.5 sm:gap-2">
      {digits.map((digit, position) => (
        <Input key={position} ref={element => { boxes.current[position] = element; }} aria-label={`Chữ số ${position + 1}`}
          className="h-[52px] min-w-0 flex-1 p-0 text-center text-[1.45rem] leading-none font-bold tabular-nums sm:h-14 sm:w-12 sm:flex-[0_1_48px] md:text-[1.45rem]"
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
    ? <p className="mb-3.5 text-muted-foreground">Gửi lại mã sau {left}s</p>
    : <Button type="button" variant="outline" size="sm" className="mb-3.5" onClick={onResend} disabled={busy}>Gửi lại mã</Button>;
}

export interface Allocation { cash: number; deposit: number; bond: number; fund: number }

const allocationRows: Array<[keyof Allocation, string]> = [['cash', 'Tiền mặt'], ['deposit', 'Tiền gửi'], ['bond', 'Trái phiếu'], ['fund', 'Chứng chỉ quỹ']];
const segment: Record<keyof Allocation, string> = { cash: 'bg-slate-400', deposit: 'bg-risk-conservative', bond: 'bg-risk-balanced', fund: 'bg-risk-growth' };

/** Server-owned risk result details: maximum product risk and the target asset allocation. */
export function AllocationSummary({ maxProductRisk, allocation }: { maxProductRisk: number; allocation: Allocation }) {
  return (
    <>
      <p className="mb-2 flex items-baseline text-[0.9rem] font-medium text-muted-foreground">
        <span>Rủi ro sản phẩm tối đa: </span>
        <strong data-testid="risk-max-product" className="ml-1.5 text-[1.6rem] leading-none font-bold text-foreground tabular-nums">{maxProductRisk}</strong>
      </p>
      <div data-testid="allocation-bar" className="my-1.5 mb-3 flex h-3 gap-0.5 overflow-hidden rounded-full bg-card" aria-hidden="true">
        {allocationRows.map(([key]) => <span key={key} className={cn('block h-full', segment[key])} style={{ width: `${allocation[key]}%` }} />)}
      </div>
      <ul className="m-0 mb-2.5 grid list-none grid-cols-1 gap-x-3 gap-y-2 p-0 sm:grid-cols-2" aria-label="Phân bổ tài sản">
        {allocationRows.map(([key, label]) => (
          <li key={key} className="flex items-center justify-between gap-2 rounded-lg border bg-muted px-3 py-2">
            <span className="whitespace-nowrap"><i data-testid="allocation-swatch" className={cn('mr-2 inline-block size-[9px] rounded-full align-middle', segment[key])} aria-hidden="true" />{label}</span>
            <strong className="whitespace-nowrap">{allocation[key]}%</strong>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Risk category as a colour-coded badge; the visible text stays the plain Vietnamese label. */
export function RiskChip({ category, label, testId }: { category: string; label: string; testId?: string }) {
  const variant = category.toLowerCase();
  return <Badge data-testid={testId} variant={variant === 'conservative' || variant === 'balanced' || variant === 'growth' ? variant : 'secondary'}>{label}</Badge>;
}

/** Term/value grid used for key facts on panels. */
export function Facts({ children }: { children: ReactNode }) {
  return <dl className="m-0 mb-4 grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-3.5">{children}</dl>;
}
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="min-w-0"><dt className="mb-0.5 text-[0.8rem] text-muted-foreground">{label}</dt><dd className="m-0 font-semibold">{children}</dd></div>;
}

/** Submit/action button that shows a spinner and "Đang gửi…" while its request is in flight; disabled meanwhile. */
export function BusyButton({ busy, disabled, children, ...props }: ComponentProps<typeof Button> & { busy: boolean }) {
  return (
    <Button {...props} disabled={disabled || busy} aria-busy={busy || undefined}>
      {busy ? <><Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" data-icon="inline-start" />Đang gửi…</> : children}
    </Button>
  );
}

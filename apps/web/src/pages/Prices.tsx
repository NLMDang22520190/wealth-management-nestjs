import { useId, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { api, ApiFailure, describe, intentDone, intentKey } from '../api';
import { formatDate } from '../format';
import { AlertAction, BusyButton, Empty, ErrorAlert, Fact, Facts, Field, Loading, PageTitle, Panel, invalidProps, useLoad } from '../ui';
import { assetClassLabels } from './Products';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';

export interface PendingPrice { pricingId: string; assetCode: string; assetName: string; priceType: string; previousValue: string | null; value: string; changePct: string | null; effectiveDate: string; makerCode: string }
interface ScanSummary { scanned: number; alerted: number; failed: number }
interface PriceResult { assetCode: string; priceType: string; previousValue: string | null; value: string; changePct: string | null; effectiveDate: string; status: string; scan: ScanSummary | null }
interface ImportResult { rows: Array<{ line: number; assetCode: string; status: string; code: string | null }>; scan: ScanSummary | null }
interface SnapshotRun { asOf: string; snapshots: number; skipped: number; failed: number; alerted: number }
interface AssetOption { assetId: string; assetCode: string; assetName: string; assetClass: string }

export const priceTypeLabels: Record<string, string> = { NAV: 'NAV', BOND_PRICE: 'Giá tham chiếu', INTEREST_RATE: 'Lãi suất (%/năm)' };
export const plainNumber = (value: string) => {
  const [whole = '', fraction = ''] = value.split('.');
  const kept = fraction.replace(/0+$/, '');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (kept ? `,${kept}` : '');
};
export const dayText = (date: string) => formatDate(`${date}T12:00:00+07:00`);
const scanText = (scan: ScanSummary) => `Quét lệch: ${scan.scanned} khách, ${scan.alerted} khách có cảnh báo mới, ${scan.failed} lỗi.`;
const rowStatus: Record<string, string> = { APPLIED: 'Đã áp dụng', PENDING_APPROVAL: 'Chờ duyệt', ERROR: 'Lỗi' };

function EnterPrice({ onEntered }: { onEntered: () => void }) {
  const assetId = useId();
  const valueId = useId();
  const dateId = useId();
  const assets = useLoad(signal => api<{ items: AssetOption[] }>('/back-office/assets?pageSize=100', { signal }), []);
  const [asset, setAsset] = useState('');
  const [value, setValue] = useState('');
  const [date, setDate] = useState('');
  const [errors, setErrors] = useState<{ asset?: string; value?: string }>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PriceResult | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(null);
    const next = { ...(asset ? {} : { asset: 'Chọn sản phẩm.' }), ...(value.trim() ? {} : { value: 'Nhập giá trị mới.' }) };
    setErrors(next);
    if (next.asset) { document.getElementById(assetId)?.focus(); return; }
    if (next.value) { document.getElementById(valueId)?.focus(); return; }
    const body = { assetId: asset, value: value.trim().replace(',', '.'), ...(date ? { effectiveDate: date } : {}) };
    const name = 'price-enter';
    setBusy(true); setResult(null);
    try {
      const entered = await api<PriceResult>('/back-office/prices', { key: intentKey(name, JSON.stringify(body)), body });
      intentDone(name);
      setResult(entered);
      setValue('');
      onEntered();
    } catch (error) { setFailure(error); } finally { setBusy(false); }
  };

  return (
    <>
      <Panel title="Nhập giá mới">
        <form onSubmit={event => void submit(event)} noValidate>
          <div className="grid gap-x-4 md:grid-cols-2">
            <Field label="Sản phẩm" htmlFor={assetId} error={errors.asset} className="md:col-span-2">
              <NativeSelect id={assetId} className="w-full" value={asset} onChange={event => setAsset(event.target.value)} {...invalidProps(`${assetId}-error`, errors.asset)}>
                <NativeSelectOption value="">Chọn sản phẩm</NativeSelectOption>
                {(assets.data?.items ?? []).map(item => <NativeSelectOption key={item.assetId} value={item.assetId}>{item.assetCode} · {assetClassLabels[item.assetClass]}</NativeSelectOption>)}
              </NativeSelect>
            </Field>
            <Field label="Giá trị mới" htmlFor={valueId} error={errors.value}>
              <Input id={valueId} inputMode="decimal" autoComplete="off" value={value} onChange={event => setValue(event.target.value)} {...invalidProps(`${valueId}-error`, errors.value)} />
            </Field>
            <Field label="Ngày hiệu lực" htmlFor={dateId}><Input id={dateId} type="date" value={date} onChange={event => setDate(event.target.value)} /></Field>
          </div>
          {assets.error ? <ErrorAlert>{describe(assets.error)}</ErrorAlert> : null}
          {failure ? <ErrorAlert>{describe(failure)}</ErrorAlert> : null}
          <BusyButton type="submit" busy={busy}>Lưu giá</BusyButton>
        </form>
      </Panel>
      {result ? (
        <Panel title="Kết quả nhập giá" focusOnMount>
          <p className="font-semibold">{result.status === 'APPLIED' ? 'Giá mới đã có hiệu lực' : 'Biến động trên 20%: giá đang chờ Quản lý duyệt, chưa được dùng để định giá'}</p>
          <Facts>
            <Fact label="Sản phẩm">{result.assetCode}</Fact>
            <Fact label="Loại giá">{priceTypeLabels[result.priceType]}</Fact>
            <Fact label="Giá cũ">{result.previousValue ? plainNumber(result.previousValue) : 'Chưa có'}</Fact>
            <Fact label="Giá mới">{plainNumber(result.value)}</Fact>
            <Fact label="Thay đổi">{result.changePct ? `${plainNumber(result.changePct)}%` : 'Không áp dụng'}</Fact>
          </Facts>
          {result.scan ? <p className="m-0">{scanText(result.scan)}</p> : null}
        </Panel>
      ) : null}
    </>
  );
}

function ImportCsv({ onImported }: { onImported: () => void }) {
  const fileId = useId();
  const textId = useId();
  const [csv, setCsv] = useState('assetCode,value,effectiveDate\n');
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) setCsv(await file.text());
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const name = 'price-import';
    setBusy(true); setFailure(null); setResult(null);
    try {
      const imported = await api<ImportResult>('/back-office/prices/import', { key: intentKey(name, csv), body: { csv } });
      intentDone(name);
      setResult(imported);
      onImported();
    } catch (error) { setFailure(error); } finally { setBusy(false); }
  };
  return (
    <Panel title="Nhập giá từ CSV">
      <form onSubmit={event => void submit(event)} noValidate>
        <Field label="Chọn tệp CSV" htmlFor={fileId}><Input id={fileId} type="file" accept=".csv,text/csv" onChange={event => void pick(event)} /></Field>
        <Field label="Nội dung CSV" htmlFor={textId}><Textarea id={textId} rows={5} className="font-mono" value={csv} onChange={event => setCsv(event.target.value)} /></Field>
        {failure ? <ErrorAlert>{describe(failure, { '400': 'Tệp phải có dòng đầu assetCode,value,effectiveDate và tối đa 500 dòng.' })}</ErrorAlert> : null}
        <BusyButton type="submit" busy={busy}>Nhập từ CSV</BusyButton>
      </form>
      {result ? (
        <div role="status" className="mt-3">
          <ul className="m-0 grid list-none gap-1 p-0">
            {result.rows.map(row => <li key={row.line} className="break-words">Dòng {row.line}, {row.assetCode || 'không có mã'}: {rowStatus[row.status]}{row.code ? ` (${describe(new ApiFailure(0, row.code, ''))})` : ''}</li>)}
          </ul>
          {result.scan ? <p className="m-0 mt-1">{scanText(result.scan)}</p> : null}
        </div>
      ) : null}
    </Panel>
  );
}

/** UC-10 for the clerk. The demo button stands in for the 17:00 schedule; the server answers 404 when mocks are off. */
export function Prices() {
  const dateId = useId();
  const [version, setVersion] = useState(0);
  const pending = useLoad(signal => api<{ items: PendingPrice[] }>('/back-office/prices/pending', { signal }), [version]);
  const [asOf, setAsOf] = useState('');
  const [jobText, setJobText] = useState('');
  const [jobFailure, setJobFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => setVersion(value => value + 1);
  const snapshot = async () => {
    setBusy(true); setJobFailure(null);
    try {
      const run = await api<SnapshotRun>('/demo/jobs/portfolio-snapshot', { body: asOf ? { asOf } : {} });
      setJobText(`Chụp danh mục ngày ${dayText(run.asOf)}: ${run.snapshots} khách, bỏ qua ${run.skipped}, lỗi ${run.failed}, có cảnh báo mới ${run.alerted}.`);
    } catch (error) { setJobFailure(error); } finally { setBusy(false); }
  };
  return (
    <>
      <PageTitle title="Giá và NAV" hint="Nhập giá hoặc lãi suất mới. Biến động trên 20% phải được Quản lý duyệt trước khi áp dụng." />
      <EnterPrice onEntered={refresh} />
      <ImportCsv onImported={refresh} />
      <Panel title="Giá đang chờ duyệt">
        {pending.loading && !pending.data ? <Loading /> : null}
        {pending.error ? <ErrorAlert>{describe(pending.error)} <AlertAction onClick={pending.reload}>Thử lại</AlertAction></ErrorAlert> : null}
        {pending.data && pending.data.items.length === 0 ? <Empty>Không có giá nào đang chờ duyệt.</Empty> : null}
        {pending.data && pending.data.items.length > 0 ? (
          <ul className="m-0 grid list-none gap-1.5 p-0">
            {pending.data.items.map(item => <li key={item.pricingId} className="break-words">{item.assetCode}: {item.previousValue ? plainNumber(item.previousValue) : 'chưa có'} → {plainNumber(item.value)}{item.changePct ? ` (${plainNumber(item.changePct)}%)` : ''}</li>)}
          </ul>
        ) : null}
      </Panel>
      <Panel title="Chụp danh mục (demo)">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Ngày chụp" htmlFor={dateId} className="mb-0 flex-[1_1_180px]"><Input id={dateId} type="date" value={asOf} onChange={event => setAsOf(event.target.value)} /></Field>
          <Button type="button" variant="outline" disabled={busy} onClick={() => void snapshot()}>Chạy chụp danh mục</Button>
        </div>
        <p role="status" data-testid="snapshot-result" className="m-0 mt-3 min-h-6">{jobText}</p>
        {jobFailure ? <ErrorAlert>{describe(jobFailure)}</ErrorAlert> : null}
      </Panel>
    </>
  );
}

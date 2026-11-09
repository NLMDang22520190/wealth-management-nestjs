import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { api, describe, intentDone, intentKey } from '../api';
import { AlertAction, BusyButton, Empty, ErrorAlert, Field, Loading, PageTitle, Panel, invalidProps, useLoad } from '../ui';
import { money } from './Cash';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';

interface Asset { assetId: string; assetCode: string; assetName: string; assetClass: string; riskLevel: number; minInvestment: string; status: string }
type AssetClass = 'TERM_DEPOSIT' | 'BOND' | 'MUTUAL_FUND';

export const assetClassLabels: Record<string, string> = { TERM_DEPOSIT: 'Tiền gửi có kỳ hạn', BOND: 'Trái phiếu', MUTUAL_FUND: 'Chứng chỉ quỹ' };
const fundTypes: Record<string, string> = { MONEY_MARKET: 'Thị trường tiền tệ', BOND: 'Trái phiếu', BALANCED: 'Cân bằng', EQUITY: 'Cổ phiếu' };
const LEVELS = [1, 2, 3, 4, 5];

const classFields: Record<AssetClass, Array<{ name: string; label: string; type?: string; required: boolean }>> = {
  TERM_DEPOSIT: [{ name: 'termMonths', label: 'Kỳ hạn (tháng)', required: true }, { name: 'interestRate', label: 'Lãi suất (%/năm)', required: true }],
  BOND: [{ name: 'faceValue', label: 'Mệnh giá (VND)', required: true }, { name: 'couponRate', label: 'Lãi suất coupon (%/năm)', required: true },
    { name: 'maturityDate', label: 'Ngày đáo hạn', type: 'date', required: true }, { name: 'issuer', label: 'Tổ chức phát hành', required: true }, { name: 'initialPrice', label: 'Giá tham chiếu ban đầu (VND)', required: false }],
  MUTUAL_FUND: [{ name: 'fundManager', label: 'Công ty quản lý quỹ', required: true }, { name: 'initialPrice', label: 'NAV ban đầu (VND)', required: false }],
};

function CreateForm({ onCreated }: { onCreated: (asset: Asset) => void }) {
  const base = useId();
  const [assetClass, setAssetClass] = useState<AssetClass>('MUTUAL_FUND');
  const [values, setValues] = useState<Record<string, string>>({ riskLevel: '3', fundType: 'BALANCED' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const id = (name: string) => `${base}-${name}`;
  const set = (name: string, value: string) => setValues(previous => ({ ...previous, [name]: value }));
  const text = (name: string, label: string, type = 'text', hint?: string) => (
    <Field key={name} label={label} htmlFor={id(name)} error={errors[name]}>
      <Input id={id(name)} type={type} autoComplete="off" inputMode={hint === 'number' ? 'decimal' : undefined} value={values[name] ?? ''} onChange={event => set(name, event.target.value)} {...invalidProps(`${id(name)}-error`, errors[name])} />
    </Field>
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(null);
    const required = [{ name: 'assetCode', label: 'mã sản phẩm' }, { name: 'assetName', label: 'tên sản phẩm' }, ...classFields[assetClass].filter(field => field.required).map(field => ({ name: field.name, label: field.label.toLowerCase() }))];
    const missing: Record<string, string> = {};
    for (const field of required) if (!values[field.name]?.trim()) missing[field.name] = `Nhập ${field.label}.`;
    setErrors(missing);
    const first = required.find(field => missing[field.name]);
    if (first) { document.getElementById(id(first.name))?.focus(); return; }

    const specific = Object.fromEntries(classFields[assetClass].filter(field => values[field.name]?.trim()).map(field => [field.name, field.name === 'termMonths' ? Number(values[field.name]) : values[field.name]!.trim()]));
    const body = { assetClass, assetCode: values.assetCode!.trim(), assetName: values.assetName!.trim(), riskLevel: Number(values.riskLevel), ...(values.minInvestment?.trim() ? { minInvestment: values.minInvestment.trim() } : {}),
      ...specific, ...(assetClass === 'MUTUAL_FUND' ? { fundType: values.fundType } : {}) };
    const name = 'asset-create';
    setBusy(true);
    try {
      const created = await api<Asset>('/back-office/assets', { key: intentKey(name, JSON.stringify(body)), body });
      intentDone(name);
      setValues({ riskLevel: '3', fundType: 'BALANCED' });
      onCreated(created);
    } catch (error) { setFailure(error); } finally { setBusy(false); }
  };

  return (
    <Panel title="Thêm sản phẩm">
      <form onSubmit={event => void submit(event)} noValidate>
        <div className="grid gap-x-4 md:grid-cols-2">
          <Field label="Loại sản phẩm" htmlFor={id('class')}>
            <NativeSelect id={id('class')} className="w-full" value={assetClass} onChange={event => { setAssetClass(event.target.value as AssetClass); setErrors({}); }}>
              {Object.entries(assetClassLabels).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}
            </NativeSelect>
          </Field>
          <Field label="Mức rủi ro" htmlFor={id('risk')}>
            <NativeSelect id={id('risk')} className="w-full" value={values.riskLevel} onChange={event => set('riskLevel', event.target.value)}>
              {LEVELS.map(level => <NativeSelectOption key={level} value={String(level)}>Mức {level}</NativeSelectOption>)}
            </NativeSelect>
          </Field>
          {text('assetCode', 'Mã sản phẩm')}
          {text('assetName', 'Tên sản phẩm')}
          {text('minInvestment', 'Đầu tư tối thiểu (VND)', 'text', 'number')}
          {assetClass === 'MUTUAL_FUND' ? (
            <Field label="Loại quỹ" htmlFor={id('fundType')}>
              <NativeSelect id={id('fundType')} className="w-full" value={values.fundType} onChange={event => set('fundType', event.target.value)}>
                {Object.entries(fundTypes).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}
              </NativeSelect>
            </Field>
          ) : null}
          {classFields[assetClass].map(field => text(field.name, field.label, field.type))}
        </div>
        {failure ? <ErrorAlert>{describe(failure)}</ErrorAlert> : null}
        <BusyButton type="submit" busy={busy}>Thêm sản phẩm</BusyButton>
      </form>
    </Panel>
  );
}

function AssetRow({ asset, onChanged }: { asset: Asset; onChanged: () => void }) {
  const riskId = useId();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const change = async (path: string, body: unknown) => {
    setBusy(true); setFailure(null);
    const name = `asset-${path}-${asset.assetId}`;
    try {
      await api(`/back-office/assets/${asset.assetId}/${path}`, { method: 'PATCH', key: intentKey(name, JSON.stringify(body)), body });
      intentDone(name);
      onChanged();
    } catch (error) { setFailure(error); } finally { setBusy(false); }
  };
  const onSale = asset.status === 'ON_SALE';
  return (
    <li className="rounded-lg border bg-card px-3.5 py-3">
      <p className="m-0 flex flex-wrap items-center gap-x-2 font-semibold break-words">{asset.assetName} <span className="font-normal text-muted-foreground">({asset.assetCode})</span>
        {onSale ? <Badge variant="ok">Đang bán</Badge> : <Badge variant="outline">Ngừng bán</Badge>}</p>
      <p className="m-0 mb-2 text-[0.92rem] text-muted-foreground">{assetClassLabels[asset.assetClass]} · tối thiểu {money(asset.minInvestment)}</p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={`Mức rủi ro của ${asset.assetCode}`} htmlFor={riskId} className="mb-0 flex-[0_1_200px]">
          <NativeSelect id={riskId} className="w-full" disabled={busy} value={String(asset.riskLevel)} onChange={event => void change('risk-level', { riskLevel: Number(event.target.value) })}>
            {LEVELS.map(level => <NativeSelectOption key={level} value={String(level)}>Mức {level}</NativeSelectOption>)}
          </NativeSelect>
        </Field>
        <Button type="button" variant="outline" disabled={busy} aria-label={`${onSale ? 'Ngừng bán' : 'Bán lại'} ${asset.assetCode}`} onClick={() => void change('status', { status: onSale ? 'DISCONTINUED' : 'ON_SALE' })}>{onSale ? 'Ngừng bán' : 'Bán lại'}</Button>
      </div>
      {failure ? <ErrorAlert>{describe(failure)}</ErrorAlert> : null}
    </li>
  );
}

/** UC-09. */
export function Products() {
  const searchId = useId();
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState('');
  const list = useLoad(signal => api<{ items: Asset[]; total: number; pageSize: number }>(`/back-office/assets?page=${page}&q=${encodeURIComponent(query)}`, { signal }), [query, page]);
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;
  return (
    <>
      <PageTitle title="Danh mục sản phẩm" hint="Khai báo sản phẩm, xếp mức rủi ro từ 1 đến 5 và ngừng bán khi cần." />
      <CreateForm onCreated={asset => { setNotice(`Đã thêm sản phẩm ${asset.assetCode}.`); setQuery(''); setDraft(''); setPage(1); list.reload(); }} />
      <p role="status" className="m-0 min-h-6">{notice}</p>
      <Panel title="Sản phẩm hiện có">
        <form className="mb-3 flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); setPage(1); setQuery(draft.trim()); }}>
          <Field label="Tìm theo mã hoặc tên" htmlFor={searchId} className="mb-0 flex-[1_1_200px]"><Input id={searchId} autoComplete="off" value={draft} onChange={event => setDraft(event.target.value)} /></Field>
          <Button type="submit" variant="outline">Tìm</Button>
        </form>
        {list.loading && !list.data ? <Loading /> : null}
        {list.error ? <ErrorAlert>{describe(list.error)} <AlertAction onClick={list.reload}>Thử lại</AlertAction></ErrorAlert> : null}
        {list.data && list.data.items.length === 0 ? <Empty>Không có sản phẩm phù hợp.</Empty> : null}
        {list.data && list.data.items.length > 0 ? (
          <>
            <ul className="m-0 grid list-none gap-2 p-0">{list.data.items.map(asset => <AssetRow key={`${asset.assetId}:${asset.riskLevel}:${asset.status}`} asset={asset} onChanged={list.reload} />)}</ul>
            <nav className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[0.9rem] text-muted-foreground" aria-label="Phân trang sản phẩm">
              <Button type="button" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>Trang trước</Button>
              <span>Trang {page}/{pages}</span>
              <Button type="button" variant="outline" disabled={page >= pages} onClick={() => setPage(page + 1)}>Trang sau</Button>
            </nav>
          </>
        ) : null}
      </Panel>
    </>
  );
}

import { useEffect, useState } from 'react';
import { api, describe } from '../api';
import { formatCompactVnd, formatDate, formatTime, formatVnd, provenanceLabel, riskLabel } from '../format';
import { AlertAction, Empty, ErrorAlert, Field, Loading, PageTitle, Panel, RiskChip, useLoad } from '../ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

interface Aum { value: string | null; asOf: string | null; provenance: string | null; dataStatus: string }
interface CustomerRow {
  customerId: string; name: string; serviceStatus: string;
  currentRisk: { category: string; expiresAt: string; valid: boolean } | null;
  aum: Aum;
  cash: Aum;
  driftAlerts: { count: number };
  pendingProposals: { count: number };
}
interface Page { items: CustomerRow[]; total: number; page: number; pageSize: number }

const PAGE_SIZE = 10;
const sorts: Array<[string, string]> = [['name', 'Tên khách hàng'], ['aum', 'Tài sản quản lý (AUM)'],
  ['riskExpiresAt', 'Ngày hết hạn hồ sơ rủi ro'], ['pendingProposals', 'Số đề xuất chờ duyệt']];

// Below the md breakpoint the table turns into one card per customer, so nothing scrolls sideways on a phone.
const headCell = 'h-auto px-4 py-3 text-[0.78rem] text-muted-foreground';
const cell = 'px-4 py-3 max-md:block max-md:w-full max-md:px-0 max-md:py-[3px] max-md:whitespace-normal';
const labelled = 'max-md:before:text-[0.82rem] max-md:before:text-muted-foreground max-md:before:content-[attr(data-label)_":_"]';

function Muted({ children }: { children: string }) {
  return <span className="text-muted-foreground">{children}</span>;
}

function AumCell({ aum }: { aum: Aum }) {
  return aum.value === null ? <Muted>Chưa có dữ liệu</Muted> : <span title={formatVnd(aum.value)}>{formatCompactVnd(aum.value)}</span>;
}

/** UC04 list: server-side paging, filtering and sorting over the RM's own customers only. */
export function CustomerList() {
  const [nameInput, setNameInput] = useState('');
  const [name, setName] = useState('');
  const [risk, setRisk] = useState('');
  const [sort, setSort] = useState('name');
  const [direction, setDirection] = useState('asc');
  const [page, setPage] = useState(1);

  const list = useLoad(signal => {
    const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), sort, direction });
    if (name.trim()) query.set('name', name.trim());
    if (risk) query.set('risk', risk);
    return api<Page>(`/rm/customers?${query.toString()}`, { signal });
  }, [name, risk, sort, direction, page]);

  useEffect(() => {
    // One request per pause in typing, not one per keystroke.
    const timer = setTimeout(() => { setName(nameInput); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [nameInput]);

  const change = (apply: () => void) => { apply(); setPage(1); };
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;

  return (
    <>
      <PageTitle title="Khách phụ trách" hint="Chỉ gồm khách hàng đang được phân công cho bạn." />
      <div data-testid="customer-filters" className="mb-1 grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-x-3 border-b pb-0.5">
        <Field label="Tìm theo tên" htmlFor="filter-name">
          <Input id="filter-name" type="search" value={nameInput} onChange={event => setNameInput(event.target.value)} autoComplete="off" />
        </Field>
        <Field label="Mức rủi ro" htmlFor="filter-risk">
          <NativeSelect id="filter-risk" value={risk} onChange={event => change(() => setRisk(event.target.value))}>
            <NativeSelectOption value="">Tất cả</NativeSelectOption>
            <NativeSelectOption value="CONSERVATIVE">Thận trọng</NativeSelectOption>
            <NativeSelectOption value="BALANCED">Cân bằng</NativeSelectOption>
            <NativeSelectOption value="GROWTH">Tăng trưởng</NativeSelectOption>
          </NativeSelect>
        </Field>
        <Field label="Sắp xếp theo" htmlFor="sort-by">
          <NativeSelect id="sort-by" value={sort} onChange={event => change(() => setSort(event.target.value))}>
            {sorts.map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}
          </NativeSelect>
        </Field>
        <Field label="Thứ tự" htmlFor="sort-direction">
          <NativeSelect id="sort-direction" value={direction} onChange={event => change(() => setDirection(event.target.value))}>
            <NativeSelectOption value="asc">Tăng dần</NativeSelectOption>
            <NativeSelectOption value="desc">Giảm dần</NativeSelectOption>
          </NativeSelect>
        </Field>
      </div>

      {list.loading ? <Loading skeleton={!list.data} /> : null}
      {list.error ? <ErrorAlert>{describe(list.error)} <AlertAction onClick={list.reload}>Thử lại</AlertAction></ErrorAlert> : null}
      {list.data ? (
        <>
          <p className="mt-[18px] mb-2.5 text-[0.9rem] font-semibold text-muted-foreground tabular-nums">Tổng: {list.data.total} khách hàng</p>
          {list.data.items.length === 0 ? <Empty>Không có khách hàng phù hợp</Empty> : (
            <div className="max-w-full overflow-hidden rounded-xl border bg-card shadow-sm">
              <Table role="table" className="customers text-[0.93rem] max-md:block">
                <TableHeader role="rowgroup" className="bg-muted max-md:sr-only">
                  <TableRow role="row">
                    <TableHead scope="col" role="columnheader" className={headCell}>Khách hàng</TableHead>
                    <TableHead scope="col" role="columnheader" className={headCell}>Rủi ro</TableHead>
                    <TableHead scope="col" role="columnheader" className={headCell}>Hết hạn hồ sơ</TableHead>
                    <TableHead scope="col" role="columnheader" className={cn(headCell, 'text-right')}>AUM</TableHead>
                    <TableHead scope="col" role="columnheader" className={cn(headCell, 'text-right')}>Tiền mặt</TableHead>
                    <TableHead scope="col" role="columnheader" className={cn(headCell, 'text-right')}>Đề xuất</TableHead>
                    <TableHead scope="col" role="columnheader" className={cn(headCell, 'text-right whitespace-normal w-36')}>Kiểm tra chờ</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody role="rowgroup" className="max-md:block">
                  {list.data.items.map(row => (
                    <TableRow key={row.customerId} role="row" className="max-md:block max-md:px-4 max-md:py-3.5">
                      <TableHead scope="row" role="rowheader" className={cn(cell, 'h-auto text-foreground max-md:mb-1 max-md:text-[1.02rem]')}>
                        <a href={`#/rm/customers/${row.customerId}`} className="font-semibold text-foreground no-underline hover:text-primary hover:underline">{row.name}</a>
                      </TableHead>
                      <TableCell role="cell" className={cn(cell, labelled)} data-label="Rủi ro">{row.currentRisk ? <RiskChip category={row.currentRisk.category} label={riskLabel(row.currentRisk.category)} /> : <Muted>Chưa có</Muted>}</TableCell>
                      <TableCell role="cell" className={cn(cell, labelled)} data-label="Hết hạn hồ sơ">{row.currentRisk ? <>{formatDate(row.currentRisk.expiresAt)}{row.currentRisk.valid ? '' : ' (quá hạn)'}</> : <Muted>Chưa có</Muted>}</TableCell>
                      <TableCell role="cell" className={cn(cell, labelled, 'text-right tabular-nums max-md:text-left')} data-label="AUM"><AumCell aum={row.aum} /></TableCell>
                      <TableCell role="cell" className={cn(cell, labelled, 'text-right tabular-nums max-md:text-left')} data-label="Tiền mặt"><AumCell aum={row.cash} /></TableCell>
                      <TableCell role="cell" className={cn(cell, labelled, 'text-right tabular-nums max-md:text-left')} data-label="Đề xuất">{row.pendingProposals.count}</TableCell>
                      <TableCell role="cell" className={cn(cell, labelled, 'relative text-right tabular-nums whitespace-normal w-36 max-md:w-auto max-md:text-left')} data-label="Kiểm tra chờ">
                        {row.driftAlerts.count > 0
                          ? <Badge variant="wait" data-testid="drift-badge" aria-hidden="true">{row.driftAlerts.count}</Badge>
                          : <span data-testid="drift-zero" aria-hidden="true" className="text-muted-foreground">0</span>}
                        <span className="sr-only">Kiểm tra danh mục chờ: {row.driftAlerts.count}</span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <nav className="mt-4 flex flex-wrap items-center justify-between gap-2.5 text-[0.9rem] text-muted-foreground" aria-label="Phân trang">
            <Button type="button" variant="outline" onClick={() => setPage(page - 1)} disabled={page <= 1}>Trang trước</Button>
            <span>Trang {list.data.page}/{pages}</span>
            <Button type="button" variant="outline" onClick={() => setPage(page + 1)} disabled={page >= pages}>Trang sau</Button>
          </nav>
        </>
      ) : null}
    </>
  );
}

/** UC04 detail: risk, decimal-exact AUM with asOf and provenance, pending proposals. */
export function CustomerDetail({ customerId }: { customerId: string }) {
  const detail = useLoad(signal => api<CustomerRow>(`/customers/${customerId}`, { signal }), [customerId]);
  const customer = detail.data;
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  useEffect(() => { if (detail.data) setUpdatedAt(new Date()); }, [detail.data]);
  const refresh = <Button type="button" variant="outline" onClick={detail.reload} disabled={detail.loading}>Làm mới</Button>;
  return (
    <>
      <p className="mb-3 text-[0.9rem]"><a href="#/rm/customers">Quay lại danh sách</a></p>
      {customer ? null : <p>{refresh}</p>}
      {detail.loading && !customer ? <Loading skeleton /> : null}
      {detail.error ? (
        <ErrorAlert>{describe(detail.error, { '403': 'Bạn không có quyền truy cập khách hàng này', '404': 'Không tìm thấy khách hàng này' })}</ErrorAlert>
      ) : null}
      {customer ? (
        <>
          <PageTitle title={customer.name} actions={<>
            {updatedAt ? <span className="text-[0.85rem] text-muted-foreground tabular-nums">Cập nhật lúc {formatTime(updatedAt)}</span> : null}
            {refresh}
          </>} />
          <Panel title="Hồ sơ rủi ro">
            {customer.currentRisk ? (
              <>
                <p>Hồ sơ rủi ro: <RiskChip testId="risk-badge" category={customer.currentRisk.category} label={riskLabel(customer.currentRisk.category)} /></p>
                <p>Hết hạn: {formatDate(customer.currentRisk.expiresAt)}</p>
                {customer.currentRisk.valid ? null : <p><Badge variant="bad">Hồ sơ đã quá hạn</Badge></p>}
              </>
            ) : <Empty>Khách hàng chưa có hồ sơ rủi ro.</Empty>}
          </Panel>
          <Panel title="Tài sản quản lý (AUM)" tone="aum">
            {customer.aum.value === null ? <p>Chưa có dữ liệu</p> : (
              <>
                <p className="mb-2 text-[2.1rem] leading-tight font-bold tracking-tight text-white! tabular-nums">{formatVnd(customer.aum.value)}</p>
                {customer.aum.asOf ? <p>Tại thời điểm: {formatDate(customer.aum.asOf)}</p> : null}
                <p>Nguồn: {customer.aum.provenance ? <span title={customer.aum.provenance}>{provenanceLabel(customer.aum.provenance)}</span> : 'Nhiều nguồn'}</p>
              </>
            )}
          </Panel>
          <Panel title="Tiền mặt">
            <p>Tiền mặt: {customer.cash.value === null ? 'Chưa có dữ liệu' : formatVnd(customer.cash.value)}</p>
          </Panel>
          <Panel title="Công việc cần theo dõi">
            <p>Đề xuất chờ duyệt: {customer.pendingProposals.count}</p>
            <p>Kiểm tra danh mục chờ: {customer.driftAlerts.count}</p>
          </Panel>
        </>
      ) : null}
    </>
  );
}

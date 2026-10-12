import { ArrowRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiFailure, api, describe, intentDone, intentKey } from '../api';
import { riskLabel } from '../format';
import { AlertAction, Empty, ErrorAlert, Fact, Facts, Field, Loading, PageTitle, Panel, useLoad } from '../ui';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

interface Rm { rmId: string; active: boolean; assigned: number; reserved: number; available: number; capacityLimit: number }
interface Customer {
  customerId: string; name: string;
  currentAssignment: { rmId: string; version: number };
  currentRisk: { category: string } | null;
  pendingProposals: { count: number };
}
interface Transfer { rmId: string; version: number; changed: boolean; cancelledProposals?: number }
interface TeamCustomers { items: Array<{ customerId: string; name: string }>; total: number }

const ROSTER_PAGE_SIZE = 50;
const fetchCustomer = (id: string) => api<Customer>(`/customers/${id}`);

/** UC03 (leader): team capacity directory and a versioned, reasoned transfer of one customer. */
export function Assignments() {
  const team = useLoad(signal => api<{ items: Rm[] }>('/team/rms', { signal }), []);
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [rosterPage, setRosterPage] = useState(1);
  const [options, setOptions] = useState<TeamCustomers['items']>([]);
  const [rosterTotal, setRosterTotal] = useState(0);
  const [rosterBusy, setRosterBusy] = useState(false);
  const [rosterError, setRosterError] = useState<unknown>(null);
  const [rosterTick, setRosterTick] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => { setTerm(search.trim()); setRosterPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const controller = new AbortController();
    const query = `page=${rosterPage}&pageSize=${ROSTER_PAGE_SIZE}${term ? `&name=${encodeURIComponent(term)}` : ''}`;
    setRosterBusy(true); setRosterError(null);
    api<TeamCustomers>(`/team/customers?${query}`, { signal: controller.signal }).then(
      data => {
        if (controller.signal.aborted) return;
        setOptions(previous => rosterPage === 1 ? data.items : [...previous, ...data.items]);
        setRosterTotal(data.total); setRosterBusy(false);
      },
      (error: unknown) => { if (!controller.signal.aborted) { setRosterError(error); setRosterBusy(false); } },
    );
    return () => controller.abort();
  }, [term, rosterPage, rosterTick]);
  const [customerId, setCustomerId] = useState('');
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [failure, setFailure] = useState<unknown>(null);
  const [stale, setStale] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    // The modal makes the page inert while it is open, so focus goes back to the opener once it is gone.
    if (wasConfirming.current && !confirming) opener.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);
  const closeDialog = () => setConfirming(false);

  const load = async (event: FormEvent) => {
    event.preventDefault();
    const id = customerId;
    setNotice(null); setFailure(null); setStale(false);
    if (!id) { setCustomer(null); setFailure('Vui lòng chọn khách hàng.'); return; }
    setBusy(true);
    try { setCustomer(await fetchCustomer(id)); setTarget(''); setReason(''); }
    catch (error) { setCustomer(null); setFailure(error); }
    finally { setBusy(false); }
  };

  const reloadCurrent = async () => {
    if (!customer) return;
    setBusy(true); setFailure(null); setStale(false); setNotice(null);
    try { setCustomer(await fetchCustomer(customer.customerId)); team.reload(); }
    catch (error) { setCustomer(null); setFailure(error); }
    finally { setBusy(false); }
  };

  const requestTransfer = () => {
    if (!customer) return;
    setNotice(null); setFailure(null); setStale(false);
    if (!target) { setFailure('Vui lòng chọn RM nhận.'); return; }
    if (!reason.trim()) { setFailure('Vui lòng nhập lý do chuyển.'); return; }
    setConfirming(true);
  };

  const transfer = async () => {
    if (!customer || !target || !reason.trim()) return;
    const name = `assign-${customer.customerId}`;
    const intent = `${target}:${customer.currentAssignment.version}:${reason.trim()}`;
    setBusy(true);
    try {
      const result = await api<Transfer>(`/customers/${customer.customerId}/rm-assignment`, { key: intentKey(name, intent),
        body: { targetRmId: target, reason: reason.trim(), expectedAssignmentVersion: customer.currentAssignment.version } });
      intentDone(name);
      const refreshed = await fetchCustomer(customer.customerId);
      setCustomer(refreshed); setTarget(''); setReason(''); team.reload();
      const cancelled = typeof result.cancelledProposals === 'number'
        ? ` ${result.cancelledProposals} đề xuất đang chờ duyệt của khách đã bị hủy.` : '';
      setNotice(result.changed
        ? `Đã chuyển khách hàng sang RM ${result.rmId}.${cancelled}`
        : 'Khách hàng đã thuộc RM này, không có thay đổi.');
    } catch (error) {
      if (error instanceof ApiFailure && error.code === 'RM_ASSIGNMENT_STALE') setStale(true);
      setFailure(error);
    } finally { setBusy(false); }
  };

  const message = typeof failure === 'string' ? failure : failure ? describe(failure) : null;
  const rms = team.data?.items ?? [];
  const headClass = 'h-auto px-4 py-3 text-[0.78rem] text-muted-foreground';

  return (
    <>
      <PageTitle title="Phân công RM" hint="Xem tải của từng RM trong nhóm, rồi chuyển một khách hàng sang RM khác kèm lý do." />
      <Panel title="Danh sách RM">
        {team.loading && !team.data ? <Loading skeleton /> : null}
        {team.error ? <ErrorAlert>{describe(team.error)} <AlertAction onClick={team.reload}>Thử lại</AlertAction></ErrorAlert> : null}
        {team.data && rms.length === 0 ? <Empty>Nhóm chưa có RM nào.</Empty> : null}
        {rms.length > 0 ? (
          <div className="overflow-x-auto rounded-xl border bg-card">
            <Table className="rm-table text-[0.93rem]">
              <TableHeader className="bg-muted">
                <TableRow>
                  <TableHead scope="col" className={headClass}>Mã RM</TableHead>
                  <TableHead scope="col" className={headClass}>Tải</TableHead>
                  <TableHead scope="col" className={headClass}>Trạng thái</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rms.map(rm => {
                  const used = rm.assigned + rm.reserved;
                  const ratio = used / rm.capacityLimit;
                  return (
                    <TableRow key={rm.rmId}>
                      <TableHead scope="row" className="h-auto px-4 py-3 font-semibold"><code>{rm.rmId}</code></TableHead>
                      <TableCell className="px-4 py-3">
                        <span className="mr-2.5 inline-block h-2 w-24 overflow-hidden rounded-full bg-border align-middle" aria-hidden="true">
                          <span className={cn('block h-full rounded-full', ratio >= 0.9 ? 'bg-destructive' : ratio >= 0.7 ? 'bg-gold' : 'bg-primary')} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
                        </span>
                        <span className="font-semibold tabular-nums">{used}/{rm.capacityLimit}</span>
                      </TableCell>
                      <TableCell className="px-4 py-3">{rm.active ? 'Đang hoạt động' : 'Ngừng hoạt động'}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : null}
      </Panel>

      <form className="mt-2 mb-3 flex flex-wrap items-end gap-x-3" onSubmit={event => void load(event)}>
        <Field label="Tìm khách hàng" htmlFor="customer-search" className="flex-[1_1_240px]">
          <Input id="customer-search" type="search" value={search} onChange={event => setSearch(event.target.value)} autoComplete="off" />
        </Field>
        <Field label="Chọn khách hàng" htmlFor="customer-id" className="flex-[1_1_240px]">
          <NativeSelect id="customer-id" value={customerId} onChange={event => setCustomerId(event.target.value)}>
            <NativeSelectOption value="">Chọn khách hàng</NativeSelectOption>
            {options.map(item => <NativeSelectOption key={item.customerId} value={item.customerId}>{item.name}</NativeSelectOption>)}
          </NativeSelect>
          <p className="m-0 text-muted-foreground">Hiển thị {options.length}/{rosterTotal} khách hàng</p>
          {options.length < rosterTotal ? (
            <Button type="button" variant="outline" className="self-start" onClick={() => setRosterPage(rosterPage + 1)} disabled={rosterBusy}>Tải thêm khách hàng</Button>
          ) : null}
        </Field>
        <Button type="submit" disabled={busy} className="mb-3.5">Tải thông tin khách hàng</Button>
      </form>
      {rosterError ? <ErrorAlert>{describe(rosterError)} <AlertAction onClick={() => setRosterTick(value => value + 1)}>Thử lại</AlertAction></ErrorAlert> : null}
      {busy ? <Loading label="Đang xử lý…" /> : null}
      {message ? (
        <ErrorAlert>
          {message}
          {stale ? <> <AlertAction onClick={() => void reloadCurrent()}>Tải lại</AlertAction></> : null}
        </ErrorAlert>
      ) : null}
      {notice ? <p role="status" className="mb-2 font-semibold text-ok">{notice}</p> : null}

      {customer ? (
        <Panel title="Khách hàng cần chuyển">
          <Facts>
            <Fact label="Họ tên">{customer.name}</Fact>
            <Fact label="RM hiện tại"><code>{customer.currentAssignment.rmId}</code></Fact>
            <Fact label="Phân công">Phiên bản phân công: {customer.currentAssignment.version}</Fact>
            <Fact label="Hồ sơ rủi ro">{customer.currentRisk ? riskLabel(customer.currentRisk.category) : 'Chưa có'}</Fact>
            <Fact label="Đề xuất chờ duyệt">{customer.pendingProposals.count}</Fact>
          </Facts>
          <Field label="RM nhận" htmlFor="target-rm">
            <NativeSelect id="target-rm" value={target} onChange={event => setTarget(event.target.value)}>
              <NativeSelectOption value="">Chọn RM nhận</NativeSelectOption>
              {rms.filter(rm => rm.active).map(rm => <NativeSelectOption key={rm.rmId} value={rm.rmId}>{rm.rmId} ({rm.assigned + rm.reserved}/{rm.capacityLimit})</NativeSelectOption>)}
            </NativeSelect>
          </Field>
          <Field label="Lý do chuyển" htmlFor="reason">
            <Textarea id="reason" value={reason} onChange={event => setReason(event.target.value)} rows={3} />
          </Field>
          <p className="mb-3 text-muted-foreground">Khi chuyển, các đề xuất đang chờ duyệt của khách do RM cũ lập sẽ bị hủy.</p>
          <Button type="button" ref={opener} onClick={requestTransfer} disabled={busy}>Xác nhận chuyển</Button>
        </Panel>
      ) : null}

      <Dialog open={confirming && customer !== null} onOpenChange={open => { if (!open) closeDialog(); }}>
        {customer ? (
          <DialogContent showCloseButton={false} className="gap-3 p-6 sm:max-w-[460px]">
            <DialogHeader>
              <DialogTitle className="text-[1.15rem] leading-snug font-semibold">Xác nhận chuyển RM</DialogTitle>
              <DialogDescription className="text-[15px] text-foreground">Chuyển <strong>{customer.name}</strong> sang RM mới.</DialogDescription>
            </DialogHeader>
            <p className="m-0 flex flex-wrap items-center gap-2.5">
              <code>{customer.currentAssignment.rmId}</code><ArrowRight aria-hidden="true" className="size-4 text-primary" /><code>{target}</code>
            </p>
            <p className="m-0 text-muted-foreground">Lý do: {reason.trim()}</p>
            <p className={cn('m-0', customer.pendingProposals.count > 0 ? 'rounded-lg bg-wait-soft px-3.5 py-2.5 font-semibold text-wait' : 'text-muted-foreground')}>
              {customer.pendingProposals.count > 0
                ? `${customer.pendingProposals.count} đề xuất đang chờ duyệt sẽ bị hủy`
                : 'Khách hàng không có đề xuất đang chờ duyệt.'}
            </p>
            <DialogFooter className="-mx-6 -mb-6 mt-2 p-4">
              <Button type="button" variant="outline" onClick={closeDialog}>Hủy</Button>
              <Button type="button" onClick={() => { closeDialog(); void transfer(); }}>Chuyển khách hàng</Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}

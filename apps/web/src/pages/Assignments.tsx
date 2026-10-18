import { ArrowRight, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiFailure, api, describe, intentDone, intentKey } from '../api';
import { riskLabel, rmText } from '../format';
import { AlertAction, BusyButton, Empty, ErrorAlert, Fact, Facts, Field, Loading, PageTitle, Panel, useLoad } from '../ui';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

interface Rm { rmId: string; rmName: string | null; active: boolean; assigned: number; reserved: number; available: number; capacityLimit: number }
interface Customer {
  customerId: string; name: string;
  currentAssignment: { rmId: string; version: number };
  currentRisk: { category: string } | null;
  pendingProposals: { count: number };
}
interface Transfer { rmId: string; version: number; changed: boolean; cancelledProposals?: number }
interface TeamCustomers { items: Array<{ customerId: string; name: string; rmName: string | null; riskProfileValid: boolean; lastReminderAt: string | null }>; total: number }

const ROSTER_PAGE_SIZE = 50;
const SURVEY_LIST_LIMIT = 5;
type LoadLevel = 'ok' | 'warn' | 'high';
const levelColour: Record<LoadLevel, string> = { ok: '[&>*]:bg-ok', warn: '[&>*]:bg-wait', high: '[&>*]:bg-destructive' };
/** ok below 70%, warn from 70% to 90% inclusive, high above 90% (integer maths, so 56/80 and 72/80 are exact). */
function loadLevel(used: number, capacity: number): LoadLevel {
  if (used * 10 > capacity * 9) return 'high';
  return used * 10 >= capacity * 7 ? 'warn' : 'ok';
}

/** RM as "name · short id"; the full id stays reachable as a tooltip. */
function RmName({ id, name }: { id: string; name?: string | null }) {
  return <span title={id}>{rmText(id, name)}</span>;
}

interface ReminderResult { sent: number; skipped: Array<{ customerId: string; reason: string }> }

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
  const [showAllSurvey, setShowAllSurvey] = useState(false);
  const [reminding, setReminding] = useState<string | null>(null);
  const [reminderNote, setReminderNote] = useState<string | null>(null);
  const [reminderFailure, setReminderFailure] = useState<unknown>(null);
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
  const noticeRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (notice) noticeRef.current?.focus(); }, [notice]);
  useEffect(() => {
    // A selection that the narrowed list no longer offers must not linger as hidden state.
    if (customerId && !options.some(item => item.customerId === customerId)) setCustomerId('');
  }, [options, customerId]);

  const load = async (event: FormEvent) => {
    event.preventDefault();
    const id = customerId;
    setNotice(null); setFailure(null); setStale(false);
    if (!id || !options.some(item => item.customerId === id)) { setCustomer(null); setFailure('Vui lòng chọn khách hàng.'); return; }
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
        ? `Đã chuyển khách hàng sang RM ${nameOf(result.rmId)}.${cancelled}`
        : 'Khách hàng đã thuộc RM này, không có thay đổi.');
    } catch (error) {
      if (error instanceof ApiFailure && error.code === 'RM_ASSIGNMENT_STALE') setStale(true);
      setFailure(error);
    } finally { setBusy(false); }
  };

  const remind = async (scope: string, customerIds?: string[]) => {
    setReminding(scope); setReminderNote(null); setReminderFailure(null);
    try {
      const result = await api<ReminderResult>('/team/risk-survey-reminders', { body: customerIds ? { customerIds } : {} });
      if (result.sent > 0) setReminderNote(`Đã gửi ${result.sent} lời nhắc`);
      else if (result.skipped.some(item => item.reason === 'RECENTLY_REMINDED')) setReminderNote('Khách đã được nhắc trong 24 giờ qua');
      else setReminderNote('Không có lời nhắc nào được gửi');
      setRosterTick(value => value + 1);
    } catch (error) { setReminderFailure(error); }
    finally { setReminding(null); }
  };
  // Customers still owing a survey come first so the capped list shows the ones a leader can act on.
  const surveyRows = [...options.filter(item => !item.riskProfileValid), ...options.filter(item => item.riskProfileValid)];
  const surveyShown = showAllSurvey ? surveyRows : surveyRows.slice(0, SURVEY_LIST_LIMIT);
  const pendingCount = options.filter(item => !item.riskProfileValid).length;
  const surveyMissing = customer ? options.find(item => item.customerId === customer.customerId)?.riskProfileValid === false : false;

  const message = typeof failure === 'string' ? failure : failure ? describe(failure) : null;
  const rms = team.data?.items ?? [];
  const nameOf = (id: string) => rmText(id, rms.find(rm => rm.rmId === id)?.rmName);
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
            <Table className="rm-table text-[0.93rem] max-sm:text-[0.82rem]">
              <TableHeader className="bg-muted">
                <TableRow>
                  <TableHead scope="col" className={headClass}>RM</TableHead>
                  <TableHead scope="col" className={headClass}>Tải</TableHead>
                  <TableHead scope="col" className={headClass}>Trạng thái</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rms.map(rm => {
                  const used = rm.assigned + rm.reserved;
                  return (
                    <TableRow key={rm.rmId}>
                      <TableHead scope="row" className="h-auto px-2 py-3 font-semibold sm:px-4"><span className="block truncate sm:max-w-none"><RmName id={rm.rmId} name={rm.rmName} /></span></TableHead>
                      <TableCell className="px-2 py-3 sm:px-4">
                        <div className="flex items-center gap-2.5">
                          <Progress value={Math.min(used, rm.capacityLimit)} max={rm.capacityLimit} data-level={loadLevel(used, rm.capacityLimit)} aria-label={`Tải của ${rmText(rm.rmId, rm.rmName)}`} aria-valuetext={`${used}/${rm.capacityLimit} khách`}
                            className={cn('hidden w-24 flex-none sm:flex', levelColour[loadLevel(used, rm.capacityLimit)])} />
                          <span className="font-semibold tabular-nums">{used}/{rm.capacityLimit} khách</span>
                        </div>
                      </TableCell>
                      <TableCell className="px-2 py-3 max-sm:whitespace-normal sm:px-4">{rm.active ? 'Đang hoạt động' : 'Ngừng hoạt động'}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : null}
      </Panel>

      <Panel title="Khảo sát rủi ro của khách hàng">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <p className="m-0 flex-1 text-muted-foreground">Nhắc khách chưa có hồ sơ rủi ro còn hiệu lực làm khảo sát 10 câu hỏi.</p>
          <BusyButton type="button" variant="outline" busy={reminding === 'all'} disabled={reminding !== null || pendingCount === 0}
            onClick={() => void remind('all')}>Nhắc tất cả khách chưa hoàn thành</BusyButton>
        </div>
        {reminderFailure ? <ErrorAlert>{describe(reminderFailure)}</ErrorAlert> : null}
        <p role="status" className="mb-3 font-semibold text-ok empty:mb-0">{reminderNote}</p>
        {options.length === 0 ? <Empty>Chưa có khách hàng nào để hiển thị.</Empty> : (
          <ul className="m-0 grid list-none gap-2 p-0">
            {surveyShown.map(item => (
              <li key={item.customerId} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-card px-3.5 py-2.5">
                <span className="min-w-0 flex-1 font-semibold">{item.name}</span>
                <Badge variant={item.riskProfileValid ? 'ok' : 'wait'}>{item.riskProfileValid ? 'Đã hoàn thành khảo sát' : 'Chưa hoàn thành khảo sát'}</Badge>
                {item.riskProfileValid ? null : (
                  <BusyButton type="button" variant="outline" size="sm" busy={reminding === item.customerId} disabled={reminding !== null}
                    onClick={() => void remind(item.customerId, [item.customerId])}>Nhắc làm khảo sát</BusyButton>
                )}
              </li>
            ))}
          </ul>
        )}
        {surveyRows.length > SURVEY_LIST_LIMIT ? (
          <Button type="button" variant="outline" size="sm" className="mt-3" aria-expanded={showAllSurvey}
            onClick={() => setShowAllSurvey(value => !value)}>{showAllSurvey ? 'Thu gọn danh sách' : 'Xem tất cả'}</Button>
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
        </Field>
        <BusyButton type="submit" busy={busy} className="mb-3.5">Tải thông tin khách hàng</BusyButton>
      </form>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <p className="m-0 text-muted-foreground">Hiển thị {options.length}/{rosterTotal} khách hàng</p>
        {options.length < rosterTotal ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setRosterPage(rosterPage + 1)} disabled={rosterBusy}>Tải thêm khách hàng</Button>
        ) : null}
      </div>
      {rosterError ? <ErrorAlert>{describe(rosterError)} <AlertAction onClick={() => setRosterTick(value => value + 1)}>Thử lại</AlertAction></ErrorAlert> : null}
      {busy ? <Loading label="Đang xử lý…" /> : null}
      {message ? (
        <ErrorAlert>
          {message}
          {stale ? <> <AlertAction onClick={() => void reloadCurrent()}>Tải lại</AlertAction></> : null}
        </ErrorAlert>
      ) : null}
      {notice ? <p role="status" ref={noticeRef} tabIndex={-1} className="mb-2 font-semibold text-ok outline-none">{notice}</p> : null}

      {customer ? (
        <Panel title="Khách hàng cần chuyển">
          <Facts>
            <Fact label="Họ tên">{customer.name}</Fact>
            <Fact label="RM hiện tại"><RmName id={customer.currentAssignment.rmId} name={rms.find(rm => rm.rmId === customer.currentAssignment.rmId)?.rmName} /></Fact>
            <Fact label="Phân công">Phiên bản phân công: {customer.currentAssignment.version}</Fact>
            <Fact label="Hồ sơ rủi ro">{customer.currentRisk ? riskLabel(customer.currentRisk.category) : 'Chưa có'}</Fact>
            <Fact label="Đề xuất chờ duyệt">{customer.pendingProposals.count}</Fact>
          </Facts>
          {surveyMissing ? <p id="transfer-blocked-reason" className="mb-3 font-semibold text-wait">Khách chưa hoàn thành khảo sát rủi ro. Chỉ chuyển RM được khi khách có hồ sơ rủi ro còn hiệu lực.</p> : null}
          <Field label="RM nhận" htmlFor="target-rm">
            <NativeSelect id="target-rm" disabled={surveyMissing} aria-describedby={surveyMissing ? 'transfer-blocked-reason' : undefined} value={target} onChange={event => setTarget(event.target.value)}>
              <NativeSelectOption value="">Chọn RM nhận</NativeSelectOption>
              {rms.filter(rm => rm.active).map(rm => <NativeSelectOption key={rm.rmId} value={rm.rmId}>{rmText(rm.rmId, rm.rmName)} ({rm.assigned + rm.reserved}/{rm.capacityLimit})</NativeSelectOption>)}
            </NativeSelect>
          </Field>
          <Field label="Lý do chuyển" htmlFor="reason">
            <Textarea id="reason" value={reason} onChange={event => setReason(event.target.value)} rows={3} />
          </Field>
          <p className="mb-3 text-muted-foreground">Khi chuyển, các đề xuất đang chờ duyệt của khách do RM cũ lập sẽ bị hủy.</p>
          <Button type="button" ref={opener} onClick={requestTransfer} disabled={busy || surveyMissing} aria-describedby={surveyMissing ? 'transfer-blocked-reason' : undefined}>Xác nhận chuyển</Button>
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
              <code><RmName id={customer.currentAssignment.rmId} name={rms.find(rm => rm.rmId === customer.currentAssignment.rmId)?.rmName} /></code><ArrowRight aria-hidden="true" className="size-4 text-primary" /><code><RmName id={target} name={rms.find(rm => rm.rmId === target)?.rmName} /></code>
            </p>
            <p className="m-0 text-muted-foreground">Lý do: {reason.trim()}</p>
            {customer.pendingProposals.count > 0
              ? <Alert className="border-wait/30 bg-wait-soft px-3.5 py-2.5 font-semibold text-wait"><TriangleAlert aria-hidden="true" />{`${customer.pendingProposals.count} đề xuất đang chờ duyệt sẽ bị hủy`}</Alert>
              : <p className="m-0 text-muted-foreground">Khách hàng không có đề xuất đang chờ duyệt.</p>}
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

import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiFailure, api, describe, intentDone, intentKey } from '../api';
import { riskLabel } from '../format';
import { Empty, ErrorAlert, Loading, PageTitle, Panel, useLoad } from '../ui';

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
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (confirming && dialog.current && !dialog.current.open) dialog.current.showModal(); }, [confirming]);
  const wasConfirming = useRef(false);
  useEffect(() => {
    // The modal makes the page inert until it is removed, so focus goes back to the opener only after it is gone.
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

  return (
    <>
      <PageTitle title="Phân công RM" hint="Xem tải của từng RM trong nhóm, rồi chuyển một khách hàng sang RM khác kèm lý do." />
      <Panel title="Danh sách RM">
        {team.loading && !team.data ? <Loading /> : null}
        {team.error ? <ErrorAlert>{describe(team.error)} <button type="button" className="link" onClick={team.reload}>Thử lại</button></ErrorAlert> : null}
        {team.data && rms.length === 0 ? <Empty>Nhóm chưa có RM nào.</Empty> : null}
        {rms.length > 0 ? (
          <div className="table-wrap">
            <table className="rm-table">
              <thead><tr><th scope="col">Mã RM</th><th scope="col">Tải</th><th scope="col">Trạng thái</th></tr></thead>
              <tbody>
                {rms.map(rm => {
                  const used = rm.assigned + rm.reserved;
                  return (
                    <tr key={rm.rmId}>
                      <th scope="row"><code>{rm.rmId}</code></th>
                      <td>
                        <span className={`meter${used / rm.capacityLimit >= 0.9 ? ' high' : used / rm.capacityLimit >= 0.7 ? ' mid' : ''}`} aria-hidden="true"><span style={{ width: `${Math.min(100, (used / rm.capacityLimit) * 100)}%` }} /></span>
                        <span className="load">{used}/{rm.capacityLimit}</span>
                      </td>
                      <td>{rm.active ? 'Đang hoạt động' : 'Ngừng hoạt động'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </Panel>

      <form className="inline-form" onSubmit={event => void load(event)}>
        <div className="field">
          <label htmlFor="customer-search">Tìm khách hàng</label>
          <input id="customer-search" type="search" value={search} onChange={event => setSearch(event.target.value)} autoComplete="off" />
        </div>
        <div className="field">
          <label htmlFor="customer-id">Chọn khách hàng</label>
          <select id="customer-id" value={customerId} onChange={event => setCustomerId(event.target.value)}>
            <option value="">Chọn khách hàng</option>
            {options.map(item => <option key={item.customerId} value={item.customerId}>{item.name}</option>)}
          </select>
          <p className="hint">Hiển thị {options.length}/{rosterTotal} khách hàng</p>
          {options.length < rosterTotal ? (
            <button type="button" className="secondary" onClick={() => setRosterPage(rosterPage + 1)} disabled={rosterBusy}>Tải thêm khách hàng</button>
          ) : null}
        </div>
        <button type="submit" disabled={busy}>Tải thông tin khách hàng</button>
      </form>
      {rosterError ? <ErrorAlert>{describe(rosterError)} <button type="button" className="link" onClick={() => setRosterTick(value => value + 1)}>Thử lại</button></ErrorAlert> : null}
      {busy ? <Loading label="Đang xử lý…" /> : null}
      {message ? (
        <ErrorAlert>
          {message}
          {stale ? <> <button type="button" className="link" onClick={() => void reloadCurrent()}>Tải lại</button></> : null}
        </ErrorAlert>
      ) : null}
      {notice ? <p role="status" className="success-line">{notice}</p> : null}

      {customer ? (
        <Panel title="Khách hàng cần chuyển">
          <dl className="facts">
            <div><dt>Họ tên</dt><dd>{customer.name}</dd></div>
            <div><dt>RM hiện tại</dt><dd><code>{customer.currentAssignment.rmId}</code></dd></div>
            <div><dt>Phân công</dt><dd>Phiên bản phân công: {customer.currentAssignment.version}</dd></div>
            <div><dt>Hồ sơ rủi ro</dt><dd>{customer.currentRisk ? riskLabel(customer.currentRisk.category) : 'Chưa có'}</dd></div>
            <div><dt>Đề xuất chờ duyệt</dt><dd>{customer.pendingProposals.count}</dd></div>
          </dl>
          <div className="field">
            <label htmlFor="target-rm">RM nhận</label>
            <select id="target-rm" value={target} onChange={event => setTarget(event.target.value)}>
              <option value="">Chọn RM nhận</option>
              {rms.filter(rm => rm.active).map(rm => <option key={rm.rmId} value={rm.rmId}>{rm.rmId} ({rm.assigned + rm.reserved}/{rm.capacityLimit})</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="reason">Lý do chuyển</label>
            <textarea id="reason" value={reason} onChange={event => setReason(event.target.value)} rows={3} />
          </div>
          <p className="hint">Khi chuyển, các đề xuất đang chờ duyệt của khách do RM cũ lập sẽ bị hủy.</p>
          <button type="button" ref={opener} onClick={requestTransfer} disabled={busy}>Xác nhận chuyển</button>
        </Panel>
      ) : null}

      {confirming && customer ? (
        <dialog ref={dialog} className="confirm-dialog" aria-modal="true" aria-labelledby="transfer-title" onClose={closeDialog} onCancel={closeDialog}>
          <h3 id="transfer-title">Xác nhận chuyển RM</h3>
          <p>Chuyển <strong>{customer.name}</strong> sang RM mới.</p>
          <p className="transfer-route">
            <code>{customer.currentAssignment.rmId}</code><span aria-hidden="true" className="arrow">→</span><code>{target}</code>
          </p>
          <p className="transfer-reason">Lý do: {reason.trim()}</p>
          <p className={customer.pendingProposals.count > 0 ? 'transfer-warning' : 'hint'}>
            {customer.pendingProposals.count > 0
              ? `${customer.pendingProposals.count} đề xuất đang chờ duyệt sẽ bị hủy`
              : 'Khách hàng không có đề xuất đang chờ duyệt.'}
          </p>
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={closeDialog}>Hủy</button>
            <button type="button" onClick={() => { closeDialog(); void transfer(); }}>Chuyển khách hàng</button>
          </div>
        </dialog>
      ) : null}
    </>
  );
}

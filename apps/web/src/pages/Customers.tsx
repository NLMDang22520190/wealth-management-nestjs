import { useState } from 'react';
import { api, describe } from '../api';
import { formatDate, formatVnd, riskLabel } from '../format';
import { Empty, ErrorAlert, Loading, PageTitle, Panel, RiskChip, useLoad } from '../ui';

interface Aum { value: string | null; asOf: string | null; provenance: string | null; dataStatus: string }
interface CustomerRow {
  customerId: string; name: string; serviceStatus: string;
  currentRisk: { category: string; expiresAt: string; valid: boolean } | null;
  aum: Aum;
  driftAlerts: { count: number };
  pendingProposals: { count: number };
}
interface Page { items: CustomerRow[]; total: number; page: number; pageSize: number }

const PAGE_SIZE = 10;
const sorts: Array<[string, string]> = [['name', 'Tên khách hàng'], ['aum', 'Tài sản quản lý (AUM)'],
  ['riskExpiresAt', 'Ngày hết hạn hồ sơ rủi ro'], ['pendingProposals', 'Số đề xuất chờ duyệt']];

function AumCell({ aum }: { aum: Aum }) {
  return aum.value === null ? <span className="muted">Chưa có dữ liệu</span> : <>{formatVnd(aum.value)}</>;
}

/** UC04 list: server-side paging, filtering and sorting over the RM's own customers only. */
export function CustomerList() {
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

  const change = (apply: () => void) => { apply(); setPage(1); };
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;

  return (
    <>
      <PageTitle title="Khách phụ trách" hint="Chỉ gồm khách hàng đang được phân công cho bạn." />
      <div className="filters">
        <div className="field">
          <label htmlFor="filter-name">Tìm theo tên</label>
          <input id="filter-name" type="search" value={name} onChange={event => change(() => setName(event.target.value))} autoComplete="off" />
        </div>
        <div className="field">
          <label htmlFor="filter-risk">Mức rủi ro</label>
          <select id="filter-risk" value={risk} onChange={event => change(() => setRisk(event.target.value))}>
            <option value="">Tất cả</option>
            <option value="CONSERVATIVE">Thận trọng</option>
            <option value="BALANCED">Cân bằng</option>
            <option value="GROWTH">Tăng trưởng</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="sort-by">Sắp xếp theo</label>
          <select id="sort-by" value={sort} onChange={event => change(() => setSort(event.target.value))}>
            {sorts.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="sort-direction">Thứ tự</label>
          <select id="sort-direction" value={direction} onChange={event => change(() => setDirection(event.target.value))}>
            <option value="asc">Tăng dần</option>
            <option value="desc">Giảm dần</option>
          </select>
        </div>
      </div>

      {list.loading ? <Loading /> : null}
      {list.error ? <ErrorAlert>{describe(list.error)} <button type="button" className="link" onClick={list.reload}>Thử lại</button></ErrorAlert> : null}
      {list.data ? (
        <>
          <p className="total">Tổng: {list.data.total} khách hàng</p>
          {list.data.items.length === 0 ? <Empty>Không có khách hàng phù hợp</Empty> : (
            <div className="table-wrap">
              <table className="customers" role="table">
                <thead role="rowgroup">
                  <tr role="row">
                    <th scope="col" role="columnheader">Khách hàng</th><th scope="col">Rủi ro</th><th scope="col">Hết hạn hồ sơ</th>
                    <th scope="col" className="num">AUM</th><th scope="col" className="num">Đề xuất</th><th scope="col" className="num">Cảnh báo</th>
                  </tr>
                </thead>
                <tbody role="rowgroup">
                  {list.data.items.map(row => (
                    <tr key={row.customerId} role="row">
                      <th scope="row" role="rowheader" className="c-name"><a href={`#/rm/customers/${row.customerId}`}>{row.name}</a></th>
                      <td role="cell" className="c-risk" data-label="Rủi ro">{row.currentRisk ? <RiskChip category={row.currentRisk.category} label={riskLabel(row.currentRisk.category)} /> : <span className="muted">Chưa có</span>}</td>
                      <td role="cell" data-label="Hết hạn hồ sơ">{row.currentRisk ? <>{formatDate(row.currentRisk.expiresAt)}{row.currentRisk.valid ? '' : ' (quá hạn)'}</> : <span className="muted">Chưa có</span>}</td>
                      <td role="cell" className="num" data-label="AUM"><AumCell aum={row.aum} /></td>
                      <td role="cell" className="num" data-label="Đề xuất">{row.pendingProposals.count}</td>
                      <td role="cell" className={`num c-drift${row.driftAlerts.count > 0 ? ' has-alert' : ''}`}>Cảnh báo drift: {row.driftAlerts.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <nav className="pager" aria-label="Phân trang">
            <button type="button" className="secondary" onClick={() => setPage(page - 1)} disabled={page <= 1}>Trang trước</button>
            <span>Trang {list.data.page}/{pages}</span>
            <button type="button" className="secondary" onClick={() => setPage(page + 1)} disabled={page >= pages}>Trang sau</button>
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
  return (
    <>
      <p className="back"><a href="#/rm/customers">Quay lại danh sách</a></p>
      {detail.loading && !customer ? <Loading /> : null}
      {detail.error ? (
        <ErrorAlert>{describe(detail.error, { '403': 'Bạn không có quyền truy cập khách hàng này', '404': 'Không tìm thấy khách hàng này' })}</ErrorAlert>
      ) : null}
      {customer ? (
        <>
          <PageTitle title={customer.name} />
          <Panel title="Hồ sơ rủi ro">
            {customer.currentRisk ? (
              <>
                <p>Hồ sơ rủi ro: {riskLabel(customer.currentRisk.category)}</p>
                <p>Hết hạn: {formatDate(customer.currentRisk.expiresAt)}</p>
                {customer.currentRisk.valid ? null : <p className="badge bad">Hồ sơ đã quá hạn</p>}
              </>
            ) : <Empty>Khách hàng chưa có hồ sơ rủi ro.</Empty>}
          </Panel>
          <Panel title="Tài sản quản lý (AUM)" className="aum-panel">
            {customer.aum.value === null ? <p className="muted">Chưa có dữ liệu</p> : (
              <>
                <p className="aum-value">{formatVnd(customer.aum.value)}</p>
                {customer.aum.asOf ? <p>Tại thời điểm: {formatDate(customer.aum.asOf)}</p> : null}
                <p>Nguồn: {customer.aum.provenance ?? 'Nhiều nguồn'}</p>
              </>
            )}
          </Panel>
          <Panel title="Công việc cần theo dõi">
            <p>Đề xuất chờ duyệt: {customer.pendingProposals.count}</p>
            <p>Cảnh báo lệch rủi ro: {customer.driftAlerts.count}</p>
          </Panel>
        </>
      ) : null}
      <p><button type="button" className="secondary" onClick={detail.reload} disabled={detail.loading}>Làm mới</button></p>
    </>
  );
}

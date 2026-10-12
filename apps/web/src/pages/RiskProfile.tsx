import { api, describe } from '../api';
import { formatDate, formatDateTime, riskLabel } from '../format';
import type { Allocation } from '../ui';
import { AlertAction, AllocationSummary, Empty, ErrorAlert, Loading, PageTitle, Panel, useLoad } from '../ui';
import { Badge } from '@/components/ui/badge';

interface Profile { id: string; version: number; score: number; category: string; maxProductRisk: number; allocation: Allocation; confirmedAt: string; expiresAt: string; valid: boolean }
interface Overview {
  current: Profile | null;
  holdingsCheck: null | { status: string; asOf: string | null; provenance: string | null; incompatibleHoldings: Array<{ productId: string; productRisk: number; maxProductRisk: number }> };
}
interface History { items: Profile[]; total: number }

const profileErrors = { '404': 'Bạn chưa đăng ký dịch vụ nên chưa có hồ sơ rủi ro.' };

/** UC02: current risk profile with expiry, and the paged history of confirmed assessments. */
export function RiskProfile() {
  const overview = useLoad(signal => api<Overview>('/me/risk-profile', { signal }), []);
  const history = useLoad(signal => api<History>('/me/risk-profile/history?page=1&pageSize=20', { signal }), []);
  const failure = overview.error ?? history.error;
  const retry = () => { overview.reload(); history.reload(); };
  return (
    <>
      <PageTitle title="Hồ sơ rủi ro" hint="Hồ sơ hiện tại và các lần đánh giá đã xác nhận." />
      {(overview.loading || history.loading) && !overview.data ? <Loading skeleton /> : null}
      {failure ? <ErrorAlert>{describe(failure, profileErrors)} <AlertAction onClick={retry}>Thử lại</AlertAction></ErrorAlert> : null}
      {overview.data ? (
        <Panel title="Hồ sơ hiện tại">
          {overview.data.current ? (
            <>
              <p className="mb-1 text-[1.9rem] leading-tight font-bold">{riskLabel(overview.data.current.category)}</p>
              <p>Điểm: {overview.data.current.score}</p>
              <AllocationSummary maxProductRisk={overview.data.current.maxProductRisk} allocation={overview.data.current.allocation} />
              <p>Hết hạn: {formatDate(overview.data.current.expiresAt)}</p>
              {overview.data.current.valid ? null : <p><Badge variant="bad">Hồ sơ đã quá hạn, cần làm lại khảo sát</Badge></p>}
              <p className="text-muted-foreground">Xác nhận lúc {formatDateTime(overview.data.current.confirmedAt)}, phiên bản {overview.data.current.version}.</p>
              {overview.data.holdingsCheck ? (
                <p className="rounded-lg bg-wait-soft px-3.5 py-2.5 text-wait">Danh mục hiện có {overview.data.holdingsCheck.incompatibleHoldings.length} sản phẩm vượt mức rủi ro mới; việc kiểm tra đang chờ xử lý.</p>
              ) : null}
            </>
          ) : <Empty>Bạn chưa có hồ sơ rủi ro. Làm khảo sát rủi ro để bắt đầu.</Empty>}
        </Panel>
      ) : null}
      {history.data ? (
        <Panel title="Lịch sử đánh giá">
          {history.data.items.length === 0 ? <Empty>Chưa có lần đánh giá nào.</Empty> : (
            <ul className="m-0 list-none p-0">
              {history.data.items.map(item => (
                <li key={item.id} className="flex flex-wrap gap-x-4 gap-y-1 border-b py-3 first:pt-0 last:border-b-0 last:pb-0">
                  <strong>Phiên bản {item.version}</strong>
                  <span>{riskLabel(item.category)}</span>
                  <span>{item.score} điểm</span>
                  <span>Xác nhận {formatDate(item.confirmedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      ) : null}
    </>
  );
}

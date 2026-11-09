import { useState } from 'react';
import { api, describe, intentDone, intentKey } from '../api';
import { formatDateTime } from '../format';
import { AlertAction, BusyButton, Empty, ErrorAlert, Fact, Facts, Loading, PageTitle, Panel, useLoad } from '../ui';
import { money } from './Cash';
import { classLabels, percent } from './Portfolio';
import { Badge } from '@/components/ui/badge';

export interface DriftAlert {
  alertId: string; customerId: string; fullName: string; allocationClass: string; actualWeight: string; targetWeight: string; deviation: string; status: string; createdAt: string;
  direction: string | null; adjustAmount: string | null; aum: string;
}
interface RiskWarning { customerId: string; fullName: string; assetId: string; assetCode: string; assetName: string; riskLevel: number; maxProductRisk: number }

function AlertCard({ alert, onRead }: { alert: DriftAlert; onRead: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const read = async () => {
    setBusy(true); setFailure(null);
    const name = `drift-read-${alert.alertId}`;
    try {
      await api(`/rm/drift-alerts/${alert.alertId}/read`, { method: 'POST', key: intentKey(name, alert.alertId) });
      intentDone(name);
      onRead();
    } catch (error) { setFailure(error); } finally { setBusy(false); }
  };
  return (
    <li className="rounded-lg border bg-card px-3.5 py-3">
      <p className="m-0 mb-2 flex flex-wrap items-center gap-x-2 font-semibold">
        <a href={`#/rm/customers/${alert.customerId}`}>{alert.fullName}</a>
        <span>· {classLabels[alert.allocationClass]}</span>
        {alert.status === 'NEW' ? <Badge variant="wait">Mới</Badge> : <Badge variant="outline">Đã đọc</Badge>}
      </p>
      <Facts>
        <Fact label="Tỷ trọng thực tế">{percent(alert.actualWeight)}</Fact>
        <Fact label="Tỷ trọng mục tiêu">{percent(alert.targetWeight)}</Fact>
        <Fact label="Độ lệch">{percent(alert.deviation)}</Fact>
        <Fact label="Gợi ý">{alert.adjustAmount ? `${alert.direction === 'INCREASE' ? 'Tăng' : 'Giảm'} ${money(alert.adjustAmount)}` : 'Không có'}</Fact>
        <Fact label="Tạo lúc">{formatDateTime(alert.createdAt)}</Fact>
      </Facts>
      {alert.status === 'NEW' ? <BusyButton type="button" variant="outline" busy={busy} aria-label={`Đánh dấu đã đọc: ${alert.fullName}, ${classLabels[alert.allocationClass]}`} onClick={() => void read()}>Đánh dấu đã đọc</BusyButton> : null}
      {failure ? <ErrorAlert>{describe(failure)}</ErrorAlert> : null}
    </li>
  );
}

/** UC-12 for the RM. Nothing here places an order; the rebalancing proposal itself belongs to UC-13. */
export function DriftAlerts() {
  const alerts = useLoad(signal => api<{ items: DriftAlert[] }>('/rm/drift-alerts', { signal }), []);
  const warnings = useLoad(signal => api<{ items: RiskWarning[] }>('/rm/product-risk-warnings', { signal }), []);
  return (
    <>
      <PageTitle title="Cảnh báo danh mục" hint="Khách có nhóm tài sản lệch từ 5 điểm phần trăm so với mục tiêu, và khách đang giữ sản phẩm vượt mức rủi ro." />
      <Panel title="Cảnh báo lệch tỷ trọng">
        {alerts.loading && !alerts.data ? <Loading /> : null}
        {alerts.error ? <ErrorAlert>{describe(alerts.error)} <AlertAction onClick={alerts.reload}>Thử lại</AlertAction></ErrorAlert> : null}
        {alerts.data && alerts.data.items.length === 0 ? <Empty>Không có cảnh báo nào đang mở.</Empty> : null}
        {alerts.data && alerts.data.items.length > 0 ? <ul className="m-0 grid list-none gap-2 p-0">{alerts.data.items.map(alert => <AlertCard key={alert.alertId} alert={alert} onRead={alerts.reload} />)}</ul> : null}
      </Panel>
      <Panel title="Sản phẩm vượt mức rủi ro">
        {warnings.error ? <ErrorAlert>{describe(warnings.error)}</ErrorAlert> : null}
        {warnings.data && warnings.data.items.length === 0 ? <Empty>Không có khách nào giữ sản phẩm vượt mức rủi ro.</Empty> : null}
        {warnings.data && warnings.data.items.length > 0 ? (
          <ul className="m-0 grid list-none gap-2 p-0">
            {warnings.data.items.map(item => (
              <li key={`${item.customerId}-${item.assetId}`} className="rounded-lg border bg-card px-3.5 py-2.5">
                <p className="m-0 font-semibold"><a href={`#/rm/customers/${item.customerId}`}>{item.fullName}</a></p>
                <p className="m-0 break-words">{item.assetName} ({item.assetCode}): mức {item.riskLevel}, tối đa của khách là mức {item.maxProductRisk}</p>
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>
    </>
  );
}

/** The open alerts of one customer, on the staff customer screen. */
export function CustomerDriftAlerts({ customerId }: { customerId: string }) {
  const alerts = useLoad(signal => api<{ items: DriftAlert[] }>(`/customers/${customerId}/drift-alerts`, { signal }), [customerId]);
  return (
    <Panel title="Cảnh báo lệch tỷ trọng">
      {alerts.error ? <ErrorAlert>{describe(alerts.error)}</ErrorAlert> : null}
      {alerts.data && alerts.data.items.length === 0 ? <Empty>Không có cảnh báo nào đang mở.</Empty> : null}
      {alerts.data && alerts.data.items.length > 0 ? (
        <ul className="m-0 grid list-none gap-1.5 p-0">
          {alerts.data.items.map(alert => (
            <li key={alert.alertId}>{classLabels[alert.allocationClass]}: thực tế {percent(alert.actualWeight)}, mục tiêu {percent(alert.targetWeight)}{alert.adjustAmount ? `, gợi ý ${alert.direction === 'INCREASE' ? 'tăng' : 'giảm'} ${money(alert.adjustAmount)}` : ''}</li>
          ))}
        </ul>
      ) : null}
    </Panel>
  );
}

import { TriangleAlert } from 'lucide-react';
import { api, describe } from '../api';
import { AlertAction, Empty, ErrorAlert, Fact, Facts, Loading, PageTitle, Panel, useLoad } from '../ui';
import { money } from './Cash';
import { dayText, plainNumber } from './Prices';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';

interface Holding {
  holdingId: string; assetCode: string; assetName: string; assetClass: string; quantity: string; unitPrice: string | null; priceDate: string | null; priceStale: boolean;
  principal: string; accruedInterest: string | null; cost: string; value: string | null; unrealizedPnl: string | null; maturityDate: string | null;
}
export interface AllocationRow {
  allocationClass: string; value: string; actualWeight: string | null; targetWeight: string | null; deviation: string | null; drifted: boolean; direction: string | null; suggestedAmount: string | null;
}
interface PortfolioData {
  asOf: string; dataStatus: 'COMPLETE' | 'INCOMPLETE'; hasStalePrice: boolean; aum: string; cash: string; depositValue: string; bondValue: string; fundValue: string; totalCost: string; unrealizedPnl: string;
  items: Holding[]; allocation: AllocationRow[];
}
interface HistoryPoint { date: string; aum: string; live: boolean }

export const classLabels: Record<string, string> = { CASH: 'Tiền mặt', TERM_DEPOSIT: 'Tiền gửi', BOND: 'Trái phiếu', MUTUAL_FUND: 'Chứng chỉ quỹ' };
export const percent = (value: string) => `${value.replace('.', ',')}%`;

/** Display only: the height of a point; amounts shown as text never go through Number. */
function AumChart({ points }: { points: HistoryPoint[] }) {
  const width = 640;
  const height = 180;
  const pad = 12;
  const values = points.map(point => Number(point.aum));
  const top = Math.max(...values);
  const bottom = Math.min(...values);
  const span = top - bottom || 1;
  const x = (index: number) => (points.length === 1 ? width / 2 : pad + (index * (width - pad * 2)) / (points.length - 1));
  const y = (value: number) => height - pad - ((value - bottom) / span) * (height - pad * 2);
  const path = values.map((value, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)} ${y(value).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label="Biểu đồ tổng tài sản theo ngày; số liệu ở bảng bên dưới">
      <path d={path} fill="none" className="stroke-primary" strokeWidth="2.5" strokeLinejoin="round" />
      {values.map((value, index) => <circle key={points[index]!.date} cx={x(index)} cy={y(value)} r={points[index]!.live ? 5 : 3} className="fill-primary" />)}
    </svg>
  );
}

function History({ path }: { path: string }) {
  const history = useLoad(signal => api<{ points: HistoryPoint[] }>(`${path}/aum-history`, { signal }), [path]);
  return (
    <Panel title="Biến động tài sản">
      {history.loading && !history.data ? <Loading /> : null}
      {history.error ? <ErrorAlert>{describe(history.error)}</ErrorAlert> : null}
      {history.data ? (
        <>
          <AumChart points={history.data.points} />
          <ul className="m-0 mt-3 grid list-none gap-1 p-0 tabular-nums">
            {history.data.points.map(point => (
              <li key={point.date} className="flex flex-wrap justify-between gap-x-3">
                <span>{dayText(point.date)}{point.live ? ' (hôm nay, theo giá mới nhất)' : ''}</span><span>{money(point.aum)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Panel>
  );
}

function HoldingCard({ item }: { item: Holding }) {
  const deposit = item.assetClass === 'TERM_DEPOSIT';
  return (
    <li className="rounded-lg border bg-card px-3.5 py-3">
      <p className="m-0 mb-2 font-semibold break-words">{item.assetName} <span className="font-normal text-muted-foreground">({item.assetCode})</span></p>
      <Facts>
        <Fact label="Loại">{classLabels[item.assetClass] ?? item.assetClass}</Fact>
        {deposit ? <Fact label="Tiền gốc">{money(item.principal)}</Fact> : <Fact label="Số lượng">{plainNumber(item.quantity)}</Fact>}
        {deposit ? <Fact label="Lãi dồn tích">{item.accruedInterest ? money(item.accruedInterest) : 'Chưa có dữ liệu'}</Fact> : <Fact label="Giá gần nhất">{item.unitPrice ? `${plainNumber(item.unitPrice)} ₫` : 'Chưa có giá'}</Fact>}
        <Fact label="Giá vốn">{money(item.cost)}</Fact>
        <Fact label="Giá trị hiện tại">{item.value ? money(item.value) : 'Chưa có giá'}</Fact>
        <Fact label="Lãi/lỗ chưa thực hiện">{item.unrealizedPnl ? money(item.unrealizedPnl) : 'Chưa có dữ liệu'}</Fact>
        {item.maturityDate ? <Fact label="Ngày đáo hạn">{dayText(item.maturityDate)}</Fact> : null}
      </Facts>
      {item.priceStale ? <Badge variant="wait">Giá chưa cập nhật, tạm tính theo giá gần nhất</Badge> : null}
    </li>
  );
}

/** UC-11 panels, shared by the customer's own screen and the staff screens. Suggested amounts are for staff (UC-12). */
export function PortfolioPanels({ path, showSuggestions = false }: { path: string; showSuggestions?: boolean }) {
  const portfolio = useLoad(signal => api<PortfolioData>(path, { signal }), [path]);
  const data = portfolio.data;
  return (
    <>
      <Panel title="Danh mục đầu tư">
        {portfolio.loading && !data ? <Loading /> : null}
        {portfolio.error ? <ErrorAlert>{describe(portfolio.error, { '404': 'Khách hàng chưa có tài khoản đầu tư.' })} <AlertAction onClick={portfolio.reload}>Thử lại</AlertAction></ErrorAlert> : null}
        {data ? (
          <>
            <p className="mb-1 text-[1.8rem] leading-tight font-bold tabular-nums" data-testid="portfolio-aum">{money(data.aum)}</p>
            <p className="mb-3 text-muted-foreground">Tổng tài sản theo giá mới nhất, tính đến ngày {dayText(data.asOf)}</p>
            <Facts>
              <Fact label="Tiền mặt khả dụng">{money(data.cash)}</Fact>
              <Fact label="Tiền gửi">{money(data.depositValue)}</Fact>
              <Fact label="Trái phiếu">{money(data.bondValue)}</Fact>
              <Fact label="Chứng chỉ quỹ">{money(data.fundValue)}</Fact>
              <Fact label="Giá vốn">{money(data.totalCost)}</Fact>
              <Fact label="Lãi/lỗ chưa thực hiện">{money(data.unrealizedPnl)}</Fact>
            </Facts>
            {data.dataStatus === 'INCOMPLETE' ? <Alert variant="warning" className="mt-3 px-3.5 py-2.5"><TriangleAlert aria-hidden="true" />Có khoản chưa có giá nên chưa được tính vào tổng tài sản.</Alert> : null}
            {data.hasStalePrice ? <Alert variant="warning" className="mt-3 px-3.5 py-2.5"><TriangleAlert aria-hidden="true" />Giá chưa cập nhật, tạm tính theo giá gần nhất.</Alert> : null}
          </>
        ) : null}
      </Panel>
      {data ? (
        <>
          <Panel title="Tỷ trọng so với mục tiêu">
            {data.allocation.every(row => row.actualWeight === null) ? <Empty>Chưa có tài sản để tính tỷ trọng.</Empty> : (
              <ul className="m-0 grid list-none gap-2 p-0">
                {data.allocation.map(row => (
                  <li key={row.allocationClass} className="rounded-lg border bg-card px-3.5 py-2.5">
                    <p className="m-0 flex flex-wrap items-center gap-x-2 font-semibold">{classLabels[row.allocationClass]}{row.drifted ? <Badge variant="wait">Lệch mục tiêu</Badge> : null}</p>
                    <p className="m-0 tabular-nums">Thực tế {row.actualWeight ? percent(row.actualWeight) : 'chưa có'} · Mục tiêu {row.targetWeight ? percent(row.targetWeight) : 'chưa có'}</p>
                    {showSuggestions && row.suggestedAmount ? <p className="m-0 text-[0.92rem] text-muted-foreground">Gợi ý: {row.direction === 'INCREASE' ? 'tăng' : 'giảm'} {money(row.suggestedAmount)}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Các khoản đang nắm giữ">
            {data.items.length === 0 ? <Empty>Chưa nắm giữ sản phẩm nào.</Empty> : <ul className="m-0 grid list-none gap-2 p-0">{data.items.map(item => <HoldingCard key={item.holdingId} item={item} />)}</ul>}
          </Panel>
          <History path={path} />
        </>
      ) : null}
    </>
  );
}

export function Portfolio() {
  return (
    <>
      <PageTitle title="Danh mục của tôi" hint="Giá trị tài sản theo giá thị trường mới nhất và tỷ trọng so với mục tiêu." />
      <PortfolioPanels path="/me/portfolio" />
    </>
  );
}

/** The leader's view of a customer in their team. */
export function TeamCustomerPortfolio({ customerId }: { customerId: string }) {
  return (
    <>
      <p className="mb-3 text-[0.9rem]"><a href="#/assignments">Quay lại phân công</a></p>
      <PageTitle title="Danh mục của khách" />
      <PortfolioPanels path={`/customers/${customerId}/portfolio`} showSuggestions />
    </>
  );
}

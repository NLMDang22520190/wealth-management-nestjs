import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { activateRisk, actors, registerCustomer, resetBusinessState, sql } from './support/stack';
import { expectNoHorizontalOverflow, goTo, openApp, switchRole } from './support/ui';

/** UC-09 to UC-12 through the UI. Holdings are fixtures: UC-16 owns writing them. */
const BACK_OFFICE = 'NV0004';
const MANAGER = 'NV0005';

async function addFund(page: Page, code: string) {
  await goTo(page, 'Sản phẩm');
  await page.getByLabel('Mã sản phẩm').fill(code);
  await page.getByLabel('Tên sản phẩm').fill('Quỹ mẫu');
  await page.getByLabel('Công ty quản lý quỹ').fill('Công ty mẫu');
  await page.getByLabel('NAV ban đầu (VND)').fill('20000');
  await page.getByRole('button', { name: 'Thêm sản phẩm' }).click();
  await expect(page.getByRole('status').filter({ hasText: `Đã thêm sản phẩm ${code}` })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Sản phẩm hiện có' })).toContainText(code);
}

async function hold(customerId: string, code: string, quantity: string) {
  await sql(`INSERT INTO wms.portfolio_holdings(account_id,asset_id,quantity,avg_cost)
    SELECT ia.account_id,a.asset_id,$3,20000 FROM wms.investment_accounts ia,wms.assets a WHERE ia.customer_id=$1 AND a.asset_code=$2`, [customerId, code, quantity]);
}

test.describe('UC13 P3 products, prices and portfolio', () => {
  let customerId: string;
  test.beforeEach(async () => {
    await resetBusinessState();
    customerId = (await registerCustomer(actors.customerAlpha, actors.customerAlpha)).customerId;
    await activateRisk(actors.customerAlpha, 2);
  });

  test('a price above 20% waits for the manager; after approval the customer, RM and leader see the new value and the alert', async ({ page }) => {
    await openApp(page);
    await switchRole(page, BACK_OFFICE);
    await addFund(page, 'FUND-E2E');
    await expectNoHorizontalOverflow(page);
    await hold(customerId, 'FUND-E2E', '10000');

    await goTo(page, 'Giá và NAV');
    await page.getByLabel('Sản phẩm', { exact: true }).selectOption({ label: 'FUND-E2E · Chứng chỉ quỹ' });
    await page.getByLabel('Giá trị mới').fill('30000');
    await page.getByRole('button', { name: 'Lưu giá' }).click();
    const result = page.getByRole('region', { name: 'Kết quả nhập giá' });
    await expect(result).toContainText('chờ Quản lý duyệt');
    await expect(result.getByRole('heading', { name: 'Kết quả nhập giá' })).toBeFocused();
    await expect(page.getByRole('region', { name: 'Giá đang chờ duyệt' })).toContainText('FUND-E2E');
    await expectNoHorizontalOverflow(page);

    // Not approved yet: the old NAV still values the holding.
    await switchRole(page, actors.customerAlpha);
    await goTo(page, 'Danh mục');
    await expect(page.getByTestId('portfolio-aum')).toContainText('200.000.000');

    await switchRole(page, MANAGER);
    await page.getByRole('button', { name: 'Xử lý giá FUND-E2E' }).click();
    const dialog = page.getByRole('dialog', { name: 'Duyệt giá' });
    await dialog.getByRole('button', { name: 'Duyệt giá' }).click();
    await expect(dialog.getByLabel('Lý do')).toBeFocused();
    await dialog.getByLabel('Lý do').fill('Đã đối chiếu với công ty quản lý quỹ');
    await dialog.getByRole('button', { name: 'Duyệt giá' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Đã duyệt giá FUND-E2E' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Giá cần duyệt' })).toContainText('Không có giá nào cần duyệt');
    await expectNoHorizontalOverflow(page);

    await switchRole(page, actors.customerAlpha);
    await goTo(page, 'Danh mục');
    await expect(page.getByTestId('portfolio-aum')).toContainText('300.000.000');
    await expect(page.getByRole('region', { name: 'Các khoản đang nắm giữ' })).toContainText('FUND-E2E');
    await expect(page.getByRole('region', { name: 'Tỷ trọng so với mục tiêu' })).toContainText('Lệch mục tiêu');
    await expect(page.getByRole('img', { name: /Biểu đồ tổng tài sản/ })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await switchRole(page, actors.rmAlpha);
    await goTo(page, 'Cảnh báo lệch');
    const alerts = page.getByRole('region', { name: 'Cảnh báo lệch tỷ trọng' });
    await expect(alerts).toContainText('Chứng chỉ quỹ');
    await expect(alerts).toContainText('Giảm 195.000.000');
    await alerts.getByRole('button', { name: /Đánh dấu đã đọc: .*Chứng chỉ quỹ/ }).click();
    await expect(alerts.getByRole('listitem').filter({ hasText: 'Chứng chỉ quỹ' })).toContainText('Đã đọc');
    await expectNoHorizontalOverflow(page);

    await page.evaluate(id => { window.location.hash = `#/rm/customers/${id}`; }, customerId);
    await expect(page.getByRole('region', { name: 'Danh mục đầu tư' })).toContainText('300.000.000');
    await expect(page.getByRole('region', { name: 'Cảnh báo lệch tỷ trọng' })).toContainText('Chứng chỉ quỹ');

    await switchRole(page, actors.leader);
    await page.evaluate(id => { window.location.hash = `#/team/customers/${id}`; }, customerId);
    await expect(page.getByRole('region', { name: 'Danh mục đầu tư' })).toContainText('300.000.000');
  });

  test('product form errors, CSV results per row, and the demo snapshot', async ({ page }) => {
    await openApp(page);
    await switchRole(page, BACK_OFFICE);
    await goTo(page, 'Sản phẩm');
    await page.getByRole('button', { name: 'Thêm sản phẩm' }).click();
    const code = page.getByLabel('Mã sản phẩm');
    await expect(code).toBeFocused();
    await expect(code).toHaveAttribute('aria-invalid', 'true');
    await addFund(page, 'FUND-CSV');
    await page.getByLabel('Mã sản phẩm').fill('FUND-CSV');
    await page.getByLabel('Tên sản phẩm').fill('Trùng mã');
    await page.getByLabel('Công ty quản lý quỹ').fill('Công ty mẫu');
    await page.getByRole('button', { name: 'Thêm sản phẩm' }).click();
    await expect(page.getByText('Mã sản phẩm đã tồn tại.')).toBeVisible();
    await hold(customerId, 'FUND-CSV', '100');

    await goTo(page, 'Giá và NAV');
    await page.getByLabel('Nội dung CSV').fill('assetCode,value,effectiveDate\nFUND-CSV,20500,\nKHONG-CO,100,\n');
    await page.getByRole('button', { name: 'Nhập từ CSV' }).click();
    const region = page.getByRole('region', { name: 'Nhập giá từ CSV' });
    await expect(region).toContainText('Dòng 2, FUND-CSV: Đã áp dụng');
    await expect(region).toContainText('Dòng 3, KHONG-CO: Lỗi (Không tìm thấy sản phẩm.)');
    await expect(region).toContainText('Quét lệch: 1 khách');
    await expectNoHorizontalOverflow(page);

    await page.getByRole('button', { name: 'Chạy chụp danh mục' }).click();
    await expect(page.getByTestId('snapshot-result')).toContainText('1 khách');
    await expect.poll(async () => (await sql<{ aum: string }>("SELECT aum::text AS aum FROM wms.portfolio_snapshots WHERE snapshot_kind='DAILY'")).map(row => row.aum)).toEqual(['2050000.00']);
  });

  test('the RM asks for a rebalancing proposal from an alert: it leaves the open list and the request is recorded for P4', async ({ page }) => {
    await openApp(page);
    await switchRole(page, BACK_OFFICE);
    await addFund(page, 'FUND-REB');
    await hold(customerId, 'FUND-REB', '10000');
    await goTo(page, 'Giá và NAV');
    await page.getByRole('button', { name: 'Chạy chụp danh mục' }).click();
    await expect(page.getByTestId('snapshot-result')).toContainText('1 khách');

    await switchRole(page, actors.rmAlpha);
    await goTo(page, 'Cảnh báo lệch');
    const alerts = page.getByRole('region', { name: 'Cảnh báo lệch tỷ trọng' });
    const fundAlert = alerts.getByRole('listitem').filter({ hasText: 'Chứng chỉ quỹ' });
    await expect(fundAlert).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await fundAlert.getByRole('button', { name: /^Tạo đề xuất tái cân bằng: .*Chứng chỉ quỹ$/ }).click();
    await expect(page.getByRole('status').filter({ hasText: /^Đã tạo đề xuất tái cân bằng: .*Chứng chỉ quỹ$/ })).toBeVisible();
    await expect(alerts.getByRole('listitem').filter({ hasText: 'Chứng chỉ quỹ' })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    expect(await sql<{ status: string }>("SELECT status::text AS status FROM wms.drift_alerts WHERE allocation_class='MUTUAL_FUND'")).toEqual([{ status: 'ACTIONED' }]);
    expect(await sql<{ n: number }>("SELECT count(*)::int AS n FROM wms.outbox_events WHERE event_type='RebalanceProposalRequested'")).toEqual([{ n: 1 }]);
  });
});

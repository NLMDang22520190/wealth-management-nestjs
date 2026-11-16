import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { activateRisk, actors, api, registerCustomer, resetBusinessState, sql, tokenFor } from './support/stack';
import { expectNoHorizontalOverflow, goTo, openApp, readDemoInbox, switchRole, typeOtp } from './support/ui';

/** UC-13 to UC-16 through the UI: drift alert → proposal → Smart OTP approval → new portfolio; then a reject and a cancel. */
const FUND = 'FUND-E2E4';

async function setUp() {
  const { customerId } = await registerCustomer(actors.customerAlpha, actors.customerAlpha);
  await activateRisk(actors.customerAlpha, 2); // Cân bằng: products up to risk level 3
  // Cash without going through Core: E2E of P2 covers deposits.
  await sql('UPDATE wms.investment_accounts SET balance=100000000 WHERE customer_id=$1', [customerId]);
  const created = await api('/back-office/assets', { token: await tokenFor('NV0004'), key: `e2e-asset-${randomUUID()}`, body: {
    assetClass: 'MUTUAL_FUND', assetCode: FUND, assetName: 'Quỹ cân bằng mẫu', riskLevel: 2, minInvestment: '1000000', fundType: 'BALANCED', fundManager: 'Công ty mẫu', initialPrice: '20000' } });
  expect(created.status).toBe(201);
  return { customerId, assetId: created.body.assetId as string };
}

async function proposeViaApi(customerId: string, assetId: string) {
  const response = await api(`/customers/${customerId}/proposals`, { token: await tokenFor(actors.rmAlpha), key: `e2e-proposal-${randomUUID()}`,
    body: { legs: [{ action: 'BUY', assetId, quantity: '100' }] } });
  expect(response.status).toBe(201);
  return response.body.proposalCode as string;
}

async function openMine(page: Page) {
  await switchRole(page, actors.customerAlpha);
  await goTo(page, 'Đề xuất đầu tư');
  await expect(page.getByRole('region', { name: 'Đề xuất của tôi' })).toBeVisible();
}

test.describe('UC14 P4 proposals', () => {
  test.beforeEach(async () => { await resetBusinessState(); });

  test('RM proposes from a drift alert; the customer approves with OTP and sees the new holding', async ({ page }) => {
    await setUp();
    const run = await api('/demo/jobs/portfolio-snapshot', { token: await tokenFor('NV0004'), body: {} });
    expect(run.status).toBe(200);

    await openApp(page);
    await switchRole(page, actors.rmAlpha);
    await goTo(page, 'Cảnh báo lệch');
    await page.getByRole('link', { name: /^Tạo đề xuất tái cân bằng: .*Chứng chỉ quỹ$/ }).click();
    await page.getByLabel('Tài sản 1').selectOption({ label: `${FUND} · mức 2` });
    await page.getByLabel('Số lượng 1').fill('1750');
    await expect(page.getByText('Tổng mua ước tính')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.getByRole('button', { name: 'Gửi đề xuất' }).click();
    const done = page.getByRole('region', { name: 'Đã tạo đề xuất' });
    await expect(done).toContainText('chờ duyệt trong 24 giờ');
    await expect(done.getByRole('heading', { name: 'Đã tạo đề xuất' })).toBeFocused();

    await openMine(page);
    await page.getByRole('button', { name: /^Phê duyệt PROP-/ }).click();
    const code = await readDemoInbox(page);
    await typeOtp(page, code);
    await page.getByRole('button', { name: 'Xác nhận OTP' }).click();
    const result = page.getByRole('region', { name: 'Kết quả duyệt' });
    await expect(result).toContainText('đã được khớp lệnh');
    await expect(result.getByRole('heading', { name: 'Kết quả duyệt' })).toBeFocused();
    await expect(page.getByRole('region', { name: 'Đề xuất của tôi' })).toContainText('Đã khớp lệnh');
    await expectNoHorizontalOverflow(page);

    await goTo(page, 'Danh mục');
    await expect(page.getByRole('region', { name: 'Các khoản đang nắm giữ' })).toContainText(FUND);
  });

  test('the customer rejects one proposal; the RM cancels another with a reason', async ({ page }) => {
    const { customerId, assetId } = await setUp();
    const first = await proposeViaApi(customerId, assetId);

    await openApp(page);
    await openMine(page);
    await page.getByRole('button', { name: `Từ chối ${first}` }).click();
    const rejectDialog = page.getByRole('dialog', { name: 'Từ chối đề xuất' });
    await rejectDialog.getByRole('button', { name: 'Xác nhận từ chối' }).click();
    await expect(rejectDialog.getByLabel('Lý do từ chối')).toBeFocused();
    await rejectDialog.getByLabel('Lý do từ chối').fill('Chưa phù hợp thời điểm');
    await rejectDialog.getByRole('button', { name: 'Xác nhận từ chối' }).click();
    await expect(page.getByRole('status').filter({ hasText: `Đã từ chối đề xuất ${first}` })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Đề xuất của tôi' })).toContainText('Khách từ chối');

    const second = await proposeViaApi(customerId, assetId);
    await switchRole(page, actors.rmAlpha);
    await page.evaluate(id => { window.location.hash = `#/rm/customers/${id}`; }, customerId);
    const panel = page.getByRole('region', { name: 'Đề xuất đầu tư' });
    await panel.getByRole('button', { name: `Hủy đề xuất ${second}` }).click();
    const cancelDialog = page.getByRole('dialog', { name: 'Hủy đề xuất' });
    await cancelDialog.getByLabel('Lý do hủy').fill('ngắn');
    await cancelDialog.getByRole('button', { name: 'Xác nhận hủy' }).click();
    await expect(cancelDialog.getByLabel('Lý do hủy')).toBeFocused();
    await expect(cancelDialog.getByLabel('Lý do hủy')).toHaveAttribute('aria-invalid', 'true');
    await cancelDialog.getByLabel('Lý do hủy').fill('Biến động giá thị trường, cần điều chỉnh');
    await cancelDialog.getByRole('button', { name: 'Xác nhận hủy' }).click();
    await expect(panel.getByRole('status').filter({ hasText: `Đã hủy đề xuất ${second}` })).toBeVisible();
    await expect(panel).toContainText('RM đã hủy');
    await expectNoHorizontalOverflow(page);
  });
});

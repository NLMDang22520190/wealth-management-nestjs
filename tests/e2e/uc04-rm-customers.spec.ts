import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { activateRisk, addHolding, addPendingProposal, api, ids, registerCustomer, resetBusinessState, sql, tokenFor, transferViaApi, vnDate } from './support/stack';
import { expectNoHorizontalOverflow, goTo, openApp, switchRole } from './support/ui';

test.describe('UC04 RM customers journey (AC07 + AC02)', () => {
  let alphaId: string;
  let betaId: string;
  test.beforeEach(async () => {
    await resetBusinessState();
    alphaId = (await registerCustomer('00000101', 'customer-alpha')).customerId;
    betaId = (await registerCustomer('00000102', 'customer-beta')).customerId;
    await activateRisk('customer-alpha', 2); // BALANCED
    await activateRisk('customer-beta', 4); // GROWTH
    await addPendingProposal(alphaId);
  });

  async function openList(page: Page) {
    await openApp(page);
    await switchRole(page, 'rm-alpha');
    await goTo(page, 'Khách phụ trách');
  }
  const row = (page: Page, name: string) => page.getByRole('row', { name: new RegExp(name) });

  test('AC07 RM sees a paged customer list with name and risk filters and AUM sorting', async ({ page }) => {
    await addHolding(alphaId, 'e2e-fund-a', '900000.00', '2026-01-15T04:00:00.000Z');
    await addHolding(betaId, 'e2e-fund-b', '300000.00', '2026-01-15T04:00:00.000Z');
    await openList(page);
    await expect(page.getByText('Tổng: 2 khách hàng')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Phân trang' })).toBeVisible();
    await expect(row(page, 'Khách hàng demo Alpha')).toBeVisible();
    await expect(row(page, 'Khách hàng demo Beta')).toBeVisible();

    await page.getByLabel('Tìm theo tên').fill('Alpha');
    await expect(row(page, 'Khách hàng demo Alpha')).toBeVisible();
    await expect(row(page, 'Khách hàng demo Beta')).toHaveCount(0);
    await page.getByLabel('Tìm theo tên').fill('Không-tồn-tại');
    await expect(page.getByText('Không có khách hàng phù hợp')).toBeVisible(); // empty state
    await page.getByLabel('Tìm theo tên').fill('');

    await page.getByLabel('Mức rủi ro').selectOption('GROWTH');
    await expect(row(page, 'Khách hàng demo Beta')).toBeVisible();
    await expect(row(page, 'Khách hàng demo Alpha')).toHaveCount(0);
    await page.getByLabel('Mức rủi ro').selectOption('');

    await page.getByLabel('Sắp xếp theo').selectOption('aum');
    await page.getByLabel('Thứ tự').selectOption('desc');
    await expect(page.getByRole('row').nth(1)).toContainText('Khách hàng demo Alpha');
    await page.getByLabel('Thứ tự').selectOption('asc');
    await expect(page.getByRole('row').nth(1)).toContainText('Khách hàng demo Beta');
    await expectNoHorizontalOverflow(page);
  });

  test('AC07 customer detail shows risk, expiry, decimal-exact AUM with asOf and provenance, and pending proposals', async ({ page }) => {
    await addHolding(alphaId, 'e2e-fund-a', '1250000.50', '2026-01-15T04:59:00.000Z');
    await openList(page);
    await page.getByRole('link', { name: 'Khách hàng demo Alpha' }).click();
    await expect(page.getByRole('heading', { name: 'Khách hàng demo Alpha' })).toBeVisible();
    const profile = await api('/me/risk-profile', { token: await tokenFor('customer-alpha') });
    await expect(page.getByText('Hồ sơ rủi ro: Cân bằng')).toBeVisible();
    await expect(page.getByText(`Hết hạn: ${vnDate(profile.body.current.expiresAt)}`)).toBeVisible();
    const aum = page.getByRole('region', { name: 'Tài sản quản lý (AUM)' });
    await expect(aum).toContainText('1.250.000,50');
    await expect(aum).toContainText('Tại thời điểm: 15/01/2026');
    await expect(aum).toContainText('Nguồn: SYNTHETIC_P3_READ_BRIDGE');
    await expect(page.getByText('Đề xuất chờ duyệt: 1')).toBeVisible();

    // Unavailable valuation is labelled, never rendered as zero.
    await page.getByRole('link', { name: 'Quay lại danh sách' }).click();
    await page.getByRole('link', { name: 'Khách hàng demo Beta' }).click();
    const unavailable = page.getByRole('region', { name: 'Tài sản quản lý (AUM)' });
    await expect(unavailable).toContainText('Chưa có dữ liệu');
    await expect(unavailable).not.toContainText(/(^|\s)0([,.]00)?\s*(₫|VND)/);
    await expectNoHorizontalOverflow(page);
  });

  test('AC07/AC02 after a transfer the old RM loses the customer in the UI and the server still answers 403', async ({ page }) => {
    await openList(page);
    await page.getByRole('link', { name: 'Khách hàng demo Alpha' }).click();
    await expect(page.getByRole('heading', { name: 'Khách hàng demo Alpha' })).toBeVisible();

    expect((await transferViaApi(alphaId, ids.rmBeta, 1)).status).toBe(200);
    const direct = await api(`/customers/${alphaId}`, { token: await tokenFor('rm-alpha') });
    expect(direct.status).toBe(403); // server guard, independent of React

    await page.getByRole('button', { name: 'Làm mới' }).click();
    await expect(page.getByRole('alert')).toContainText('Bạn không có quyền truy cập khách hàng này');
    await expect(page.getByText('Khách hàng demo Alpha')).toHaveCount(0); // cached data removed from the screen

    await page.evaluate(id => { location.hash = `#/rm/customers/${id}`; }, alphaId); // direct detail URL, session kept in memory
    await expect(page.getByRole('alert')).toContainText('Bạn không có quyền truy cập khách hàng này');
    await goTo(page, 'Khách phụ trách');
    await expect(row(page, 'Khách hàng demo Beta')).toBeVisible();
    await expect(row(page, 'Khách hàng demo Alpha')).toHaveCount(0);
    expect((await sql('SELECT rm_id FROM rm_assignment_history WHERE customer_id=$1 AND valid_to IS NULL', [alphaId]))[0]).toEqual({ rm_id: ids.rmBeta });
    await expectNoHorizontalOverflow(page);
  });
});

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { activateRisk, addPendingProposal, ids, registerCustomer, resetBusinessState, sql, transferViaApi } from './support/stack';
import { expectNoHorizontalOverflow, goTo, openApp, switchRole } from './support/ui';

test.describe('UC03 leader assignment journey (AC07)', () => {
  let alphaId: string;
  test.beforeEach(async () => {
    await resetBusinessState();
    alphaId = (await registerCustomer('00000101', 'customer-alpha')).customerId;
    await registerCustomer('00000102', 'customer-beta');
    await activateRisk('customer-alpha', 2);
    await activateRisk('customer-beta', 2);
    await addPendingProposal(alphaId);
  });

  async function loadCustomer(page: Page) {
    // F3: the leader picks from the team's customers by name; no UUID typing.
    await expect(page.getByLabel('Mã khách hàng')).toHaveCount(0);
    const picker = page.getByLabel('Chọn khách hàng');
    await expect(picker.getByRole('option', { name: /Khách hàng demo Alpha/ })).toHaveCount(1);
    await expect(picker.getByRole('option', { name: /Khách hàng demo Beta/ })).toHaveCount(1);
    await picker.selectOption(alphaId);
    await page.getByRole('button', { name: 'Tải thông tin khách hàng' }).click();
    await expect(page.getByText('Khách hàng demo Alpha')).toBeVisible();
  }

  test('AC07 leader sees RM capacity x/80 and transfers a customer with a reason', async ({ page }) => {
    await openApp(page);
    await switchRole(page, 'leader-alpha');
    await goTo(page, 'Phân công RM');
    const directory = page.getByRole('region', { name: 'Danh sách RM' });
    await expect(directory.getByRole('row', { name: new RegExp(ids.rmAlpha) })).toContainText('2/80');
    await expect(directory.getByRole('row', { name: new RegExp(ids.rmBeta) })).toContainText('0/80');

    await loadCustomer(page);
    await expect(page.getByText('Phiên bản phân công: 1')).toBeVisible();
    // F4: two more pending proposals appear after the page loaded the customer; only the server knows the real count (1 + 2 = 3).
    await addPendingProposal(alphaId);
    await addPendingProposal(alphaId);
    await page.getByLabel('RM nhận').selectOption(ids.rmBeta);
    await page.getByRole('button', { name: 'Xác nhận chuyển' }).click();
    await expect(page.getByRole('alert')).toContainText('Vui lòng nhập lý do chuyển'); // validation, nothing sent
    expect(await sql("SELECT id FROM rm_assignment_history WHERE reason IS NOT NULL")).toHaveLength(0);

    await page.getByLabel('Lý do chuyển').fill('Cân đối tải công việc giữa các RM');
    await page.getByRole('button', { name: 'Xác nhận chuyển' }).click();
    await expect(page.getByText('Đã chuyển khách hàng')).toBeVisible();
    await expect(page.getByText('đề xuất đang chờ duyệt của khách đã bị hủy', { exact: false })).toBeVisible();
    await expect(page.getByText('3 đề xuất đang chờ duyệt của khách đã bị hủy', { exact: false })).toBeVisible(); // exact server count
    await expect(directory.getByRole('row', { name: new RegExp(ids.rmAlpha) })).toContainText('1/80');
    await expect(directory.getByRole('row', { name: new RegExp(ids.rmBeta) })).toContainText('1/80');
    const current = await sql<{ rm_id: string; reason: string }>('SELECT rm_id,reason FROM rm_assignment_history WHERE customer_id=$1 AND valid_to IS NULL', [alphaId]);
    expect(current).toEqual([{ rm_id: ids.rmBeta, reason: 'Cân đối tải công việc giữa các RM' }]);
    expect(await sql("SELECT id FROM proposals WHERE customer_id=$1 AND status='PENDING_APPROVAL'", [alphaId])).toHaveLength(0);
    await expectNoHorizontalOverflow(page);
  });

  test('AC07 a stale assignment version shows a visible conflict message and refresh loads the current assignment', async ({ page }) => {
    await openApp(page);
    await switchRole(page, 'leader-alpha');
    await goTo(page, 'Phân công RM');
    await loadCustomer(page);
    await expect(page.getByText('Phiên bản phân công: 1')).toBeVisible();

    // Someone else transfers the same customer after the leader loaded version 1.
    expect((await transferViaApi(alphaId, ids.rmBeta, 1)).status).toBe(200);

    await page.getByLabel('RM nhận').selectOption(ids.rmBeta);
    await page.getByLabel('Lý do chuyển').fill('Chuyển với phiên bản đã cũ');
    await page.getByRole('button', { name: 'Xác nhận chuyển' }).click();
    await expect(page.getByRole('alert')).toContainText('Phân công đã thay đổi');
    await page.getByRole('button', { name: 'Tải lại' }).click();
    await expect(page.getByText('Phiên bản phân công: 2')).toBeVisible();
    const rows = await sql('SELECT id FROM rm_assignment_history WHERE customer_id=$1', [alphaId]);
    expect(rows).toHaveLength(2); // the stale request created no extra assignment (original + one API transfer)
    await expectNoHorizontalOverflow(page);
  });
});

import { expect, test } from '@playwright/test';
import { api, resetBusinessState, sql, tokenFor } from './support/stack';
import { differentCode, expectNoHorizontalOverflow, goTo, openApp, readDemoInbox, switchRole } from './support/ui';

test.describe('UC01 onboarding journey (AC07 + AC02)', () => {
  test.beforeEach(async () => { await resetBusinessState(); });

  test('AC07 RM looks up a synthetic CIF, selects an own VND account and creates an invitation', async ({ page }) => {
    await openApp(page);
    await switchRole(page, 'rm-alpha');
    await goTo(page, 'Đăng ký khách hàng');

    await page.getByLabel('Mã CIF hoặc định danh').fill('synthetic-unknown-cif');
    await page.getByRole('button', { name: 'Tra cứu' }).click();
    await expect(page.getByRole('alert')).toContainText('Không tìm thấy khách hàng'); // CUSTOMER_NOT_FOUND error state

    await page.getByLabel('Mã CIF hoặc định danh').fill('00000101');
    await page.getByRole('button', { name: 'Tra cứu' }).click();
    await expect(page.getByText('Khách hàng demo Alpha')).toBeVisible();
    await expect(page.getByText('Đủ điều kiện')).toBeVisible();
    const account = page.getByRole('radio', { name: /synthetic-vnd-account-101/ });
    await expect(account).toBeVisible();
    await account.check();
    await page.getByRole('button', { name: 'Tạo lời mời' }).click();
    await expect(page.getByText('Đã tạo lời mời')).toBeVisible();
    await expect(page.getByText('Chờ khách hàng đồng ý')).toBeVisible();

    const inbox = await api('/me/onboarding-requests', { token: await tokenFor('customer-alpha') });
    expect(inbox.body.items).toEqual([expect.objectContaining({ status: 'PENDING_CONSENT' })]);
    await expectNoHorizontalOverflow(page);
  });

  test('AC07/AC02 customer reads terms, requests OTP, rejects a wrong OTP, then confirms explicitly with the demo OTP', async ({ page }) => {
    const rmToken = await tokenFor('rm-alpha');
    const created = await api('/onboarding/requests', { token: rmToken, key: 'e2e-uc01-setup',
      body: { cifRef: '00000101', selectedAccountId: 'synthetic-vnd-account-101' } });
    expect(created.status).toBe(201);

    await openApp(page);
    await switchRole(page, 'customer-alpha');
    await goTo(page, 'Lời mời dịch vụ');
    await expect(page.getByText('Chờ đồng ý')).toBeVisible();
    await page.getByRole('button', { name: 'Xem điều khoản' }).click();
    const terms = page.getByRole('region', { name: 'Điều khoản dịch vụ' });
    await expect(terms).toBeVisible();
    expect((await terms.innerText()).trim().length).toBeGreaterThan(40);

    await page.getByLabel('Tôi đã đọc và đồng ý với điều khoản').check();
    await page.getByRole('button', { name: 'Gửi mã OTP' }).click();
    const code = await readDemoInbox(page);

    // No autofill / auto-confirm: the user must type and confirm.
    await expect(page.getByLabel('Mã OTP')).toHaveValue('');
    expect(await sql('SELECT id FROM wealth_services')).toHaveLength(0);

    await page.getByLabel('Mã OTP').fill(differentCode(code));
    await page.getByRole('button', { name: 'Xác nhận đồng ý' }).click();
    await expect(page.getByRole('alert')).toContainText('Mã OTP không đúng');
    expect(await sql('SELECT id FROM wealth_services')).toHaveLength(0);

    await page.getByLabel('Mã OTP').fill(code);
    await page.getByRole('button', { name: 'Xác nhận đồng ý' }).click();
    await expect(page.getByText('Đã đồng ý dịch vụ')).toBeVisible();
    await expect(page.getByText('Chờ đánh giá rủi ro')).toBeVisible();
    const services = await sql<{ status: string }>('SELECT status FROM wealth_services');
    expect(services).toEqual([{ status: 'PENDING_RISK_ASSESSMENT' }]);
    await expectNoHorizontalOverflow(page);
  });
});

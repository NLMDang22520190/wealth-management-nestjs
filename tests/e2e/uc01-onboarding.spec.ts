import { expect, test } from '@playwright/test';
import { api, resetBusinessState, sql, tokenFor } from './support/stack';
import { differentCode, expectNoHorizontalOverflow, expectOtpEmpty, goTo, openApp, otpBox, readDemoInbox, switchRole, typeOtp } from './support/ui';

test.describe('UC01 onboarding journey (AC07 + AC02)', () => {
  test.beforeEach(async () => { await resetBusinessState(); });

  test('AC07 RM looks up a synthetic CIF, selects an own VND account and creates an invitation', async ({ page }) => {
    await openApp(page);
    await switchRole(page, 'rm-alpha');
    await goTo(page, 'Đăng ký khách hàng');

    // S10 B13 AC3: stepper `Tiến trình đăng ký`, active step has aria-current="step" and moves forward.
    const stepper = page.getByRole('list', { name: 'Tiến trình đăng ký' });
    await expect(stepper.getByRole('listitem')).toHaveCount(3);
    for (const step of ['Tra cứu', 'Chọn tài khoản', 'Gửi lời mời']) await expect(stepper.getByRole('listitem').filter({ hasText: step })).toHaveCount(1);
    await expect(stepper.locator('[aria-current="step"]')).toHaveCount(1);
    await expect(stepper.locator('[aria-current="step"]')).toContainText('Tra cứu');

    await page.getByLabel('Mã CIF hoặc định danh').fill('synthetic-unknown-cif');
    await page.getByRole('button', { name: 'Tra cứu' }).click();
    await expect(page.getByRole('alert')).toContainText('Không tìm thấy khách hàng'); // CUSTOMER_NOT_FOUND error state

    await page.getByLabel('Mã CIF hoặc định danh').fill('00000101');
    await page.getByRole('button', { name: 'Tra cứu' }).click();
    await expect(page.getByText('Khách hàng demo Alpha')).toBeVisible();
    await expect(page.getByText('Đủ điều kiện')).toBeVisible();
    await expect(stepper.locator('[aria-current="step"]')).toContainText('Chọn tài khoản'); // lookup done, now pick an account
    const account = page.getByRole('radio', { name: /synthetic-vnd-account-101/ });
    await expect(account).toBeVisible();
    await account.check();
    await expect(stepper.locator('[aria-current="step"]')).toContainText('Gửi lời mời'); // account chosen, ready to send
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

    // No autofill / auto-confirm: the six boxes stay empty until the user types.
    await expectOtpEmpty(page);
    for (let position = 1; position <= 6; position++) {
      const box = otpBox(page, position);
      await expect(box).toHaveAttribute('maxlength', '1');
      await expect(box).toHaveAttribute('inputmode', 'numeric');
    }
    expect(await sql('SELECT id FROM wealth_services')).toHaveLength(0);
    // Resend control: a countdown first (not waited out), the button only after it ends.
    await expect(page.getByText(/Gửi lại mã sau \d+s/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Gửi lại mã' })).toHaveCount(0);

    const confirm = page.getByRole('button', { name: 'Xác nhận đồng ý' });
    // Typing a digit moves focus on; Backspace on an empty box moves focus back.
    await otpBox(page, 1).click();
    await page.keyboard.type('1');
    await expect(otpBox(page, 2)).toBeFocused();
    await page.keyboard.press('Backspace'); // box 2 is empty: go back to box 1
    await expect(otpBox(page, 1)).toBeFocused();
    // Pasting a 6-digit code into the first box fills all six.
    await otpBox(page, 1).evaluate((input, text) => {
      const data = new DataTransfer(); data.setData('text', text);
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, '987654');
    for (let position = 1; position <= 6; position++) await expect(otpBox(page, position)).toHaveValue('987654'[position - 1]);
    await expect(confirm).toBeEnabled();
    // Confirm stays disabled until all six digits are present.
    await otpBox(page, 6).fill('');
    await expect(confirm).toBeDisabled();

    await typeOtp(page, differentCode(code));
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(page.getByRole('alert')).toContainText('Mã OTP không đúng');
    expect(await sql('SELECT id FROM wealth_services')).toHaveLength(0);

    await typeOtp(page, code);
    await confirm.click();
    await expect(page.getByText('Đã đồng ý dịch vụ')).toBeVisible();
    await expect(page.getByText('Chờ đánh giá rủi ro')).toBeVisible();
    const services = await sql<{ status: string }>('SELECT status FROM wealth_services');
    expect(services).toEqual([{ status: 'PENDING_RISK_ASSESSMENT' }]);
    await expectNoHorizontalOverflow(page);
  });
});

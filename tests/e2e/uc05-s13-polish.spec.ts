import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { activateRisk, addPendingProposal, api, ids, registerCustomer, resetBusinessState, tokenFor } from './support/stack';
import { expectNoHorizontalOverflow, goTo, openApp, otpBox, switchRole } from './support/ui';

/** S13 polish round (N1, N3, N4, N5, N8, N10). Backlog anchors in .agents/handoff/backlog.md. */
test.describe('S13 UI polish (N1 N3 N4 N5 N8 N10)', () => {
  test.beforeEach(async () => { await resetBusinessState(); });

  test('N1 hitting the invitation quota (429 on POST /onboarding/requests) shows the invitation wording, not the lookup wording', async ({ page }) => {
    await page.route('**/api/v1/onboarding/requests', async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      await route.fulfill({ status: 429, contentType: 'application/json', json: { code: 'RATE_LIMITED', message: 'Too many requests' } });
    });
    await openApp(page);
    await switchRole(page, 'rm-alpha');
    await goTo(page, 'Đăng ký khách hàng');
    await page.getByLabel('Mã CIF hoặc định danh').fill('00000101');
    await page.getByRole('button', { name: 'Tra cứu' }).click();
    await page.getByRole('radio', { name: /synthetic-vnd-account-101/ }).check();
    await page.getByRole('button', { name: 'Tạo lời mời' }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Bạn đã tạo quá nhiều lời mời trong một phút. Vui lòng thử lại sau.');
    await expect(alert).not.toContainText('Bạn tra cứu quá nhiều lần');
  });

  test('N1 the lookup 429 keeps its lookup wording', async ({ page }) => {
    await page.route('**/api/v1/onboarding/customer-lookup', async route => {
      await route.fulfill({ status: 429, contentType: 'application/json', json: { code: 'RATE_LIMITED', message: 'Too many requests' } });
    });
    await openApp(page);
    await switchRole(page, 'rm-alpha');
    await goTo(page, 'Đăng ký khách hàng');
    await page.getByLabel('Mã CIF hoặc định danh').fill('00000101');
    await page.getByRole('button', { name: 'Tra cứu' }).click();
    await expect(page.getByRole('alert')).toContainText('Bạn tra cứu quá nhiều lần. Hãy thử lại sau ít phút.');
  });

  test('N10 completed onboarding steps expose "đã xong" to screen readers, pending ones do not, current keeps aria-current', async ({ page }) => {
    await openApp(page);
    await switchRole(page, 'rm-alpha');
    await goTo(page, 'Đăng ký khách hàng');
    const stepper = page.getByRole('list', { name: 'Tiến trình đăng ký' });
    const item = (label: string) => stepper.getByRole('listitem').filter({ hasText: label });
    const spoken = (label: string) => item(label).evaluate(element => `${element.textContent ?? ''} ${element.getAttribute('aria-label') ?? ''}`);
    await expect(item('Tra cứu')).toHaveAttribute('aria-current', 'step');
    expect(await spoken('Tra cứu'), 'no step is done yet').not.toContain('đã xong');

    await page.getByLabel('Mã CIF hoặc định danh').fill('00000101');
    await page.getByRole('button', { name: 'Tra cứu' }).click();
    await expect(item('Chọn tài khoản')).toHaveAttribute('aria-current', 'step');
    await expect.poll(() => spoken('Tra cứu')).toContain('đã xong');
    expect(await spoken('Chọn tài khoản'), 'the current step is not announced as done').not.toContain('đã xong');
    expect(await spoken('Gửi lời mời'), 'a pending step is not announced as done').not.toContain('đã xong');

    await page.getByRole('radio', { name: /synthetic-vnd-account-101/ }).check();
    await expect(item('Gửi lời mời')).toHaveAttribute('aria-current', 'step');
    await expect.poll(() => spoken('Chọn tài khoản')).toContain('đã xong');
    await expect(stepper.locator('[aria-current="step"]')).toHaveCount(1);
  });

  test('N5 a 6-digit one-time-code autofill into box "Chữ số 1" spreads across all six boxes', async ({ page }) => {
    const created = await api('/onboarding/requests', { token: await tokenFor('rm-alpha'), key: 'e2e-s13-n5-setup',
      body: { cifRef: '00000101', selectedAccountId: 'synthetic-vnd-account-101' } });
    expect(created.status).toBe(201);
    await openApp(page);
    await switchRole(page, 'customer-alpha');
    await goTo(page, 'Lời mời dịch vụ');
    await page.getByRole('button', { name: 'Xem điều khoản' }).click();
    await page.getByLabel('Tôi đã đọc và đồng ý với điều khoản').check();
    await page.getByRole('button', { name: 'Gửi mã OTP' }).click();
    await expect(otpBox(page, 1)).toBeVisible();

    // OS autofill sets the whole code on the focused first box and fires an input event (a programmatic set bypasses maxlength).
    await otpBox(page, 1).focus();
    await otpBox(page, 1).evaluate((input: HTMLInputElement, code: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, code);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: code }));
    }, '123456');
    for (let position = 1; position <= 6; position++) await expect(otpBox(page, position), `box ${position}`).toHaveValue('123456'[position - 1]);
    await expect(page.getByRole('button', { name: 'Xác nhận đồng ý' })).toBeEnabled();
  });

  test.describe('leader screens', () => {
    let alphaId: string;
    test.beforeEach(async () => {
      alphaId = (await registerCustomer('00000101', 'customer-alpha')).customerId;
      await registerCustomer('00000102', 'customer-beta');
      await activateRisk('customer-alpha', 2);
      await activateRisk('customer-beta', 2);
      await addPendingProposal(alphaId);
    });
    const open = async (page: Page) => { await openApp(page); await switchRole(page, 'leader-alpha'); await goTo(page, 'Phân công RM'); };

    test('N3 changing the search so the selected customer drops out clears the selection and never loads that customer', async ({ page }) => {
      await open(page);
      const picker = page.getByLabel('Chọn khách hàng');
      await picker.selectOption(alphaId);
      await expect(picker).toHaveValue(alphaId);
      const loads: string[] = [];
      page.on('request', request => { if (request.method() === 'GET' && request.url().includes(`/customers/${alphaId}`)) loads.push(request.url()); });
      await page.getByLabel('Tìm khách hàng').fill('demo Beta');
      await expect(picker.getByRole('option', { name: /Khách hàng demo Beta/ })).toHaveCount(1);
      await expect(picker.getByRole('option', { name: /Khách hàng demo Alpha/ })).toHaveCount(0);
      await expect(picker, 'selection of the hidden customer is cleared (placeholder shown)').toHaveValue('');
      const load = page.getByRole('button', { name: 'Tải thông tin khách hàng' });
      if (await load.isEnabled()) await load.click();
      await expect(page.getByRole('region', { name: 'Khách hàng cần chuyển' })).toHaveCount(0);
      expect(loads, 'the stale selection must not be fetched').toHaveLength(0);
    });

    test('N4 after a successful transfer keyboard focus is on the success notice, not on body', async ({ page }) => {
      await open(page);
      await page.getByLabel('Chọn khách hàng').selectOption(alphaId);
      await page.getByRole('button', { name: 'Tải thông tin khách hàng' }).click();
      await expect(page.getByRole('region', { name: 'Khách hàng cần chuyển' })).toBeVisible();
      await page.getByLabel('RM nhận').selectOption(ids.rmBeta);
      await page.getByLabel('Lý do chuyển').fill('Kiểm tra vị trí focus sau khi chuyển');
      await page.getByRole('button', { name: 'Xác nhận chuyển' }).click();
      const dialog = page.getByRole('dialog', { name: 'Xác nhận chuyển RM' });
      await dialog.getByRole('button', { name: 'Chuyển khách hàng' }).click();
      await expect(dialog).toBeHidden();
      const notice = page.getByRole('status').filter({ hasText: 'Đã chuyển khách hàng' });
      await expect(notice).toBeVisible();
      await expect(notice, 'focus moves to the success notice').toBeFocused();
      expect(await page.evaluate(() => document.activeElement === document.body), 'focus is not lost to body').toBe(false);
    });

    test('N8 each RM in Danh sách RM stays inside the viewport and its id is not broken into many lines', async ({ page }) => {
      await open(page);
      const directory = page.getByRole('region', { name: 'Danh sách RM' });
      await expect(directory).toBeVisible();
      for (const rmId of [ids.rmAlpha, ids.rmBeta]) {
        // Either the full id is the element text, or a shortened text carries the full id in title.
        const idElement = directory.locator(`[title="${rmId}"], code:has-text("${rmId}")`).first();
        await expect(idElement, `RM id ${rmId} element`).toBeVisible();
        const metrics = await idElement.evaluate(element => {
          const style = getComputedStyle(element);
          const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
          const row = element.closest('tr') ?? element.closest('li, article, [role="row"], div');
          const box = (row ?? element).getBoundingClientRect();
          return { height: element.getBoundingClientRect().height, lineHeight, left: box.left, right: box.right, viewport: window.innerWidth };
        });
        expect(metrics.height, `id ${rmId} spans fewer than 2 lines`).toBeLessThan(metrics.lineHeight * 2);
        expect(metrics.left, 'RM entry starts inside the viewport').toBeGreaterThanOrEqual(0);
        expect(metrics.right, 'RM entry ends inside the viewport').toBeLessThanOrEqual(metrics.viewport + 1);
      }
      await expectNoHorizontalOverflow(page);
    });
  });
});

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { api, registerCustomer, resetBusinessState, sql, tokenFor, vnDate } from './support/stack';
import { expectNoHorizontalOverflow, goTo, openApp, readDemoInbox, switchRole } from './support/ui';

async function answer(page: Page, question: number, option: number) {
  await page.getByRole('radiogroup').nth(question).getByRole('radio').nth(option).check();
}

test.describe('UC02 risk survey journey (AC07)', () => {
  test.beforeEach(async () => { await resetBusinessState(); await registerCustomer('00000101', 'customer-alpha'); });

  test('AC07 customer answers 10 questions with progress, previews, changes an answer, confirms with OTP and sees profile and history', async ({ page }) => {
    await openApp(page);
    await switchRole(page, 'customer-alpha');
    await goTo(page, 'Khảo sát rủi ro');
    await expect(page.getByRole('radiogroup')).toHaveCount(10);
    await expect(page.getByRole('progressbar', { name: 'Tiến độ khảo sát' })).toHaveAttribute('aria-valuenow', '0');

    for (let q = 0; q < 3; q++) await answer(page, q, 2);
    await expect(page.getByText('3/10 câu')).toBeVisible();
    for (let q = 3; q < 9; q++) await answer(page, q, 2);
    await page.getByRole('button', { name: 'Xem kết quả dự kiến' }).click();
    await expect(page.getByRole('alert')).toContainText('Vui lòng trả lời đủ 10 câu'); // validation state, no draft created
    expect(await sql('SELECT id FROM risk_assessment_drafts')).toHaveLength(0);

    await answer(page, 9, 2);
    await expect(page.getByText('10/10 câu')).toBeVisible();
    await page.getByRole('button', { name: 'Xem kết quả dự kiến' }).click();
    const preview = page.getByRole('region', { name: 'Kết quả dự kiến' });
    await expect(preview).toContainText('Cân bằng');
    await expect(preview).toContainText('Điểm: 30');
    await expect(preview).toContainText('Bản nháp, chưa có hiệu lực');
    expect(await sql('SELECT id FROM risk_profiles')).toHaveLength(0); // preview is not a confirmed profile

    // Changing an answer invalidates the previous preview; a new preview is required.
    for (let q = 0; q < 5; q++) await answer(page, q, 4);
    await expect(preview).toBeHidden();
    await page.getByRole('button', { name: 'Xem kết quả dự kiến' }).click();
    await expect(preview).toContainText('Tăng trưởng');
    await expect(preview).toContainText('Điểm: 40');
    expect(await sql('SELECT id FROM risk_assessment_drafts')).toHaveLength(2);

    await page.getByRole('button', { name: 'Gửi mã OTP' }).click();
    const code = await readDemoInbox(page);
    await expect(page.getByLabel('Mã OTP')).toHaveValue('');
    await page.getByLabel('Mã OTP').fill(code);
    await page.getByRole('button', { name: 'Xác nhận hồ sơ rủi ro' }).click();
    await expect(page.getByText('Đã xác nhận hồ sơ rủi ro')).toBeVisible();

    await goTo(page, 'Hồ sơ rủi ro');
    const current = page.getByRole('region', { name: 'Hồ sơ hiện tại' });
    await expect(current).toContainText('Tăng trưởng');
    await expect(current).toContainText('Điểm: 40');
    const profile = await api('/me/risk-profile', { token: await tokenFor('customer-alpha') });
    expect(profile.body.current.category).toBe('GROWTH');
    await expect(current).toContainText(`Hết hạn: ${vnDate(profile.body.current.expiresAt)}`);
    const history = page.getByRole('region', { name: 'Lịch sử đánh giá' });
    await expect(history.getByRole('listitem')).toHaveCount(1);
    await expect(history.getByRole('listitem').first()).toContainText('Phiên bản 1');
    await expect(history.getByRole('listitem').first()).toContainText('Tăng trưởng');
    await expectNoHorizontalOverflow(page);
  });
});

import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { api, registerCustomer, resetBusinessState, sql, tokenFor, vnDate } from './support/stack';
import { expectNoHorizontalOverflow, differentCode, expectOtpEmpty, goTo, openApp, readDemoInbox, switchRole, typeOtp } from './support/ui';

/** S10 B13: one question per step. Exactly one radiogroup is shown; it is the current question. */
async function answer(page: Page, option: number) {
  await expect(page.getByRole('radiogroup')).toHaveCount(1);
  await page.getByRole('radiogroup').getByRole('radio').nth(option).check();
}

async function expectQuestion(page: Page, number: number) {
  await expect(page.getByText(`Câu ${number}/10`, { exact: true })).toBeVisible();
  await expect(page.getByRole('radiogroup')).toHaveCount(1);
}

/** Answers the current question and advances (`Câu tiếp`, or stays on question 10). */
async function answerAndNext(page: Page, number: number, option: number) {
  await expectQuestion(page, number);
  const next = page.getByRole('button', { name: 'Câu tiếp' });
  await expect(next, `Câu tiếp is disabled until question ${number} is answered`).toBeDisabled();
  await answer(page, option);
  if (number < 10) { await expect(next).toBeEnabled(); await next.click(); }
}

/** F1 (05-review.md): region shows `Rủi ro sản phẩm tối đa: N` and a list named `Phân bổ tài sản` with the four classes and server percentages. */
async function expectAllocation(region: Locator, maxProductRisk: number, allocation: { cash: number; deposit: number; bond: number; fund: number }) {
  await expect(region).toContainText(`Rủi ro sản phẩm tối đa: ${maxProductRisk}`);
  const list = region.getByRole('list', { name: 'Phân bổ tài sản' });
  await expect(list).toBeVisible();
  await expect(list.getByRole('listitem')).toHaveCount(4);
  const rows: Array<[string, number]> = [['Tiền mặt', allocation.cash], ['Tiền gửi', allocation.deposit], ['Trái phiếu', allocation.bond], ['Chứng chỉ quỹ', allocation.fund]];
  for (const [label, percent] of rows) {
    await expect(list.getByRole('listitem').filter({ hasText: label })).toContainText(new RegExp(`(^|\\D)${percent}\\s*%`));
  }
}

test.describe('UC02 risk survey journey (AC07)', () => {
  test.beforeEach(async () => { await resetBusinessState(); await registerCustomer('00000101', 'customer-alpha'); });

  test('AC07 customer answers 10 questions with progress, previews, changes an answer, confirms with OTP and sees profile and history', async ({ page }) => {
    await openApp(page);
    await switchRole(page, 'customer-alpha');
    await goTo(page, 'Khảo sát rủi ro');
    await expectQuestion(page, 1);
    await expect(page.getByRole('progressbar', { name: 'Tiến độ khảo sát' })).toHaveAttribute('aria-valuenow', '0');
    // Validation state: nothing answered means no way forward and no draft is created.
    await expect(page.getByRole('button', { name: 'Câu tiếp' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Xem kết quả dự kiến' })).toHaveCount(0);
    expect(await sql('SELECT id FROM risk_assessment_drafts')).toHaveLength(0);

    for (let q = 1; q <= 3; q++) await answerAndNext(page, q, 2);
    await expectQuestion(page, 4);
    await expect(page.getByText('3/10 câu')).toBeVisible();
    await expect(page.getByRole('progressbar', { name: 'Tiến độ khảo sát' })).toHaveAttribute('aria-valuenow', '3');
    // Answers persist when going back.
    await page.getByRole('button', { name: 'Câu trước' }).click();
    await expectQuestion(page, 3);
    await expect(page.getByRole('radiogroup').getByRole('radio').nth(2)).toBeChecked();
    await page.getByRole('button', { name: 'Câu tiếp' }).click();
    for (let q = 4; q <= 9; q++) await answerAndNext(page, q, 2);
    await expectQuestion(page, 10);
    // Last question: `Xem kết quả dự kiến` replaces `Câu tiếp`, disabled until answered; still no draft.
    await expect(page.getByRole('button', { name: 'Câu tiếp' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Xem kết quả dự kiến' })).toBeDisabled();
    expect(await sql('SELECT id FROM risk_assessment_drafts')).toHaveLength(0);

    await answer(page, 2);
    await expect(page.getByText('10/10 câu')).toBeVisible();
    await page.getByRole('button', { name: 'Xem kết quả dự kiến' }).click();
    const preview = page.getByRole('region', { name: 'Kết quả dự kiến' });
    await expect(preview).toContainText('Cân bằng');
    await expect(preview).toContainText('Điểm: 30');
    await expect(preview).toContainText('Bản nháp, chưa có hiệu lực');
    await expectAllocation(preview, 3, { cash: 5, deposit: 30, bond: 30, fund: 35 }); // F1 BALANCED matrix from the API
    expect(await sql('SELECT id FROM risk_profiles')).toHaveLength(0); // preview is not a confirmed profile

    // Changing an answer invalidates the previous preview; a new preview is required.
    for (let q = 10; q > 1; q--) await page.getByRole('button', { name: 'Câu trước' }).click(); // back to question 1
    await expectQuestion(page, 1);
    await expect(page.getByRole('radiogroup').getByRole('radio').nth(2)).toBeChecked(); // earlier answer kept
    await answer(page, 4);
    await expect(preview).toBeHidden();
    await page.getByRole('button', { name: 'Câu tiếp' }).click();
    for (let q = 2; q <= 5; q++) { await expectQuestion(page, q); await answer(page, 4); await page.getByRole('button', { name: 'Câu tiếp' }).click(); }
    for (let q = 6; q <= 9; q++) { await expectQuestion(page, q); await page.getByRole('button', { name: 'Câu tiếp' }).click(); } // already answered
    await expectQuestion(page, 10);
    await page.getByRole('button', { name: 'Xem kết quả dự kiến' }).click();
    await expect(preview).toContainText('Tăng trưởng');
    await expect(preview).toContainText('Điểm: 40');
    await expectAllocation(preview, 5, { cash: 5, deposit: 15, bond: 20, fund: 60 }); // F1 GROWTH matrix from the API
    expect(await sql('SELECT id FROM risk_assessment_drafts')).toHaveLength(2);

    await page.getByRole('button', { name: 'Gửi mã OTP' }).click();
    const code = await readDemoInbox(page);
    await expectOtpEmpty(page); // never auto-filled from the demo inbox
    const confirm = page.getByRole('button', { name: 'Xác nhận hồ sơ rủi ro' });
    await expect(confirm).toBeDisabled();
    await typeOtp(page, code.slice(0, 5));
    await expect(confirm).toBeDisabled(); // five digits are not enough
    await expect(page.getByText(/Gửi lại mã sau \d+s/)).toBeVisible();
    await typeOtp(page, differentCode(code));
    await confirm.click();
    await expect(page.getByRole('alert')).toContainText('Mã OTP không đúng');
    expect(await sql('SELECT id FROM risk_profiles')).toHaveLength(0);
    await typeOtp(page, code);
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(page.getByText('Đã xác nhận hồ sơ rủi ro')).toBeVisible();

    await goTo(page, 'Hồ sơ rủi ro');
    const current = page.getByRole('region', { name: 'Hồ sơ hiện tại' });
    await expect(current).toContainText('Tăng trưởng');
    await expect(current).toContainText('Điểm: 40');
    const profile = await api('/me/risk-profile', { token: await tokenFor('customer-alpha') });
    expect(profile.body.current.category).toBe('GROWTH');
    expect(profile.body.current.maxProductRisk).toBe(5);
    await expectAllocation(current, profile.body.current.maxProductRisk, profile.body.current.allocation); // F1 profile region, values from the API
    await expect(current).toContainText(`Hết hạn: ${vnDate(profile.body.current.expiresAt)}`);
    const history = page.getByRole('region', { name: 'Lịch sử đánh giá' });
    await expect(history.getByRole('listitem')).toHaveCount(1);
    await expect(history.getByRole('listitem').first()).toContainText('Phiên bản 1');
    await expect(history.getByRole('listitem').first()).toContainText('Tăng trưởng');
    await expectNoHorizontalOverflow(page);
  });

  test('AC07 arrow keys move the selection within the question group', async ({ page }) => {
    await openApp(page);
    await switchRole(page, 'customer-alpha');
    await goTo(page, 'Khảo sát rủi ro');
    await expectQuestion(page, 1);
    const radios = page.getByRole('radiogroup').getByRole('radio');
    await radios.first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(radios.nth(1)).toBeChecked();
    await page.keyboard.press('ArrowDown');
    await expect(radios.nth(2)).toBeChecked();
    await page.keyboard.press('ArrowLeft');
    await expect(radios.nth(1)).toBeChecked();
    await expect(page.getByRole('button', { name: 'Câu tiếp' })).toBeEnabled();
  });
});

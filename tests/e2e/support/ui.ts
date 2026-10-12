import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/** Opens the app shell; finding the WealthFlow heading proves the Vite server and proxy stack are up. */
export async function openApp(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'WealthFlow' })).toBeVisible();
}

/** Demo actor switch (plan 11.1): labelled select whose option values are actor ids, plus an explicit button. */
export async function switchRole(page: Page, actorId: string) {
  await expect(page.getByText('Môi trường demo').first(), 'demo environment label').toBeVisible();
  await page.getByLabel('Vai trò demo').selectOption(actorId);
  await page.getByRole('button', { name: 'Chuyển vai' }).click();
  await expect(page.getByText(`Đang dùng vai: ${actorId}`)).toBeVisible();
}

export async function goTo(page: Page, linkName: string) {
  await page.getByRole('navigation', { name: 'Điều hướng chính' }).getByRole('link', { name: linkName }).click();
}

/** The demo inbox is opened by the user; the code is then typed by the test like a user would. */
export async function readDemoInbox(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Xem hộp thư OTP demo' }).click();
  const inbox = page.getByRole('region', { name: 'Hộp thư OTP demo' });
  await expect(inbox).toBeVisible();
  const match = (await inbox.innerText()).match(/\b(\d{6})\b/);
  expect(match, 'demo inbox must show the 6-digit OTP').not.toBeNull();
  return match![1];
}

export function differentCode(code: string): string { return code === '111111' ? '222222' : '111111'; }

export async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'no horizontal page scroll at this viewport').toBeLessThanOrEqual(1);
}

/** S10 B13: OTP is six single-digit boxes in a group named `Mã OTP`, labelled `Chữ số 1` … `Chữ số 6`. */
export function otpGroup(page: Page) { return page.getByRole('group', { name: 'Mã OTP' }); }
export function otpBox(page: Page, position: number) { return otpGroup(page).getByLabel(`Chữ số ${position}`); }

export async function expectOtpEmpty(page: Page) {
  await expect(otpGroup(page)).toBeVisible();
  for (let position = 1; position <= 6; position++) await expect(otpBox(page, position)).toHaveValue('');
}

/** Types a code like a user: focus box 1 and type; focus must advance by itself (no per-box clicking). Clears old digits first. */
export async function typeOtp(page: Page, code: string) {
  for (let position = 6; position >= 1; position--) await otpBox(page, position).fill('');
  await otpBox(page, 1).click();
  await page.keyboard.type(code);
}

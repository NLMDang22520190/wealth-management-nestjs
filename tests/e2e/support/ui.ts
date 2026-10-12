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

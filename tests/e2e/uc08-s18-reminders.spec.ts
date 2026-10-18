import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { activateRisk, api, ids, registerCustomer, resetBusinessState, sql, tokenFor } from './support/stack';
import { goTo, openApp, switchRole } from './support/ui';

/**
 * S18 (Spec R4b) UI contract, see .agents/handoff/02-tests-S18.md:
 * - Leader screen "Phân công RM": region "Khảo sát rủi ro của khách hàng" with one listitem per loaded customer
 *   (name + status "Đã hoàn thành khảo sát" | "Chưa hoàn thành khảo sát" + per-customer button "Nhắc làm khảo sát"),
 *   and the bulk button "Nhắc tất cả khách chưa hoàn thành". Results show as role=status "Đã gửi N lời nhắc".
 * - Customer shell: region "Thông báo" with the reminder text, link to #/risk-survey and button "Đã xem".
 */
const DONE = 'Đã hoàn thành khảo sát';
const PENDING = 'Chưa hoàn thành khảo sát';
const REASON = 'Khách chưa hoàn thành khảo sát rủi ro';
const BANNER = 'Trưởng nhóm nhắc bạn hoàn thành khảo sát rủi ro (10 câu hỏi)';

test.describe('UC08 S18 leader reminders and transfer precondition (AC-U1)', () => {
  let alphaId: string; // no valid risk profile
  let betaId: string; // valid risk profile
  test.beforeEach(async () => {
    await resetBusinessState();
    alphaId = (await registerCustomer('00000101', 'customer-alpha')).customerId;
    betaId = (await registerCustomer('00000102', 'customer-beta')).customerId;
    await activateRisk('customer-beta', 2);
  });

  const survey = (page: Page) => page.getByRole('region', { name: 'Khảo sát rủi ro của khách hàng' });
  const row = (page: Page, name: string) => survey(page).getByRole('listitem').filter({ hasText: name });

  async function openAssignments(page: Page) {
    await openApp(page);
    await switchRole(page, 'leader-alpha');
    await goTo(page, 'Phân công RM');
    await expect(survey(page)).toBeVisible();
  }

  async function loadCustomer(page: Page, customerId: string, name: string) {
    await page.getByLabel('Chọn khách hàng').selectOption(customerId);
    await page.getByRole('button', { name: 'Tải thông tin khách hàng' }).click();
    await expect(page.getByRole('region', { name: 'Khách hàng cần chuyển' }).getByText(name)).toBeVisible();
  }

  test('AC-U1 every customer shows its survey status', async ({ page }) => {
    await openAssignments(page);
    await expect(row(page, 'Khách hàng demo Alpha')).toContainText(PENDING);
    await expect(row(page, 'Khách hàng demo Beta')).toContainText(DONE);
    await expect(row(page, 'Khách hàng demo Beta')).not.toContainText(PENDING);
  });

  test('AC-U1 a customer without a valid risk profile cannot be transferred and the reason is shown', async ({ page }) => {
    await openAssignments(page);
    await loadCustomer(page, alphaId, 'Khách hàng demo Alpha');
    const panel = page.getByRole('region', { name: 'Khách hàng cần chuyển' });
    await expect(panel.getByText(REASON)).toBeVisible();
    await expect(panel.getByLabel('RM nhận')).toBeDisabled();
    await expect(panel.getByRole('button', { name: 'Xác nhận chuyển' })).toBeDisabled();
    const posts: string[] = [];
    page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/rm-assignment')) posts.push(request.url()); });
    await panel.getByRole('button', { name: 'Xác nhận chuyển' }).click({ force: true, timeout: 2000 }).catch(() => undefined);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(posts, 'no transfer request is sent').toHaveLength(0);
  });

  test('AC-U1 a customer with a valid risk profile still transfers (existing flow, no reason text)', async ({ page }) => {
    await openAssignments(page);
    await loadCustomer(page, betaId, 'Khách hàng demo Beta');
    const panel = page.getByRole('region', { name: 'Khách hàng cần chuyển' });
    await expect(panel.getByText(REASON)).toHaveCount(0);
    await expect(panel.getByLabel('RM nhận')).toBeEnabled();
    await panel.getByLabel('RM nhận').selectOption(ids.rmBeta);
    await panel.getByLabel('Lý do chuyển').fill('Cân đối tải công việc giữa các RM');
    await page.getByRole('button', { name: 'Xác nhận chuyển' }).click();
    await page.getByRole('dialog', { name: 'Xác nhận chuyển RM' }).getByRole('button', { name: 'Chuyển khách hàng' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Đã chuyển khách hàng' })).toBeVisible();
  });

  test('AC-U1 per-customer reminder posts that customerId, reports it, and a second press says recently reminded', async ({ page }) => {
    await openAssignments(page);
    const bodies: unknown[] = [];
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().includes('/team/risk-survey-reminders')) bodies.push(request.postDataJSON());
    });
    const button = row(page, 'Khách hàng demo Alpha').getByRole('button', { name: 'Nhắc làm khảo sát' });
    await button.click();
    await expect(page.getByRole('status').filter({ hasText: 'Đã gửi 1 lời nhắc' })).toBeVisible();
    expect(bodies).toEqual([{ customerIds: [alphaId] }]);
    expect(await sql("SELECT id FROM customer_notifications WHERE customer_id=$1 AND kind='RISK_SURVEY_REMINDER'", [alphaId])).toHaveLength(1);

    await button.click();
    await expect(page.getByRole('status').filter({ hasText: 'Khách đã được nhắc trong 24 giờ qua' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Đã gửi 1 lời nhắc' })).toHaveCount(0);
    expect(bodies).toHaveLength(2);
    expect(await sql('SELECT id FROM customer_notifications WHERE customer_id=$1', [alphaId]), 'no duplicate reminder row').toHaveLength(1);
  });

  test('AC-U1 a customer with a valid profile has no per-customer reminder button', async ({ page }) => {
    await openAssignments(page);
    await expect(row(page, 'Khách hàng demo Alpha').getByRole('button', { name: 'Nhắc làm khảo sát' })).toBeVisible();
    await expect(row(page, 'Khách hàng demo Beta').getByRole('button', { name: 'Nhắc làm khảo sát' })).toHaveCount(0);
  });

  test('AC-U1 bulk button posts without customerIds and shows the sent count', async ({ page }) => {
    await openAssignments(page);
    const bodies: unknown[] = [];
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().includes('/team/risk-survey-reminders')) bodies.push(request.postDataJSON() ?? {});
    });
    await page.getByRole('button', { name: 'Nhắc tất cả khách chưa hoàn thành' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Đã gửi 1 lời nhắc' })).toBeVisible(); // only alpha; beta is valid (seed has two customer actors)
    expect(bodies).toHaveLength(1);
    expect((bodies[0] as { customerIds?: unknown }).customerIds, 'bulk sends no customerIds').toBeUndefined();
    expect(await sql('SELECT customer_id FROM customer_notifications WHERE customer_id=$1', [alphaId])).toHaveLength(1);
    expect(await sql('SELECT id FROM customer_notifications WHERE customer_id=$1', [betaId])).toHaveLength(0);
  });

  test('AC-U1 the count in the bulk message comes from the response', async ({ page }) => {
    await page.route('**/api/v1/team/risk-survey-reminders', route => route.fulfill({ status: 200, json: { sent: 7, skipped: [] } }));
    await openAssignments(page);
    await page.getByRole('button', { name: 'Nhắc tất cả khách chưa hoàn thành' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Đã gửi 7 lời nhắc' })).toBeVisible();
  });

  test('AC-U1 a RISK_PROFILE_REQUIRED answer on transfer shows a readable Vietnamese error', async ({ page }) => {
    await page.route('**/api/v1/customers/*/rm-assignment', route => {
      if (route.request().method() !== 'POST') return route.fallback();
      return route.fulfill({ status: 422, headers: { 'x-request-id': 'req-s18' },
        json: { code: 'RISK_PROFILE_REQUIRED', message: 'Customer risk profile is not valid', requestId: 'req-s18' } });
    });
    await openAssignments(page);
    // beta has a valid profile so the UI lets the attempt through; the (mocked) server still refuses.
    await loadCustomer(page, betaId, 'Khách hàng demo Beta');
    await page.getByLabel('RM nhận').selectOption(ids.rmBeta);
    await page.getByLabel('Lý do chuyển').fill('Chuyển để thử lỗi khảo sát');
    await page.getByRole('button', { name: 'Xác nhận chuyển' }).click();
    await page.getByRole('dialog', { name: 'Xác nhận chuyển RM' }).getByRole('button', { name: 'Chuyển khách hàng' }).click();
    const alert = page.getByRole('alert').filter({ hasText: REASON });
    await expect(alert).toBeVisible();
    await expect(alert).not.toContainText('RISK_PROFILE_REQUIRED');
    await expect(alert).not.toContainText('Customer risk profile');
  });
});

test.describe('UC08 S18 customer reminder banner (AC-U2)', () => {
  test.beforeEach(async () => {
    await resetBusinessState();
    await registerCustomer('00000101', 'customer-alpha');
    await registerCustomer('00000102', 'customer-beta');
    await activateRisk('customer-beta', 2);
  });

  const banner = (page: Page) => page.getByRole('region', { name: 'Thông báo' });

  async function remindAlpha() {
    const lead = await tokenFor('leader-alpha');
    const list = await api('/team/customers?page=1&pageSize=50', { token: lead });
    const alpha = (list.body.items as Array<{ customerId: string; name: string }>).find(item => item.name.includes('Alpha'))!;
    const sent = await api('/team/risk-survey-reminders', { token: lead, body: { customerIds: [alpha.customerId] } });
    expect(sent.status).toBe(200);
    expect(sent.body.sent).toBe(1);
  }

  test('AC-U2 a customer with no unread notification sees no banner', async ({ page }) => {
    await openApp(page);
    await switchRole(page, 'customer-alpha');
    await expect(page.getByRole('navigation', { name: 'Điều hướng chính' })).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
    await expect(page.getByText(BANNER)).toHaveCount(0);
  });

  test('AC-U2 the reminded customer sees the banner with a survey link, dismisses it, and it stays gone', async ({ page }) => {
    await remindAlpha();
    await openApp(page);
    await switchRole(page, 'customer-alpha');
    await expect(banner(page)).toContainText(BANNER);
    await expect(banner(page).getByRole('link')).toHaveAttribute('href', '#/risk-survey');

    const reads: string[] = [];
    page.on('request', request => { if (request.method() === 'POST' && /\/notifications\/[^/]+\/read$/.test(request.url())) reads.push(request.url()); });
    await banner(page).getByRole('button', { name: 'Đã xem' }).click();
    await expect(page.getByText(BANNER)).toHaveCount(0);
    expect(reads).toHaveLength(1);
    expect(await sql('SELECT read_at FROM customer_notifications WHERE read_at IS NOT NULL')).toHaveLength(1);

    await page.reload();
    await switchRole(page, 'customer-alpha');
    await expect(page.getByRole('navigation', { name: 'Điều hướng chính' })).toBeVisible();
    await expect(page.getByText(BANNER)).toHaveCount(0);
    await switchRole(page, 'customer-beta');
    await switchRole(page, 'customer-alpha');
    await expect(page.getByText(BANNER)).toHaveCount(0);
  });

  test('AC-U2 the banner belongs to the reminded customer only', async ({ page }) => {
    await remindAlpha();
    await openApp(page);
    await switchRole(page, 'customer-beta');
    await expect(page.getByRole('navigation', { name: 'Điều hướng chính' })).toBeVisible();
    await expect(page.getByText(BANNER)).toHaveCount(0);
    await switchRole(page, 'customer-alpha');
    await expect(banner(page)).toContainText(BANNER);
  });
});

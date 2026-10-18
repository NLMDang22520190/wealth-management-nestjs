import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { activateRisk, api, ids, registerCustomer, resetBusinessState, sql, tokenFor } from './support/stack';
import { goTo, openApp, switchRole } from './support/ui';

/**
 * R4-fix UI contract (review R4 findings 1, 2, 6, 7, 8; see .agents/handoff/02-tests-R4fix.md):
 *  1  reminded customer who then activates the survey sees no region "Thông báo".
 *  2  RM load progressbar has aria-valuetext equal to the visible "N/80 khách" text (aria-valuenow stays <= 80).
 *  6  after "Đã xem" focus is not on <body>.
 *  7  a persistent role=status live region exists in region "Khảo sát rủi ro của khách hàng" before any reminder;
 *     disabled "RM nhận" and "Xác nhận chuyển" carry aria-describedby -> element containing the reason text.
 *  8  375px: banner text block >= 60% of the banner region width with link/button below the text;
 *     survey panel lists at most 5 customers by default, toggle button "Xem tất cả" reveals all.
 */
const REASON = 'Khách chưa hoàn thành khảo sát rủi ro';
const BANNER = 'Trưởng nhóm nhắc bạn hoàn thành khảo sát rủi ro (10 câu hỏi)';

async function remindCustomer(name: string) {
  const lead = await tokenFor('leader-alpha');
  const list = await api('/team/customers?page=1&pageSize=50', { token: lead });
  const target = (list.body.items as Array<{ customerId: string; name: string }>).find(item => item.name.includes(name))!;
  const sent = await api('/team/risk-survey-reminders', { token: lead, body: { customerIds: [target.customerId] } });
  expect(sent.status).toBe(200);
  expect(sent.body.sent).toBe(1);
}

test.describe('UC09 R4-fix', () => {
  let alphaId: string;
  test.beforeEach(async () => {
    await resetBusinessState();
    alphaId = (await registerCustomer('00000101', 'customer-alpha')).customerId;
    await registerCustomer('00000102', 'customer-beta');
    await activateRisk('customer-beta', 2);
  });

  const banner = (page: Page) => page.getByRole('region', { name: 'Thông báo' });
  const survey = (page: Page) => page.getByRole('region', { name: 'Khảo sát rủi ro của khách hàng' });
  async function openAssignments(page: Page) {
    await openApp(page);
    await switchRole(page, 'leader-alpha');
    await goTo(page, 'Phân công RM');
    await expect(survey(page)).toBeVisible();
  }
  async function addCustomers(prefix: string, label: string, count: number, rmId: string) {
    await sql(`INSERT INTO customers(id,cif_id,name,created_at)
      SELECT gen_random_uuid(),$2::text||lpad(n::text,5,'0'),$3::text||n::text,now() FROM generate_series(1,$1::int) n`, [count, prefix, label]);
    await sql(`INSERT INTO rm_assignment_history(id,customer_id,rm_id,team_id,valid_from,valid_to,provisional)
      SELECT gen_random_uuid(),c.id,$1,t.team_id,now(),NULL,false FROM customers c
      CROSS JOIN (SELECT team_id FROM rm_assignment_history WHERE customer_id=$2 AND valid_to IS NULL) t WHERE c.cif_id LIKE $3`,
    [rmId, alphaId, `${prefix}%`]);
  }

  test('R4fix-1 a reminded customer who then completes the survey sees no notification banner', async ({ page }) => {
    await remindCustomer('Alpha');
    await activateRisk('customer-alpha', 2);
    await openApp(page);
    await switchRole(page, 'customer-alpha');
    await expect(page.getByRole('navigation', { name: 'Điều hướng chính' })).toBeVisible();
    await expect(page.getByText(BANNER)).toHaveCount(0);
    await expect(banner(page)).toHaveCount(0);
  });

  test('R4fix-2 load progressbar aria-valuetext equals the visible "N/80 khách" text, also over capacity', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'the bar is only rendered on desktop');
    await addCustomers('OVR', 'Khách hàng quá tải ', 85, ids.rmBeta);
    await openAssignments(page);
    const rows = page.getByRole('region', { name: 'Danh sách RM' });
    for (const [rm, text] of [['rm-alpha', '2/80 khách'], ['rm-beta', '85/80 khách']] as const) {
      const row = rows.getByRole('row', { name: new RegExp(rm) });
      await expect(row.getByText(text, { exact: true })).toBeVisible();
      const bar = row.locator('[role="progressbar"]');
      await expect(bar).toHaveAttribute('aria-valuetext', text);
      expect(Number(await bar.getAttribute('aria-valuenow'))).toBeLessThanOrEqual(80);
    }
  });

  test('R4fix-6 focus does not fall back to <body> after pressing "Đã xem"', async ({ page }) => {
    await remindCustomer('Alpha');
    await openApp(page);
    await switchRole(page, 'customer-alpha');
    await expect(banner(page)).toContainText(BANNER);
    await banner(page).getByRole('button', { name: 'Đã xem' }).click();
    await expect(page.getByText(BANNER)).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.activeElement === document.body), { message: 'focus is on body' }).toBe(false);
  });

  test('R4fix-7 the reminder live region is persistent and empty before any reminder', async ({ page }) => {
    await openAssignments(page);
    const live = survey(page).locator('[role="status"]');
    await expect(live).toHaveCount(1);
    await expect(live).toHaveText('');
    await page.getByRole('button', { name: 'Nhắc tất cả khách chưa hoàn thành' }).click();
    await expect(live).toContainText('Đã gửi 1 lời nhắc');
  });

  test('R4fix-7 disabled transfer controls point at the reason via aria-describedby', async ({ page }) => {
    await openAssignments(page);
    await page.getByLabel('Chọn khách hàng').selectOption(alphaId);
    await page.getByRole('button', { name: 'Tải thông tin khách hàng' }).click();
    const panel = page.getByRole('region', { name: 'Khách hàng cần chuyển' });
    await expect(panel.getByText(REASON)).toBeVisible();
    for (const control of [panel.getByLabel('RM nhận'), panel.getByRole('button', { name: 'Xác nhận chuyển' })]) {
      await expect(control).toBeDisabled();
      const describedBy = await control.getAttribute('aria-describedby');
      expect(describedBy, 'aria-describedby present').toBeTruthy();
      const text = await page.evaluate(value => value.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' '), describedBy!);
      expect(text).toContain(REASON);
    }
  });

  test('R4fix-8 at 375px the banner text keeps >= 60% of the banner width and the link/button wrap below it', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', '375px layout check');
    await remindCustomer('Alpha');
    await openApp(page);
    await switchRole(page, 'customer-alpha');
    await expect(banner(page)).toContainText(BANNER);
    const region = (await banner(page).boundingBox())!;
    const text = (await banner(page).getByText(BANNER).boundingBox())!;
    expect(text.width, 'text block width').toBeGreaterThanOrEqual(region.width * 0.6);
    for (const control of [banner(page).getByRole('link'), banner(page).getByRole('button', { name: 'Đã xem' })]) {
      const box = (await control.boundingBox())!;
      expect(box.y, 'control sits below the text, not beside it').toBeGreaterThanOrEqual(text.y + text.height - 2);
    }
  });

  test('R4fix-8 the survey panel shows at most 5 customers by default; "Xem tất cả" reveals every customer', async ({ page }) => {
    await addCustomers('EXT', 'Khách hàng phụ ', 8, ids.rmAlpha);
    await openAssignments(page);
    const items = survey(page).getByRole('listitem');
    await expect(items).toHaveCount(5);
    await survey(page).getByRole('button', { name: 'Xem tất cả' }).click();
    await expect(items).toHaveCount(10);
  });
});

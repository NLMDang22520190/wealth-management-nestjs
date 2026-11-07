import { expect, test } from '@playwright/test';
import { actors, registerCustomer, resetBusinessState } from './support/stack';
import { goTo, openApp, switchRole } from './support/ui';

/**
 * R9 S2 (AC4 web part): the demo role picker offers the team's actors from the vendored seed
 * (staff by employee_code NV0001 leader, NV0002 / NV0003 RM; customers by CIF) and shows `Đang dùng vai: <actorId>`.
 * The old ids rm-alpha / rm-beta / leader-alpha / customer-alpha / customer-beta are gone. NV0004 (BACK_OFFICE) runs the P2 screens;
 * NV0005 (BACK_OFFICE_MANAGER) cannot log in (401), so it is not offered. Named options are asserted, not an exact count.
 */
const STAFF = ['NV0001', 'NV0002', 'NV0003'];
const CUSTOMERS = ['CIF100001', 'CIF100002', 'CIF100003', 'CIF100004'];
const OLD_IDS = ['rm-alpha', 'rm-beta', 'leader-alpha', 'customer-alpha', 'customer-beta'];

test.describe('UC11 R9 team demo roles in the UI (AC4 web)', () => {
  test.beforeEach(async () => { await resetBusinessState(); });

  test('AC4 the Vai trò demo select offers the team staff, NV0004 and customers by code and none of the old demo ids or NV0005', async ({ page }) => {
    await openApp(page);
    const picker = page.getByLabel('Vai trò demo');
    const options = await picker.evaluate(select => [...(select as HTMLSelectElement).options].map(option => ({ value: option.value, text: option.textContent ?? '' })));
    const values = options.map(option => option.value);
    for (const code of [...STAFF, ...CUSTOMERS]) {
      expect(values, `option ${code}`).toContain(code);
      expect(options.find(option => option.value === code)!.text, `label of ${code} shows the code`).toContain(code);
    }
    for (const old of OLD_IDS) expect(values, `old id ${old} removed`).not.toContain(old);
    expect(values, 'NV0004 runs the P2 back-office screens').toContain('NV0004');
    expect(values, 'NV0005 cannot log in, so it is not offered').not.toContain('NV0005');
    for (const old of OLD_IDS) expect(options.map(option => option.text).join('|'), `old label ${old} removed`).not.toContain(old);
  });

  test('AC4 the start screen role cards switch to team actors (Dùng vai NV0001 / NV0002 / a CIF), not to the old demo ids', async ({ page }) => {
    await openApp(page);
    await expect(page.getByText('Chưa chọn vai')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Dùng vai NV0001' })).toBeVisible(); // team leader card
    await expect(page.getByRole('button', { name: 'Dùng vai NV0002' })).toBeVisible(); // RM card
    await expect(page.getByRole('button', { name: /^Dùng vai CIF1000\d\d$/ })).toHaveCount(1); // customer card
    for (const old of OLD_IDS) await expect(page.getByRole('button', { name: `Dùng vai ${old}` })).toHaveCount(0);
    await page.getByRole('button', { name: 'Dùng vai NV0002' }).click();
    await expect(page.getByText('Đang dùng vai: NV0002')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Điều hướng chính' }).getByRole('link', { name: 'Khách phụ trách' })).toBeVisible();
  });

  test('AC4 choosing NV0001 (leader) and NV0002 / NV0003 (RM) through the picker shows the label with the code and the role navigation', async ({ page }) => {
    await openApp(page);
    await switchRole(page, 'NV0001');
    await expect(page.getByRole('navigation', { name: 'Điều hướng chính' }).getByRole('link', { name: 'Phân công RM' })).toBeVisible();
    for (const code of ['NV0002', 'NV0003']) {
      await switchRole(page, code);
      await expect(page.getByText(`Đang dùng vai: ${code}`)).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Điều hướng chính' }).getByRole('link', { name: 'Khách phụ trách' })).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Điều hướng chính' }).getByRole('link', { name: 'Phân công RM' })).toHaveCount(0);
    }
  });

  test('AC4 a customer picked by CIF gets the customer navigation once the CIF is a known customer identity', async ({ page }) => {
    await registerCustomer(actors.customerAlpha, actors.customerAlpha); // invitation + consent through the real API, as in every journey
    await openApp(page);
    await switchRole(page, 'CIF100001');
    await expect(page.getByRole('navigation', { name: 'Điều hướng chính' }).getByRole('link', { name: 'Khảo sát rủi ro' })).toBeVisible();
    await goTo(page, 'Hồ sơ rủi ro');
    await expect(page.getByText('Đang dùng vai: CIF100001')).toBeVisible();
  });

  test('AC4 a picked CIF that is not a known customer identity is refused by the server and no role is shown', async ({ page }) => {
    // After the reset CIF100003 has no customer row and no invitation (the seed data was wiped), so the mock login must fail.
    await openApp(page);
    await page.getByLabel('Vai trò demo').selectOption('CIF100003');
    await page.getByRole('button', { name: 'Chuyển vai' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByText('Đang dùng vai: CIF100003')).toHaveCount(0);
    await expect(page.getByText('Chưa chọn vai')).toBeVisible();
  });
});

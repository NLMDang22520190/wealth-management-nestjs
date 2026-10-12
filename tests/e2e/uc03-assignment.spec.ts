import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { activateRisk, addPendingProposal, ids, registerCustomer, resetBusinessState, sql, transferViaApi } from './support/stack';
import { expectNoHorizontalOverflow, goTo, openApp, switchRole } from './support/ui';

test.describe('UC03 leader assignment journey (AC07)', () => {
  let alphaId: string;
  test.beforeEach(async () => {
    await resetBusinessState();
    alphaId = (await registerCustomer('00000101', 'customer-alpha')).customerId;
    await registerCustomer('00000102', 'customer-beta');
    await activateRisk('customer-alpha', 2);
    await activateRisk('customer-beta', 2);
    await addPendingProposal(alphaId);
  });

  async function loadCustomer(page: Page) {
    // F3: the leader picks from the team's customers by name; no UUID typing.
    await expect(page.getByLabel('Mã khách hàng')).toHaveCount(0);
    const picker = page.getByLabel('Chọn khách hàng');
    await expect(picker.getByRole('option', { name: /Khách hàng demo Alpha/ })).toHaveCount(1);
    await expect(picker.getByRole('option', { name: /Khách hàng demo Beta/ })).toHaveCount(1);
    // B1: the name is the option's VISIBLE text, not only an accessible-name attribute.
    const optionTexts = await picker.evaluate(select => [...(select as HTMLSelectElement).options].map(option => option.textContent ?? ''));
    expect(optionTexts.some(text => text.includes('Khách hàng demo Alpha')), 'option text contains Alpha').toBe(true);
    expect(optionTexts.some(text => text.includes('Khách hàng demo Beta')), 'option text contains Beta').toBe(true);
    await picker.selectOption(alphaId);
    await page.getByRole('button', { name: 'Tải thông tin khách hàng' }).click();
    // B1: scoped to the loaded customer panel, not the whole page (the picker must not be what satisfies this).
    await expect(page.getByRole('region', { name: 'Khách hàng cần chuyển' }).getByText('Khách hàng demo Alpha')).toBeVisible();
  }

  test('AC07 leader sees RM capacity x/80 and transfers a customer with a reason', async ({ page }) => {
    await openApp(page);
    await switchRole(page, 'leader-alpha');
    await goTo(page, 'Phân công RM');
    const directory = page.getByRole('region', { name: 'Danh sách RM' });
    await expect(directory.getByRole('row', { name: new RegExp(ids.rmAlpha) })).toContainText('2/80');
    await expect(directory.getByRole('row', { name: new RegExp(ids.rmBeta) })).toContainText('0/80');

    await loadCustomer(page);
    await expect(page.getByText('Phiên bản phân công: 1')).toBeVisible();
    // F4: two more pending proposals appear after the page loaded the customer; only the server knows the real count (1 + 2 = 3).
    await addPendingProposal(alphaId);
    await addPendingProposal(alphaId);
    await page.getByLabel('RM nhận').selectOption(ids.rmBeta);
    await page.getByRole('button', { name: 'Xác nhận chuyển' }).click();
    await expect(page.getByRole('alert')).toContainText('Vui lòng nhập lý do chuyển'); // validation, nothing sent
    expect(await sql("SELECT id FROM rm_assignment_history WHERE reason IS NOT NULL")).toHaveLength(0);

    await page.getByLabel('Lý do chuyển').fill('Cân đối tải công việc giữa các RM');
    await page.getByRole('button', { name: 'Xác nhận chuyển' }).click();
    await expect(page.getByText('Đã chuyển khách hàng')).toBeVisible();
    await expect(page.getByText('đề xuất đang chờ duyệt của khách đã bị hủy', { exact: false })).toBeVisible();
    await expect(page.getByText('3 đề xuất đang chờ duyệt của khách đã bị hủy', { exact: false })).toBeVisible(); // exact server count
    await expect(directory.getByRole('row', { name: new RegExp(ids.rmAlpha) })).toContainText('1/80');
    await expect(directory.getByRole('row', { name: new RegExp(ids.rmBeta) })).toContainText('1/80');
    const current = await sql<{ rm_id: string; reason: string }>('SELECT rm_id,reason FROM rm_assignment_history WHERE customer_id=$1 AND valid_to IS NULL', [alphaId]);
    expect(current).toEqual([{ rm_id: ids.rmBeta, reason: 'Cân đối tải công việc giữa các RM' }]);
    expect(await sql("SELECT id FROM proposals WHERE customer_id=$1 AND status='PENDING_APPROVAL'", [alphaId])).toHaveLength(0);
    await expectNoHorizontalOverflow(page);
  });

  test('AC07 a stale assignment version shows a visible conflict message and refresh loads the current assignment', async ({ page }) => {
    await openApp(page);
    await switchRole(page, 'leader-alpha');
    await goTo(page, 'Phân công RM');
    await loadCustomer(page);
    await expect(page.getByText('Phiên bản phân công: 1')).toBeVisible();

    // Someone else transfers the same customer after the leader loaded version 1.
    expect((await transferViaApi(alphaId, ids.rmBeta, 1)).status).toBe(200);

    await page.getByLabel('RM nhận').selectOption(ids.rmBeta);
    await page.getByLabel('Lý do chuyển').fill('Chuyển với phiên bản đã cũ');
    await page.getByRole('button', { name: 'Xác nhận chuyển' }).click();
    await expect(page.getByRole('alert')).toContainText('Phân công đã thay đổi');
    await page.getByRole('button', { name: 'Tải lại' }).click();
    await expect(page.getByText('Phiên bản phân công: 2')).toBeVisible();
    const rows = await sql('SELECT id FROM rm_assignment_history WHERE customer_id=$1', [alphaId]);
    expect(rows).toHaveLength(2); // the stale request created no extra assignment (original + one API transfer)
    await expectNoHorizontalOverflow(page);
  });

  test('B2 picker search filters on the server and paging shows Hiển thị N/M with Tải thêm khách hàng', async ({ page }) => {
    // 105 extra customers of the leader's team, inserted cheaply with SQL (names sort before "demo", so Alpha/Beta fall past page 1).
    await sql(`INSERT INTO customers(id,cif_id,name,created_at)
      SELECT gen_random_uuid(),'BULK'||lpad(n::text,5,'0'),'Khách hàng bulk '||lpad(n::text,3,'0'),now() FROM generate_series(1,105) n`);
    await sql(`INSERT INTO rm_assignment_history(id,customer_id,rm_id,team_id,valid_from,valid_to,provisional)
      SELECT gen_random_uuid(),c.id,t.rm_id,t.team_id,now(),NULL,false FROM customers c
      CROSS JOIN (SELECT rm_id,team_id FROM rm_assignment_history WHERE customer_id=$1 AND valid_to IS NULL) t WHERE c.cif_id LIKE 'BULK%'`, [alphaId]);
    const total = 107;

    await openApp(page);
    await switchRole(page, 'leader-alpha');
    await goTo(page, 'Phân công RM');
    const picker = page.getByLabel('Chọn khách hàng');
    const hint = page.getByText(/Hiển thị \d+\/\d+ khách hàng/);
    await expect(hint).toBeVisible();
    await expect(hint).toContainText(`/${total} khách hàng`);
    const loaded = async () => Number((await hint.innerText()).match(/Hiển thị (\d+)\//)![1]);
    expect(await loaded()).toBeLessThan(total); // not everything is loaded at once

    // Paging: the button loads the next page until everything is loaded.
    const more = page.getByRole('button', { name: 'Tải thêm khách hàng' });
    await expect(more).toBeVisible();
    for (let step = 0; step < 20 && (await more.count()) > 0; step++) {
      const before = await loaded();
      await more.click();
      await expect.poll(loaded).toBeGreaterThan(before);
    }
    await expect(hint).toContainText(`Hiển thị ${total}/${total} khách hàng`);
    await expect(more).toHaveCount(0);
    await expect(picker.getByRole('option', { name: /Khách hàng demo Alpha/ })).toHaveCount(1);

    // Search: the term goes to the server (name= query), narrows the options and the hint.
    const searched = page.waitForRequest(request => request.url().includes('/team/customers') && request.url().includes('name='));
    await page.getByLabel('Tìm khách hàng').fill('demo Beta');
    expect((await searched).url()).toContain(encodeURIComponent('demo Beta'));
    await expect(hint).toContainText('Hiển thị 1/1 khách hàng');
    await expect(picker.getByRole('option', { name: /Khách hàng demo Beta/ })).toHaveCount(1);
    await expect(picker.getByRole('option', { name: /Khách hàng bulk/ })).toHaveCount(0);
    await expect(more).toHaveCount(0);
    await picker.selectOption({ label: 'Khách hàng demo Beta' });
    await page.getByRole('button', { name: 'Tải thông tin khách hàng' }).click();
    await expect(page.getByRole('region', { name: 'Khách hàng cần chuyển' }).getByText('Khách hàng demo Beta')).toBeVisible();
  });

  test('B7 a transfer response without cancelledProposals never shows "undefined" and still reports the transfer', async ({ page }) => {
    await page.route('**/api/v1/customers/*/rm-assignment', async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      const real = await route.fetch();
      const body = await real.json();
      delete body.cancelledProposals; // a replayed pre-S6 idempotent response has no such field
      await route.fulfill({ response: real, json: body });
    });
    await openApp(page);
    await switchRole(page, 'leader-alpha');
    await goTo(page, 'Phân công RM');
    // Independent of the B1 picker-text check: select by value so only B7 can fail here.
    await page.getByLabel('Chọn khách hàng').selectOption(alphaId);
    await page.getByRole('button', { name: 'Tải thông tin khách hàng' }).click();
    await expect(page.getByRole('region', { name: 'Khách hàng cần chuyển' })).toBeVisible();
    await page.getByLabel('RM nhận').selectOption(ids.rmBeta);
    await page.getByLabel('Lý do chuyển').fill('Chuyển với phản hồi thiếu trường hủy');
    await page.getByRole('button', { name: 'Xác nhận chuyển' }).click();
    const notice = page.getByRole('status').filter({ hasText: 'Đã chuyển khách hàng' });
    await expect(notice).toBeVisible();
    await expect(notice).not.toContainText('undefined');
    await expect(notice).not.toContainText('NaN');
  });
});

import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { activateRisk, addHolding, addPendingProposal, ids, registerCustomer, resetBusinessState, sql } from './support/stack';
import { expectNoHorizontalOverflow, goTo, openApp, switchRole } from './support/ui';

/**
 * S16b (R4 UI 6/7/8/9/14/R2/4-web). Contract used by these tests (see .agents/handoff/02-tests-S16b.md):
 *  - list cells carry data-label: "AUM", "Tiền mặt", "Kiểm tra chờ"
 *  - drift: badge `data-testid="drift-badge"` only when count > 0 (text = the number); count 0 -> `data-testid="drift-zero"` muted "0" or "—"
 *  - detail risk badge `data-testid="risk-badge"`; filters toolbar `data-testid="customer-filters"`
 *  - load bar role=progressbar with aria-valuenow/max and data-level ok|warn|high
 *  - RM: visible "<rmName> + first 8 chars of id", full id in a title attribute
 */
const COLOURLESS = ['rgba(0, 0, 0, 0)', 'transparent'];

test.describe('UC07 S16b data display polish', () => {
  let alphaId: string;
  let betaId: string;
  test.beforeEach(async () => {
    await resetBusinessState();
    alphaId = (await registerCustomer('00000101', 'customer-alpha')).customerId;
    betaId = (await registerCustomer('00000102', 'customer-beta')).customerId;
    await activateRisk('customer-alpha', 2); // BALANCED
    await activateRisk('customer-beta', 4); // GROWTH
    await addPendingProposal(alphaId);
  });

  async function openList(page: Page, role = 'rm-alpha') {
    await openApp(page);
    await switchRole(page, role);
    await goTo(page, 'Khách phụ trách');
  }
  const row = (page: Page, name: string) => page.getByRole('row', { name: new RegExp(name) });
  const desktopOnly = (testInfo: { project: { name: string } }) => test.skip(testInfo.project.name !== 'desktop', 'desktop layout check');

  test('AC6 drift badge shows only the number when count > 0 and the full label stays as screen-reader text', async ({ page }) => {
    await addHolding(betaId, 'e2e-risk-5-fund', '500000.00', '2026-01-15T04:00:00.000Z', 5);
    await activateRisk('customer-beta', 0, 1); // downgrade over a risky holding queues one drift check
    await openList(page);
    const betaCell = row(page, 'Khách hàng demo Beta').locator('[data-label="Kiểm tra chờ"]');
    const badge = betaCell.getByTestId('drift-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText('1');
    await expect(betaCell).toContainText('Kiểm tra danh mục chờ: 1'); // sr-only label keeps the contract
    // Every element carrying the long label is visually hidden (<= 1px box), never a visible wrapped label.
    const visibleLabels = await betaCell.evaluate(cell => [...cell.querySelectorAll('*')]
      .filter(element => [...element.childNodes].some(node => node.nodeType === 3 && (node.textContent ?? '').includes('Kiểm tra danh mục chờ')))
      .map(element => element.getBoundingClientRect()).filter(rect => rect.width > 1 || rect.height > 1).length);
    expect(visibleLabels, 'visible elements containing the long drift label').toBe(0);
    const height = (await betaCell.boundingBox())!.height;
    expect(height, 'drift cell must not grow tall from a wrapped label').toBeLessThan(80);
  });

  test('AC6 count 0 shows no badge, only a muted 0 or dash', async ({ page }) => {
    await openList(page);
    const alphaCell = row(page, 'Khách hàng demo Alpha').locator('[data-label="Kiểm tra chờ"]');
    await expect(alphaCell).toBeVisible();
    await expect(alphaCell.getByTestId('drift-badge')).toHaveCount(0);
    await expect(alphaCell).toContainText('Kiểm tra danh mục chờ: 0'); // sr-only label
    const muted = alphaCell.getByTestId('drift-zero');
    await expect(muted).toBeVisible();
    await expect(muted).toHaveText(/^(0|—)$/);
    const colour = await muted.evaluate(element => getComputedStyle(element).color);
    const body = await page.evaluate(() => getComputedStyle(document.body).color);
    expect(colour, 'zero state is muted, not body colour').not.toBe(body);
  });

  test('AC7 list AUM is compact (tỷ/triệu) with the exact decimal value in the title; detail keeps the exact value', async ({ page }) => {
    await addHolding(alphaId, 'e2e-fund-a', '1730000000.00', '2026-01-15T04:00:00.000Z');
    await addHolding(betaId, 'e2e-fund-b', '25000000.00', '2026-01-15T04:00:00.000Z');
    await openList(page);
    const alphaAum = row(page, 'Khách hàng demo Alpha').locator('[data-label="AUM"]');
    await expect(alphaAum).toContainText(/1,7\d? tỷ/);
    await expect(alphaAum).not.toContainText('1.730.000.000');
    await expect(alphaAum.locator('[title*="1.730.000.000"]')).toHaveCount(1); // exact value reachable by tooltip
    const betaAum = row(page, 'Khách hàng demo Beta').locator('[data-label="AUM"]');
    await expect(betaAum).toContainText(/25 triệu/);
    await expect(betaAum.locator('[title*="25.000.000"]')).toHaveCount(1);
    await page.getByRole('link', { name: 'Khách hàng demo Alpha' }).click();
    await expect(page.getByRole('region', { name: 'Tài sản quản lý (AUM)' })).toContainText('1.730.000.000');
  });

  test('AC-R2 desktop list has a Tiền mặt column header and a cash cell per row', async ({ page }, testInfo) => {
    desktopOnly(testInfo);
    await openList(page);
    await expect(page.getByRole('columnheader', { name: 'Tiền mặt' })).toBeVisible();
    await expect(page.getByRole('columnheader')).toHaveCount(7);
    await expect(row(page, 'Khách hàng demo Alpha').locator('[data-label="Tiền mặt"]')).toBeVisible();
  });

  test('AC8 detail risk level is a coloured badge', async ({ page }) => {
    await openList(page);
    await page.getByRole('link', { name: 'Khách hàng demo Alpha' }).click();
    const badge = page.getByTestId('risk-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText('Cân bằng');
    const bg = await badge.evaluate(element => getComputedStyle(element).backgroundColor);
    expect(COLOURLESS, `risk badge background ${bg}`).not.toContain(bg);
    await expect(page.getByText('Hồ sơ rủi ro: Cân bằng')).toBeVisible(); // label contract kept
  });

  test('AC8 Làm mới sits in the page header next to the title with a Cập nhật lúc timestamp', async ({ page }) => {
    await openList(page);
    await page.getByRole('link', { name: 'Khách hàng demo Alpha' }).click();
    const title = page.getByRole('heading', { level: 2, name: 'Khách hàng demo Alpha' });
    await expect(title).toBeVisible();
    const header = page.locator('header').filter({ has: title });
    const refresh = header.getByRole('button', { name: 'Làm mới' });
    await expect(refresh).toBeVisible();
    await expect(page.getByRole('button', { name: 'Làm mới' })).toHaveCount(1);
    await expect(header).toContainText(/Cập nhật lúc\s+\d/);
    const [t, b] = [(await title.boundingBox())!, (await refresh.boundingBox())!];
    expect(Math.abs((t.y + t.height / 2) - (b.y + b.height / 2)), 'button vertically near the title').toBeLessThan(40);
    const aumBox = (await page.getByRole('region', { name: 'Tài sản quản lý (AUM)' }).boundingBox())!;
    expect(b.y + b.height, 'button is in the header, above the first content panel (AUM)').toBeLessThanOrEqual(aumBox.y);
  });

  test('AC8 provenance SYNTHETIC_P3_READ_BRIDGE is shown as a readable label with the raw code only in a title', async ({ page }) => {
    await addHolding(alphaId, 'e2e-fund-a', '1250000.50', '2026-01-15T04:59:00.000Z');
    await openList(page);
    await page.getByRole('link', { name: 'Khách hàng demo Alpha' }).click();
    const aum = page.getByRole('region', { name: 'Tài sản quản lý (AUM)' });
    await expect(aum).toContainText('Nguồn: Dữ liệu tổng hợp (demo)');
    await expect(aum).not.toContainText('SYNTHETIC_P3_READ_BRIDGE');
    await expect(aum.locator('[title="SYNTHETIC_P3_READ_BRIDGE"]')).toHaveCount(1);
  });

  test('AC14 filters are a flat bar (no full border box, no shadow)', async ({ page }) => {
    await openList(page);
    const bar = page.getByTestId('customer-filters');
    await expect(bar).toBeVisible();
    await expect(bar.getByLabel('Tìm theo tên')).toBeVisible();
    const style = await bar.evaluate(element => {
      const s = getComputedStyle(element);
      return { shadow: s.boxShadow, widths: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth].map(parseFloat) };
    });
    expect(style.shadow).toBe('none');
    expect(style.widths.every(width => width > 0), `boxed border ${style.widths}`).toBe(false);
  });

  test('AC14 account numbers in onboarding are not monospace', async ({ page }) => {
    await openApp(page);
    await switchRole(page, 'rm-alpha');
    await goTo(page, 'Đăng ký khách hàng');
    await page.getByLabel('Mã CIF hoặc định danh').fill('00000101');
    await page.getByRole('button', { name: 'Tra cứu' }).click();
    const account = page.getByRole('radio', { name: /synthetic-vnd-account-101/ });
    await expect(account).toBeVisible();
    const family = await page.getByText('synthetic-vnd-account-101', { exact: false }).last()
      .evaluate(element => getComputedStyle(element).fontFamily);
    expect(family, 'account number font').not.toMatch(/mono|consolas|courier/i);
    const body = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(family).toBe(body);
  });

  test.describe('Assignments (leader)', () => {
    async function openAssignments(page: Page) {
      await openApp(page);
      await switchRole(page, 'leader-alpha');
      await goTo(page, 'Phân công RM');
    }
    async function addLoad(rmId: string, count: number, tag: string) {
      await sql(`INSERT INTO customers(id,cif_id,name,created_at)
        SELECT gen_random_uuid(),$2::text||lpad(n::text,5,'0'),'Khách hàng tải '||$2::text||n::text,now() FROM generate_series(1,$1::int) n`, [count, tag]);
      await sql(`INSERT INTO rm_assignment_history(id,customer_id,rm_id,team_id,valid_from,valid_to,provisional)
        SELECT gen_random_uuid(),c.id,$1,t.team_id,now(),NULL,false FROM customers c
        CROSS JOIN (SELECT team_id FROM rm_assignment_history WHERE customer_id=$2 AND valid_to IS NULL) t WHERE c.cif_id LIKE $3`,
      [rmId, alphaId, `${tag}%`]);
    }
    async function expectRm(scope: Locator, name: string, fullId: string, label: string) {
      await expect(scope, `${label} shows the RM name`).toContainText(name);
      await expect(scope, `${label} shows a short id`).toContainText(fullId.slice(0, 8));
      await expect(scope, `${label} must not print the long UUID`).not.toContainText(fullId);
      await expect(scope.locator(`[title="${fullId}"]`).first(), `${label} keeps the full id in title`).toBeAttached();
    }

    test('AC4 RM table, current RM fact and target options show rmName with a short id, full id in title', async ({ page }) => {
      await openAssignments(page);
      const directory = page.getByRole('region', { name: 'Danh sách RM' });
      await expectRm(directory.getByRole('row', { name: /rm-alpha/ }), 'rm-alpha', ids.rmAlpha, 'RM table row');
      await page.getByLabel('Chọn khách hàng').selectOption(alphaId);
      await page.getByRole('button', { name: 'Tải thông tin khách hàng' }).click();
      const panel = page.getByRole('region', { name: 'Khách hàng cần chuyển' });
      await expect(panel).toBeVisible();
      await expectRm(panel, 'rm-alpha', ids.rmAlpha, 'current RM fact');
      const target = page.getByLabel('RM nhận');
      const optionTexts = await target.evaluate(select => [...(select as HTMLSelectElement).options].map(option => option.textContent ?? ''));
      const beta = optionTexts.find(text => text.includes('rm-beta'));
      expect(beta, 'target option shows rm-beta').toBeTruthy();
      expect(beta).toContain(ids.rmBeta.slice(0, 8));
      expect(beta).toContain('/80');
      expect(optionTexts.some(text => text.includes(ids.rmBeta)), 'no long UUID in option text').toBe(false);
      await target.selectOption(ids.rmBeta); // option value stays the real id
      await page.getByLabel('Lý do chuyển').fill('Cân đối tải công việc giữa các RM');
      await page.getByRole('button', { name: 'Xác nhận chuyển' }).click();
      const dialog = page.getByRole('dialog', { name: 'Xác nhận chuyển RM' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(/rm-alpha[\s\S]*rm-beta/);
      await expect(dialog).not.toContainText(ids.rmAlpha);
      await expect(dialog).not.toContainText(ids.rmBeta);
      await expect(dialog.locator(`[title="${ids.rmAlpha}"]`).first()).toBeAttached();
      await expect(dialog.locator(`[title="${ids.rmBeta}"]`).first()).toBeAttached();
    });

    test('AC9 load bar is a progressbar with 2/80 values, level ok and "2/80 khách" text', async ({ page }, testInfo) => {
      await openAssignments(page);
      const alphaRow = page.getByRole('region', { name: 'Danh sách RM' }).getByRole('row', { name: /rm-alpha/ });
      await expect(alphaRow).toContainText('2/80 khách');
      if (testInfo.project.name !== 'desktop') return; // the bar itself is asserted on desktop
      const bar = alphaRow.locator('[role="progressbar"]');
      await expect(bar).toHaveCount(1);
      await expect(bar).toHaveAttribute('aria-valuenow', '2');
      await expect(bar).toHaveAttribute('aria-valuemax', '80');
      await expect(bar).toHaveAttribute('aria-valuemin', '0');
      await expect(bar).toHaveAttribute('data-level', 'ok');
      expect((await bar.boundingBox())!.width).toBeGreaterThan(0);
    });

    test('AC9 thresholds: 55/80 ok, 56/80 warn (70%), 72/80 warn (90%), 73/80 high', async ({ page }, testInfo) => {
      desktopOnly(testInfo);
      const steps: Array<[number, number, string]> = [[55, 55, 'ok'], [1, 56, 'warn'], [16, 72, 'warn'], [1, 73, 'high']];
      let batch = 0;
      for (const [add, total, level] of steps) {
        await addLoad(ids.rmBeta, add, `LD${batch++}`);
        await openAssignments(page);
        const betaRow = page.getByRole('region', { name: 'Danh sách RM' }).getByRole('row', { name: /rm-beta/ });
        await expect(betaRow).toContainText(`${total}/80 khách`);
        const bar = betaRow.locator('[role="progressbar"]');
        await expect(bar).toHaveAttribute('aria-valuenow', String(total));
        await expect(bar, `${total}/80`).toHaveAttribute('data-level', level);
      }
    });

    test('AC9 Tải thông tin khách hàng aligns with the search input and the customer select (bottom edges within 4px)', async ({ page }, testInfo) => {
      desktopOnly(testInfo);
      await openAssignments(page);
      const button = (await page.getByRole('button', { name: 'Tải thông tin khách hàng' }).boundingBox())!;
      const input = (await page.getByLabel('Tìm khách hàng').boundingBox())!;
      const select = (await page.getByLabel('Chọn khách hàng').boundingBox())!;
      expect(Math.abs(button.y + button.height - (input.y + input.height)), 'button vs search input bottom').toBeLessThanOrEqual(4);
      expect(Math.abs(button.y + button.height - (select.y + select.height)), 'button vs select bottom').toBeLessThanOrEqual(4);
      await expectNoHorizontalOverflow(page);
    });
  });
});

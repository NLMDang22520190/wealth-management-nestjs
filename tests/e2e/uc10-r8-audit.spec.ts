import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { activateRisk, addHolding, addPendingProposal, api, ids, registerCustomer, resetBusinessState, sql, tokenFor } from './support/stack';
import { differentCode, goTo, openApp, otpBox, readDemoInbox, switchRole, typeOtp } from './support/ui';

/**
 * R8 UI audit fix round (spec 01-spec-r8-ui-audit.md, AC A1-A3, B1-B6). Contract (see .agents/handoff/02-tests-R8.md):
 *  A1 sidebar focus ring is a solid rgb(255, 216, 119) (--sidebar-ring) as outline or box-shadow.
 *  A2 after a result/success replaces the focused control, document.activeElement is an element with tabindex="-1" (or role status/alert)
 *     inside the result region; never <body>.
 *  A3 invalid submit: field has aria-invalid="true", aria-describedby -> visible inline text, and the field is focused.
 *     Inline error text must NOT use role="alert" (existing specs match the single page-level alert).
 *  B2 visible drift badge / zero is aria-hidden; the sr-only "Kiểm tra danh mục chờ: N" is the only exposed text.
 *  B4 Panel ids are unique per instance (useId).
 *  B5 token --gold-soft (= #f0d39a) replaces the hard-coded colours; Alert gets a `warning` variant.
 */
const RING = 'rgb(255, 216, 119)';
const desktopOnly = (info: { project: { name: string } }) => test.skip(info.project.name !== 'desktop', 'desktop-only check');

async function createInvite(cif: string, rmActor = 'rm-alpha') {
  const token = await tokenFor(rmActor);
  const lookup = await api('/onboarding/customer-lookup', { token, body: { cifRef: cif } });
  expect(lookup.status).toBe(200);
  const created = await api('/onboarding/requests', { token, key: `e2e-r8-invite-${cif}-${Math.random()}`,
    body: { cifRef: cif, selectedAccountId: lookup.body.accounts[0].id } });
  expect(created.status).toBe(201);
  return created.body.id as string;
}

/** Focus is not on <body> and sits on a tabindex=-1 / status / alert element inside the result region. */
async function expectFocusInResult(region: Locator) {
  await expect(region).toBeVisible();
  await expect.poll(() => region.evaluate(el => {
    const active = document.activeElement;
    if (!active || active === document.body || !el.contains(active)) return 'not inside the result region';
    const announced = active.getAttribute('tabindex') === '-1' || !!active.closest('[role="status"],[role="alert"]');
    return announced ? 'ok' : 'focused element is neither tabindex=-1 nor inside role=status/alert';
  }), { message: 'focus moves to the result' }).toBe('ok');
}

/** aria-invalid="true", aria-describedby -> non-empty visible text, and the control has focus. */
async function expectInvalidFocused(page: Page, field: Locator) {
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  const describedBy = await field.getAttribute('aria-describedby');
  expect(describedBy, 'aria-describedby present').toBeTruthy();
  const shown = await page.evaluate(value => value.split(/\s+/).map(id => {
    const el = document.getElementById(id); if (!el) return '';
    const box = el.getBoundingClientRect();
    return box.width > 1 && box.height > 1 && getComputedStyle(el).visibility !== 'hidden' ? (el.textContent ?? '').trim() : '';
  }).filter(Boolean), describedBy!);
  expect(shown.length, 'aria-describedby points to visible inline error text').toBeGreaterThan(0);
  await expect(field).toBeFocused();
}

test.describe('UC10 R8 audit - accessibility', () => {
  test.beforeEach(async () => { await resetBusinessState(); });

  test('A1 keyboard focus on "Vai trò demo" and "Chuyển vai" shows a #ffd877 ring', async ({ page }) => {
    await openApp(page);
    const ring = (target: Locator) => target.evaluate((el, colour) => {
      const s = getComputedStyle(el);
      const outline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 && s.outlineColor === colour;
      const shadow = [...s.boxShadow.matchAll(/rgb\(255, 216, 119\)\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px\s+([\d.]+)px/g)]
        .some(m => parseFloat(m[1]!) !== 0 || parseFloat(m[2]!) !== 0 || parseFloat(m[3]!) > 0 || parseFloat(m[4]!) > 0);
      return outline || shadow ? 'ring' : `outline ${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}; shadow ${s.boxShadow}`;
    }, RING);
    const select = page.getByLabel('Vai trò demo');
    await select.focus();
    await page.keyboard.press('Shift+Tab'); // switch to keyboard modality, then arrive by Tab
    await page.keyboard.press('Tab');
    await expect(select).toBeFocused();
    await expect.poll(() => ring(select), { message: 'select ring' }).toBe('ring');
    await page.keyboard.press('Tab');
    const button = page.getByRole('button', { name: 'Chuyển vai' });
    await expect(button).toBeFocused();
    await expect.poll(() => ring(button), { message: 'button ring' }).toBe('ring');
  });

  test('A1 keyboard focus on a sidebar navigation link shows the #ffd877 ring', async ({ page }) => {
    await openApp(page);
    await switchRole(page, 'rm-alpha');
    const link = page.getByRole('navigation', { name: 'Điều hướng chính' }).getByRole('link').first();
    await link.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(link).toBeFocused();
    await expect.poll(() => link.evaluate((el, colour) => {
      const s = getComputedStyle(el);
      return (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 && s.outlineColor === colour) || s.boxShadow.includes(colour);
    }, RING), { message: 'nav link ring' }).toBe(true);
  });

  test('A2 survey preview result takes focus', async ({ page }) => {
    await registerCustomer('00000101', 'customer-alpha');
    await openApp(page);
    await switchRole(page, 'customer-alpha');
    await goTo(page, 'Khảo sát rủi ro');
    for (let q = 1; q <= 10; q++) {
      await expect(page.getByText(`Câu ${q}/10`, { exact: true })).toBeVisible();
      await page.getByRole('radiogroup').getByRole('radio').nth(2).check();
      if (q < 10) await page.getByRole('button', { name: 'Câu tiếp' }).click();
    }
    await page.getByRole('button', { name: 'Xem kết quả dự kiến' }).click();
    await expectFocusInResult(page.getByRole('region', { name: 'Kết quả dự kiến' }));
  });

  test('A2 survey confirm success takes focus', async ({ page }) => {
    await registerCustomer('00000101', 'customer-alpha');
    await openApp(page);
    await switchRole(page, 'customer-alpha');
    await goTo(page, 'Khảo sát rủi ro');
    for (let q = 1; q <= 10; q++) {
      await expect(page.getByText(`Câu ${q}/10`, { exact: true })).toBeVisible();
      await page.getByRole('radiogroup').getByRole('radio').nth(2).check();
      if (q < 10) await page.getByRole('button', { name: 'Câu tiếp' }).click();
    }
    await page.getByRole('button', { name: 'Xem kết quả dự kiến' }).click();
    await expect(page.getByRole('region', { name: 'Kết quả dự kiến' })).toBeVisible();
    await page.getByRole('button', { name: 'Gửi mã OTP' }).click();
    const code = await readDemoInbox(page);
    await typeOtp(page, code);
    await page.getByRole('button', { name: 'Xác nhận hồ sơ rủi ro' }).click();
    await expect(page.getByText('Đã xác nhận hồ sơ rủi ro')).toBeVisible();
    await expectFocusInResult(page.getByRole('region', { name: 'Hoàn tất' }));
  });

  test('A2 invitation consent success takes focus', async ({ page }) => {
    await createInvite('00000101');
    await openApp(page);
    await switchRole(page, 'customer-alpha');
    await goTo(page, 'Lời mời dịch vụ');
    await page.getByRole('button', { name: 'Xem điều khoản' }).click();
    await page.getByLabel('Tôi đã đọc và đồng ý với điều khoản').check();
    await page.getByRole('button', { name: 'Gửi mã OTP' }).click();
    const code = await readDemoInbox(page);
    await typeOtp(page, code);
    await page.getByRole('button', { name: 'Xác nhận đồng ý' }).click();
    await expect(page.getByText('Đã đồng ý dịch vụ')).toBeVisible();
    await expectFocusInResult(page.getByRole('region', { name: 'Đăng ký dịch vụ' }));
  });

  test('A2 onboarding invite success takes focus', async ({ page }) => {
    await openApp(page);
    await switchRole(page, 'rm-alpha');
    await goTo(page, 'Đăng ký khách hàng');
    await page.getByLabel('Mã CIF hoặc định danh').fill('00000101');
    await page.getByRole('button', { name: 'Tra cứu' }).click();
    await page.getByRole('radio', { name: /synthetic-vnd-account-101/ }).check();
    await page.getByRole('button', { name: 'Tạo lời mời' }).click();
    await expect(page.getByText('Đã tạo lời mời')).toBeVisible();
    await expectFocusInResult(page.getByRole('region', { name: 'Lời mời đã gửi' }));
  });

  test('A3 onboarding CIF lookup with an empty (or blank) CIF marks the field invalid, describes it and focuses it', async ({ page }) => {
    await openApp(page);
    await switchRole(page, 'rm-alpha');
    await goTo(page, 'Đăng ký khách hàng');
    const cif = page.getByLabel('Mã CIF hoặc định danh');
    await page.getByRole('button', { name: 'Tra cứu' }).click();
    await expectInvalidFocused(page, cif);
    await page.getByRole('button', { name: 'Tra cứu' }).focus();
    await cif.fill('   ');
    await page.getByRole('button', { name: 'Tra cứu' }).click();
    await expectInvalidFocused(page, cif);
  });

  test('A3 assignments transfer form: no target, then empty reason, each marks its field invalid and focuses it', async ({ page }) => {
    const alphaId = (await registerCustomer('00000101', 'customer-alpha')).customerId;
    await activateRisk('customer-alpha', 2);
    await openApp(page);
    await switchRole(page, 'leader-alpha');
    await goTo(page, 'Phân công RM');
    await page.getByLabel('Chọn khách hàng').selectOption(alphaId);
    await page.getByRole('button', { name: 'Tải thông tin khách hàng' }).click();
    const panel = page.getByRole('region', { name: 'Khách hàng cần chuyển' });
    await expect(panel.getByLabel('RM nhận')).toBeEnabled();
    await panel.getByRole('button', { name: 'Xác nhận chuyển' }).click();
    await expectInvalidFocused(page, panel.getByLabel('RM nhận'));
    await panel.getByLabel('RM nhận').selectOption(ids.rmBeta);
    await panel.getByRole('button', { name: 'Xác nhận chuyển' }).click();
    await expectInvalidFocused(page, panel.getByLabel('Lý do chuyển'));
  });

  test('A3 invitation OTP rejected by the server marks the first OTP box invalid, describes it and focuses it', async ({ page }) => {
    await createInvite('00000101');
    await openApp(page);
    await switchRole(page, 'customer-alpha');
    await goTo(page, 'Lời mời dịch vụ');
    await page.getByRole('button', { name: 'Xem điều khoản' }).click();
    await page.getByLabel('Tôi đã đọc và đồng ý với điều khoản').check();
    await page.getByRole('button', { name: 'Gửi mã OTP' }).click();
    const code = await readDemoInbox(page);
    await typeOtp(page, differentCode(code));
    await page.getByRole('button', { name: 'Xác nhận đồng ý' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expectInvalidFocused(page, otpBox(page, 1));
  });

  test('B4 repeated Panel titles keep unique ids and every region label resolves to its own title', async ({ page }) => {
    await createInvite('00000101');
    await sql("UPDATE onboarding_requests SET status='EXPIRED' WHERE cif_id='00000101'");
    await createInvite('00000101');
    await openApp(page);
    await switchRole(page, 'customer-alpha');
    await goTo(page, 'Lời mời dịch vụ');
    const regions = page.getByRole('region', { name: /^Lời mời đăng ký dịch vụ/ });
    await expect(regions).toHaveCount(2);
    const audit = await page.evaluate(() => {
      const seen = new Map<string, number>();
      document.querySelectorAll('[id]').forEach(el => seen.set(el.id, (seen.get(el.id) ?? 0) + 1));
      const duplicates = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
      const dangling = [...document.querySelectorAll('[aria-labelledby]')]
        .filter(el => !el.getAttribute('aria-labelledby')!.split(/\s+/).every(id => document.getElementById(id))).length;
      const wrongTitle = [...document.querySelectorAll('[role="region"][aria-labelledby]')].filter(el => {
        const title = document.getElementById(el.getAttribute('aria-labelledby')!);
        return !title || !el.contains(title);
      }).length;
      return { duplicates, dangling, wrongTitle };
    });
    expect(audit.duplicates, 'duplicate element ids').toEqual([]);
    expect(audit.dangling, 'aria-labelledby pointing nowhere').toBe(0);
    expect(audit.wrongTitle, 'region labelled by a title outside itself').toBe(0);
  });
});

test.describe('UC10 R8 audit - data display and robustness', () => {
  let alphaId: string;
  let betaId: string;
  test.beforeEach(async () => {
    await resetBusinessState();
    alphaId = (await registerCustomer('00000101', 'customer-alpha')).customerId;
    betaId = (await registerCustomer('00000102', 'customer-beta')).customerId;
    await activateRisk('customer-alpha', 2);
    await activateRisk('customer-beta', 4);
    await addPendingProposal(alphaId);
  });

  async function openList(page: Page) {
    await openApp(page);
    await switchRole(page, 'rm-alpha');
    await goTo(page, 'Khách phụ trách');
  }
  const row = (page: Page, name: string) => page.getByRole('row', { name: new RegExp(name) });

  test('B1 compact AUM keeps the currency suffix', async ({ page }) => {
    await addHolding(alphaId, 'e2e-fund-a', '1730000000.00', '2026-01-15T04:00:00.000Z');
    await addHolding(betaId, 'e2e-fund-b', '25000000.00', '2026-01-15T04:00:00.000Z');
    await openList(page);
    await expect(row(page, 'Khách hàng demo Alpha').locator('[data-label="AUM"]')).toContainText(/1,73 tỷ\s₫/);
    await expect(row(page, 'Khách hàng demo Beta').locator('[data-label="AUM"]')).toContainText(/25 triệu\s₫/);
  });

  test('B2 the drift cell is read once: sr-only label exposed once, visible badge / zero aria-hidden', async ({ page }) => {
    await addHolding(betaId, 'e2e-risk-5-fund', '500000.00', '2026-01-15T04:00:00.000Z', 5);
    await activateRisk('customer-beta', 0, 1); // queues one drift check for beta
    await openList(page);
    for (const [name, testId, count] of [['Khách hàng demo Beta', 'drift-badge', 1], ['Khách hàng demo Alpha', 'drift-zero', 0]] as const) {
      const current = row(page, name);
      await expect(current.getByTestId(testId)).toHaveText(String(count));
      const exposed = await current.evaluate(el => [...el.querySelectorAll('*')]
        .filter(node => [...node.childNodes].some(child => child.nodeType === 3 && (child.textContent ?? '').includes('Kiểm tra danh mục chờ')))
        .filter(node => !node.closest('[aria-hidden="true"]')).map(node => node.textContent!.trim()));
      expect(exposed, `exposed "Kiểm tra danh mục chờ: ${count}" text in the ${name} row`).toEqual([`Kiểm tra danh mục chờ: ${count}`]);
      const hidden = await current.getByTestId(testId).evaluate(el => !!el.closest('[aria-hidden="true"]'));
      expect(hidden, `${testId} is aria-hidden`).toBe(true);
    }
  });

  test('B3 reduced motion: every spinner runs at most once; transitions are never "all"', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.route('**/onboarding/customer-lookup', async route => { await new Promise(resolve => setTimeout(resolve, 4000)); await route.continue(); });
    await openApp(page);
    await switchRole(page, 'rm-alpha');
    await goTo(page, 'Đăng ký khách hàng');
    await page.getByLabel('Mã CIF hoặc định danh').fill('00000101');
    await page.getByRole('button', { name: 'Tra cứu' }).click();
    await expect(page.getByText('Đang tra cứu…')).toBeVisible();
    await expect.poll(() => page.locator('.animate-spin').count(), { message: 'spinners visible while busy' }).toBeGreaterThanOrEqual(2);
    const spinners = await page.locator('.animate-spin').evaluateAll(els => els.map(el => {
      const s = getComputedStyle(el); return { count: s.animationIterationCount, name: s.animationName };
    }));
    for (const spinner of spinners) expect(spinner.count === '1' || spinner.name === 'none', `spinner animation ${JSON.stringify(spinner)}`).toBe(true);
  });

  test('B3 button, badge and progress indicator never transition "all"', async ({ page }) => {
    await openList(page);
    await expect(row(page, 'Khách hàng demo Alpha')).toBeVisible();
    const props = async (selector: string) => page.locator(selector).first().evaluate(el => getComputedStyle(el).transitionProperty);
    await expect(page.locator('[data-slot="button"]').first()).toBeVisible();
    const found: Record<string, string> = {
      button: await props('[data-slot="button"]'),
      badge: await props('[data-slot="badge"]'),
    };
    await switchRole(page, 'customer-alpha');
    await goTo(page, 'Khảo sát rủi ro');
    await expect(page.getByRole('progressbar', { name: 'Tiến độ khảo sát' })).toBeVisible();
    found.progress = await props('[data-slot="progress-indicator"]');
    for (const [name, value] of Object.entries(found)) {
      expect(value.split(',').map(part => part.trim()), `${name} transition-property`).not.toContain('all');
    }
  });

  test('B6 typing in "Tìm theo tên" sends at most 2 name searches', async ({ page }) => {
    await openList(page);
    await expect(row(page, 'Khách hàng demo Alpha')).toBeVisible();
    const searches: string[] = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname.endsWith('/rm/customers') && url.searchParams.has('name')) searches.push(url.searchParams.get('name')!);
    });
    await page.getByLabel('Tìm theo tên').pressSequentially('demo', { delay: 30 });
    await expect.poll(() => searches.includes('demo'), { message: 'final search for "demo" is sent' }).toBe(true);
    await page.waitForLoadState('networkidle');
    expect(searches.length, `name searches: ${searches.join(' | ')}`).toBeLessThanOrEqual(2);
  });

  test('B5 token --gold-soft (#f0d39a) colours "Đang dùng vai" and the demo badge', async ({ page }, info) => {
    desktopOnly(info);
    await openApp(page);
    await switchRole(page, 'rm-alpha');
    const result = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const rgb = (css: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)].join(','); };
      const token = getComputedStyle(document.documentElement).getPropertyValue('--gold-soft').trim();
      const colourOf = (text: string) => {
        const el = [...document.querySelectorAll('p,span')].find(node => node.children.length === 0 && node.textContent?.startsWith(text));
        return el ? rgb(getComputedStyle(el).color) : 'missing';
      };
      return { token, tokenRgb: token ? rgb(token) : 'unset', using: colourOf('Đang dùng vai'), badge: colourOf('Môi trường demo') };
    });
    expect(result.token, '--gold-soft is defined on :root').not.toBe('');
    expect(result.tokenRgb).toBe('240,211,154');
    expect(result.using, 'Đang dùng vai colour').toBe(result.tokenRgb);
    expect(result.badge, 'Môi trường demo colour').toBe(result.tokenRgb);
  });
});

test.describe('UC10 R8 audit - static token check (B5)', () => {
  test('B5 hard-coded colours are gone from App.tsx / ui.tsx and Alert has a warning variant', async ({}, info) => {
    desktopOnly(info);
    const read = (relative: string) => readFileSync(fileURLToPath(new URL(`../../apps/web/src/${relative}`, import.meta.url)), 'utf8');
    const app = read('App.tsx');
    const ui = read('ui.tsx');
    for (const literal of ['#f0d39a', '#102a4c']) expect(app.toLowerCase(), `App.tsx contains ${literal}`).not.toContain(literal);
    for (const literal of ['#f5fbf7', '#a9d6bd', '#efd9a3', 'bg-slate-400']) expect(ui.toLowerCase(), `ui.tsx contains ${literal}`).not.toContain(literal);
    expect(read('components/ui/alert.tsx'), 'Alert variants include warning').toMatch(/\bwarning\b/);
  });
});

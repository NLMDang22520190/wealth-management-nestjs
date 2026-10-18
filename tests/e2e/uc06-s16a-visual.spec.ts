import { expect, test } from '@playwright/test';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { activateRisk, addPendingProposal, ids, registerCustomer, resetBusinessState } from './support/stack';
import { goTo, openApp, switchRole } from './support/ui';

/**
 * S16a visual acceptance (spec R4, AC1 AC2 AC5 AC10 AC11 AC12 AC13 AC15). Observable computed-style / geometry checks.
 * Colours are normalised through a canvas so oklch()/color() computed values compare as plain sRGB.
 */
type Rgba = [number, number, number, number];
const GOLD = [212, 166, 74];

const isMobile = (info: TestInfo) => info.project.name === 'mobile';

async function toRgba(page: Page, css: string): Promise<Rgba> {
  return page.evaluate((value: string) => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0]!, d[1]!, d[2]!, d[3]! / 255] as [number, number, number, number];
  }, css);
}
const bgOf = async (page: Page, locator: Locator) => toRgba(page, await locator.evaluate(el => getComputedStyle(el).backgroundColor));
const isGold = (c: Rgba) => c[3] > 0.5 && Math.abs(c[0] - GOLD[0]!) < 8 && Math.abs(c[1] - GOLD[1]!) < 8 && Math.abs(c[2] - GOLD[2]!) < 8;

function luminance([r, g, b]: number[]) {
  const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
}
function contrast(a: number[], b: number[]) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** Effective text and background colour of an element (ancestor backgrounds composited, element opacity applied). */
async function effectiveColors(locator: Locator): Promise<{ fg: number[]; bg: number[] }> {
  return locator.evaluate(el => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const parse = (css: string): number[] => {
      ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data; return [d[0]!, d[1]!, d[2]!, d[3]! / 255];
    };
    const over = (top: number[], base: number[]) => {
      const a = top[3]!;
      return [0, 1, 2].map(i => top[i]! * a + base[i]! * (1 - a)).concat([1]);
    };
    const chain: Element[] = []; for (let n: Element | null = el; n; n = n.parentElement) chain.unshift(n);
    let backdrop = [255, 255, 255, 1];
    for (const node of chain.slice(0, -1)) backdrop = over(parse(getComputedStyle(node).backgroundColor), backdrop);
    let opacity = 1; for (const node of chain) opacity *= Number(getComputedStyle(node).opacity);
    const style = getComputedStyle(el);
    const layer = over(parse(style.backgroundColor), backdrop);
    const text = over(parse(style.color), layer);
    const mix = (c: number[]) => [0, 1, 2].map(i => c[i]! * opacity + backdrop[i]! * (1 - opacity));
    return { fg: mix(text), bg: mix(layer) };
  });
}

async function openSurvey(page: Page) {
  await openApp(page);
  await switchRole(page, 'customer-alpha');
  await goTo(page, 'Khảo sát rủi ro');
  await expect(page.getByText('Câu 1/10', { exact: true })).toBeVisible();
}
async function answerAll(page: Page, option = 2) {
  for (let q = 1; q <= 10; q++) {
    await expect(page.getByText(`Câu ${q}/10`, { exact: true })).toBeVisible();
    await page.getByRole('radiogroup').getByRole('radio').nth(option).check();
    if (q < 10) await page.getByRole('button', { name: 'Câu tiếp' }).click();
  }
}
async function openPreview(page: Page) {
  await openSurvey(page);
  await answerAll(page);
  await page.getByRole('button', { name: 'Xem kết quả dự kiến' }).click();
  const preview = page.getByRole('region', { name: 'Kết quả dự kiến' });
  await expect(preview).toContainText('Bản nháp, chưa có hiệu lực');
  return preview;
}
/** The sticky wrapper of the progress bar: nearest ancestor of the progressbar whose computed position is sticky. */
const stickyBar = (page: Page) => page.getByRole('progressbar', { name: 'Tiến độ khảo sát' }).locator('xpath=ancestor::*[1]');

test.describe('S16a visual refactor (AC1 AC2 AC5 AC10 AC11 AC12 AC13 AC15)', () => {
  let alphaId: string;
  test.beforeEach(async () => {
    await resetBusinessState();
    alphaId = (await registerCustomer('00000101', 'customer-alpha')).customerId;
  });

  test('AC1 the "10/10 câu" progress text is fully visible (not clipped) inside the viewport and the bar keeps usable width', async ({ page }) => {
    await openSurvey(page);
    await answerAll(page);
    const text = page.getByText(/^\s*10\/10 câu\s*$/);
    await expect(text).toBeVisible();
    const m = await text.evaluate(el => ({ sw: el.scrollWidth, cw: el.clientWidth, h: el.getBoundingClientRect().height, fs: parseFloat(getComputedStyle(el).fontSize) }));
    expect(m.sw, 'text is not clipped').toBeLessThanOrEqual(m.cw);
    expect(m.h, 'text stays on one line').toBeLessThan(m.fs * 2);
    const box = (await text.boundingBox())!;
    const vw = page.viewportSize()!.width;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, 'inside the viewport').toBeLessThanOrEqual(vw);
    const bar = await page.getByRole('progressbar', { name: 'Tiến độ khảo sát' }).boundingBox();
    expect(bar!.width, 'progress bar not squeezed to nothing').toBeGreaterThanOrEqual(80);
  });

  test('AC1 the sticky progress bar has an opaque background and vertical padding', async ({ page }) => {
    await openSurvey(page);
    const bar = stickyBar(page);
    expect(await bar.evaluate(el => getComputedStyle(el).position), 'wrapper of the progress bar is sticky').toBe('sticky');
    const bg = await bgOf(page, bar);
    expect(bg[3], 'opaque background').toBe(1);
    const pad = await bar.evaluate(el => { const s = getComputedStyle(el); return parseFloat(s.paddingTop) + parseFloat(s.paddingBottom); });
    expect(pad, 'padding around the bar').toBeGreaterThanOrEqual(12);
  });

  test('AC1 an answer scrolled into view (scrollIntoView start / nearest from above) is not hidden under the sticky progress bar', async ({ page }) => {
    await openSurvey(page);
    await page.addStyleTag({ content: 'main{padding-bottom:2400px !important}' }); // make the page scrollable on any viewport
    const row = page.getByRole('radiogroup').getByRole('radio').first().locator('xpath=ancestor::label[1]');
    for (const block of ['start', 'nearest'] as const) {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); // row is now above the viewport
      await row.evaluate((el, b) => el.scrollIntoView({ block: b }), block);
      const barBox = (await stickyBar(page).boundingBox())!;
      const rowBox = (await row.boundingBox())!;
      expect(rowBox.y, `answer row starts below the sticky bar (block: ${block})`).toBeGreaterThanOrEqual(barBox.y + barBox.height - 0.5);
    }
  });

  test('AC2 allocation values keep number and "%" on one line, "Trái phiếu" on one line, legend single column on mobile', async ({ page }, info) => {
    const preview = await openPreview(page);
    const items = preview.getByRole('list', { name: 'Phân bổ tài sản' }).getByRole('listitem');
    await expect(items).toHaveCount(4);
    for (let i = 0; i < 4; i++) {
      const pct = items.nth(i).getByText(/^\s*\d+\s*%\s*$/);
      const m = await pct.evaluate(el => ({ h: el.getBoundingClientRect().height, fs: parseFloat(getComputedStyle(el).fontSize) }));
      expect(m.h, `percent value ${i} on one line`).toBeLessThan(m.fs * 2);
    }
    const label = items.filter({ hasText: 'Trái phiếu' }).getByText('Trái phiếu', { exact: true });
    const lm = await label.evaluate(el => ({ h: el.getBoundingClientRect().height, fs: parseFloat(getComputedStyle(el).fontSize) }));
    expect(lm.h, '"Trái phiếu" on one line').toBeLessThan(lm.fs * 2);
    if (isMobile(info)) {
      const xs = await items.evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().left)));
      expect(new Set(xs).size, 'legend is a single column at 375px').toBe(1);
    }
  });

  test('AC5 "Chuyển vai" is an outline button (transparent fill, visible border), not the gold accent', async ({ page }) => {
    await openApp(page);
    const button = page.getByRole('button', { name: 'Chuyển vai' });
    const bg = await bgOf(page, button);
    expect(isGold(bg), 'not gold-filled').toBe(false);
    expect(bg[3], 'transparent or near-transparent fill').toBeLessThanOrEqual(0.2);
    const border = await button.evaluate(el => { const s = getComputedStyle(el); return { w: parseFloat(s.borderTopWidth), style: s.borderTopStyle, color: s.borderTopColor }; });
    expect(border.w).toBeGreaterThanOrEqual(1);
    expect(border.style).not.toBe('none');
    expect((await toRgba(page, border.color))[3], 'border is visible').toBeGreaterThan(0);
  });

  test('AC10 the "sẽ bị hủy" warning is an amber alert box above the confirm button in the dialog', async ({ page }) => {
    await activateRisk('customer-alpha', 2);
    await addPendingProposal(alphaId);
    await openApp(page);
    await switchRole(page, 'leader-alpha');
    await goTo(page, 'Phân công RM');
    await page.getByLabel('Chọn khách hàng').selectOption(alphaId);
    await page.getByRole('button', { name: 'Tải thông tin khách hàng' }).click();
    await expect(page.getByRole('region', { name: 'Khách hàng cần chuyển' })).toBeVisible();
    await page.getByLabel('RM nhận').selectOption(ids.rmBeta);
    await page.getByLabel('Lý do chuyển').fill('Cân đối tải công việc giữa các RM');
    await page.getByRole('button', { name: 'Xác nhận chuyển' }).click();
    const dialog = page.getByRole('dialog', { name: 'Xác nhận chuyển RM' });
    await expect(dialog).toBeVisible();
    const warning = dialog.getByText(/sẽ bị hủy/);
    await expect(warning).toContainText('1 đề xuất đang chờ duyệt sẽ bị hủy');
    const box = warning.locator('xpath=ancestor-or-self::*[@role="alert" or @role="note"][1]');
    await expect(box, 'warning lives in an element with role alert/note').toHaveCount(1);
    const bg = await bgOf(page, box);
    expect(bg[3], 'filled').toBeGreaterThan(0.5);
    expect(bg.slice(0, 3).some(v => v < 250), 'not white').toBe(true);
    expect(bg[0]!, 'amber/warm: red channel dominates blue').toBeGreaterThan(bg[2]! + 15);
    const boxBox = (await box.boundingBox())!;
    const confirm = (await dialog.getByRole('button', { name: 'Chuyển khách hàng' }).boundingBox())!;
    expect(boxBox.y + boxBox.height, 'above the confirm button').toBeLessThanOrEqual(confirm.y);
    expect(confirm.y - (boxBox.y + boxBox.height), 'right above it').toBeLessThanOrEqual(64);
  });

  test('AC11 a submit in flight shows spinner + "Đang gửi…" on a disabled button, and the label returns after an error', async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/v1/onboarding/requests', async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      await gate;
      await route.fulfill({ status: 500, contentType: 'application/json', json: { code: 'INTERNAL', message: 'boom' } });
    });
    await openApp(page);
    await switchRole(page, 'rm-alpha');
    await goTo(page, 'Đăng ký khách hàng');
    await page.getByLabel('Mã CIF hoặc định danh').fill('00000101');
    await page.getByRole('button', { name: 'Tra cứu' }).click();
    await page.getByRole('radio', { name: /synthetic-vnd-account-101/ }).check();
    await page.getByRole('button', { name: 'Tạo lời mời' }).click();
    const sending = page.getByRole('button').filter({ hasText: 'Đang gửi…' });
    await expect(sending).toBeVisible();
    await expect(sending).toBeDisabled();
    await expect(sending.locator('svg[aria-hidden="true"]'), 'spinner icon').toHaveCount(1);
    release();
    await expect(page.getByRole('alert')).toBeVisible();
    const back = page.getByRole('button', { name: 'Tạo lời mời' });
    await expect(back).toBeVisible();
    await expect(back).toBeEnabled();
    await expect(back.locator('svg'), 'spinner is gone').toHaveCount(0);
    await expect(page.getByRole('button').filter({ hasText: 'Đang gửi…' })).toHaveCount(0);
  });

  test('AC12 inputs and selects use at least 16px text on mobile', async ({ page }, info) => {
    test.skip(!isMobile(info), 'mobile-only rule (iOS zoom-on-focus)');
    await openApp(page);
    const demo = await page.getByLabel('Vai trò demo').evaluate(el => parseFloat(getComputedStyle(el).fontSize));
    expect(demo, 'Vai trò demo select').toBeGreaterThanOrEqual(16);
    await switchRole(page, 'rm-alpha');
    await goTo(page, 'Đăng ký khách hàng');
    const cif = await page.getByLabel('Mã CIF hoặc định danh').evaluate(el => parseFloat(getComputedStyle(el).fontSize));
    expect(cif, 'CIF input').toBeGreaterThanOrEqual(16);
    await goTo(page, 'Khách phụ trách');
    for (const name of ['Tìm theo tên', 'Mức rủi ro', 'Sắp xếp theo']) {
      const size = await page.getByLabel(name).evaluate(el => parseFloat(getComputedStyle(el).fontSize));
      expect(size, name).toBeGreaterThanOrEqual(16);
    }
  });

  test('AC12 every survey answer row is at least 44px tall and clicking the far edge of the row selects it', async ({ page }) => {
    await openSurvey(page);
    const rows = page.getByRole('radiogroup').getByRole('radio').locator('xpath=ancestor::label[1]');
    const count = await rows.count();
    expect(count).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < count; i++) expect((await rows.nth(i).boundingBox())!.height, `answer row ${i}`).toBeGreaterThanOrEqual(44);
    const target = rows.nth(count - 1);
    const box = (await target.boundingBox())!;
    await target.click({ position: { x: box.width - 6, y: box.height / 2 } });
    await expect(page.getByRole('radiogroup').getByRole('radio').nth(count - 1)).toBeChecked();
  });

  test('AC12 keyboard focus on a link in the navy sidebar shows a visible, high-contrast indicator', async ({ page }) => {
    await openApp(page);
    await switchRole(page, 'rm-alpha');
    const nav = page.getByRole('navigation', { name: 'Điều hướng chính' });
    let focused = false;
    for (let i = 0; i < 40 && !focused; i++) {
      await page.keyboard.press('Tab');
      focused = await nav.locator('a:focus').count() > 0;
    }
    expect(focused, 'reached a nav link with Tab').toBe(true);
    const link = nav.locator('a:focus');
    const ring = await link.evaluate(el => {
      const s = getComputedStyle(el);
      return { outlineStyle: s.outlineStyle, outlineWidth: parseFloat(s.outlineWidth), outlineColor: s.outlineColor, shadow: s.boxShadow };
    });
    const hasOutline = ring.outlineStyle !== 'none' && ring.outlineWidth > 0;
    const hasShadow = ring.shadow !== 'none';
    expect(hasOutline || hasShadow, 'focus-visible outline or box-shadow').toBe(true);
    if (hasOutline) {
      const sidebar = await effectiveColors(page.locator('header').first());
      expect(contrast((await toRgba(page, ring.outlineColor)).slice(0, 3), sidebar.bg), 'outline vs navy sidebar').toBeGreaterThanOrEqual(3);
    }
  });

  test('AC13 "Kết quả dự kiến" shows Điểm and Rủi ro tối đa as prominent stats; Chứng chỉ quỹ is not gold; bar segments have gaps', async ({ page }) => {
    const preview = await openPreview(page);
    const score = preview.getByTestId('risk-score');
    await expect(score).toContainText('30');
    expect(await score.evaluate(el => parseFloat(getComputedStyle(el).fontSize)), 'Điểm value font-size').toBeGreaterThanOrEqual(24);
    await expect(preview).toContainText('Điểm');
    const max = preview.getByTestId('risk-max-product');
    await expect(max).toContainText('3');
    expect(await max.evaluate(el => parseFloat(getComputedStyle(el).fontSize)), 'Rủi ro tối đa value font-size').toBeGreaterThanOrEqual(24);
    await expect(preview).toContainText('Rủi ro sản phẩm tối đa');

    const fundItem = preview.getByRole('list', { name: 'Phân bổ tài sản' }).getByRole('listitem').filter({ hasText: 'Chứng chỉ quỹ' });
    const swatch = await bgOf(page, fundItem.getByTestId('allocation-swatch'));
    expect(swatch[3], 'swatch has a fill').toBeGreaterThan(0.5);
    expect(isGold(swatch), 'fund swatch is not gold').toBe(false);
    const segments = preview.getByTestId('allocation-bar').locator(':scope > *');
    await expect(segments).toHaveCount(4);
    expect(isGold(await bgOf(page, segments.nth(3))), 'fund segment is not gold').toBe(false);
    const gaps = await preview.getByTestId('allocation-bar').evaluate(bar => {
      const gap = parseFloat(getComputedStyle(bar).columnGap) || 0;
      const kids = [...bar.children];
      const margins = kids.slice(0, -1).map((c, i) => (parseFloat(getComputedStyle(c).marginRight) || 0) + (parseFloat(getComputedStyle(kids[i + 1]!).marginLeft) || 0));
      return { gap, margin: Math.min(...margins) };
    });
    expect(Math.max(gaps.gap, gaps.margin), 'visible gap between allocation segments').toBeGreaterThan(0);
  });

  test('AC15 the disabled "Trang trước" button text has at least 3:1 contrast against its background', async ({ page }) => {
    await activateRisk('customer-alpha', 2);
    await openApp(page);
    await switchRole(page, 'rm-alpha');
    await goTo(page, 'Khách phụ trách');
    const prev = page.getByRole('navigation', { name: 'Phân trang' }).getByRole('button', { name: 'Trang trước' });
    await expect(prev).toBeDisabled();
    const { fg, bg } = await effectiveColors(prev);
    expect(contrast(fg, bg), 'disabled text vs background').toBeGreaterThanOrEqual(3);
  });
});

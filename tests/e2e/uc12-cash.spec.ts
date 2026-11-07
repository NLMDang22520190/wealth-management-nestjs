import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { activateRisk, actors, registerCustomer, resetBusinessState } from './support/stack';
import { differentCode, expectNoHorizontalOverflow, goTo, openApp, readDemoInbox, switchRole, typeOtp } from './support/ui';

/** UC-05 to UC-08 through the UI. Failure scenarios come from the Core mock's special amounts (`platform/demo-core.ts`). */
const NAV = 'Tài khoản đầu tư';

async function placeOrder(page: Page, kind: 'Nạp tiền' | 'Rút tiền', amount: string) {
  await page.getByRole('radio', { name: kind }).check();
  await page.getByLabel('Số tiền (VND)').fill(amount);
  await page.getByRole('button', { name: 'Tiếp tục' }).click();
  await page.getByRole('button', { name: 'Xác nhận lệnh' }).click();
  const code = await readDemoInbox(page);
  await typeOtp(page, code);
  await page.getByRole('button', { name: 'Xác nhận OTP' }).click();
}

async function openCash(page: Page) {
  await openApp(page);
  await switchRole(page, actors.customerAlpha);
  await goTo(page, NAV);
  await expect(page.getByRole('region', { name: NAV })).toBeVisible();
}

const newOrder = (page: Page) => page.getByRole('button', { name: 'Tạo lệnh mới' }).click();

test.describe('UC12 P2 cash flows', () => {
  let customerId: string;
  test.beforeEach(async () => {
    await resetBusinessState();
    customerId = (await registerCustomer(actors.customerAlpha, actors.customerAlpha)).customerId;
    await activateRisk(actors.customerAlpha, 2);
  });

  test('UC-05 and UC-06: deposit then withdraw, balances, history and ledger entries, focus on the result', async ({ page }) => {
    await openCash(page);
    const summary = page.getByRole('region', { name: NAV });
    await expect(summary).toContainText('0 ₫');

    await placeOrder(page, 'Nạp tiền', '5000000');
    const result = page.getByRole('region', { name: 'Kết quả lệnh' });
    await expect(result).toContainText('Giao dịch thành công');
    await expect(result).toContainText('5.000.000');
    await expect(result.getByRole('heading', { name: 'Kết quả lệnh' })).toBeFocused();
    await expect(summary).toContainText('5.000.000');
    await expectNoHorizontalOverflow(page);

    await newOrder(page);
    await placeOrder(page, 'Rút tiền', '2000000');
    await expect(page.getByRole('region', { name: 'Kết quả lệnh' })).toContainText('Giao dịch thành công');
    await expect(summary).toContainText('3.000.000');

    const history = page.getByRole('region', { name: 'Lịch sử giao dịch' });
    await expect(history.getByRole('listitem').filter({ hasText: 'Rút tiền' }).first()).toContainText('2.000.000');
    await history.getByRole('button', { name: /Xem bút toán/ }).first().click();
    await expect(history).toContainText('Nợ');
    await expect(history).toContainText('Có');
    await expect(page.getByRole('region', { name: 'Kết quả giao dịch gần đây' })).toContainText('Nạp tiền');
    await expectNoHorizontalOverflow(page);
  });

  test('inline validation: below the minimum and above the available balance name the problem at the amount field', async ({ page }) => {
    await openCash(page);
    await page.getByRole('radio', { name: 'Nạp tiền' }).check();
    const amount = page.getByLabel('Số tiền (VND)');
    await amount.fill('999999');
    await page.getByRole('button', { name: 'Tiếp tục' }).click();
    await expect(amount).toHaveAttribute('aria-invalid', 'true');
    await expect(amount).toBeFocused();
    await expect(page.getByText('Số tiền tối thiểu là 1.000.000 ₫.')).toBeVisible();

    // A dot only groups thousands: "5000000.5" must not silently become 50.000.005.
    await amount.fill('5000000.5');
    await page.getByRole('button', { name: 'Tiếp tục' }).click();
    await expect(page.getByText('Nhập số tiền hợp lệ, ví dụ 5.000.000.')).toBeVisible();

    await page.getByRole('radio', { name: 'Rút tiền' }).check();
    await amount.fill('1000000');
    await page.getByRole('button', { name: 'Tiếp tục' }).click();
    await page.getByRole('button', { name: 'Xác nhận lệnh' }).click();
    await expect(page.getByText('Số tiền vượt số dư khả dụng. Tối đa có thể rút: 0 ₫.')).toBeVisible();
    await expect(amount).toBeFocused();
  });

  test('a wrong OTP ends the order and asks for a new one', async ({ page }) => {
    await openCash(page);
    await page.getByRole('radio', { name: 'Nạp tiền' }).check();
    await page.getByLabel('Số tiền (VND)').fill('1000000');
    await page.getByRole('button', { name: 'Tiếp tục' }).click();
    await page.getByRole('button', { name: 'Xác nhận lệnh' }).click();
    await typeOtp(page, differentCode(await readDemoInbox(page)));
    await page.getByRole('button', { name: 'Xác nhận OTP' }).click();
    await expect(page.getByRole('alert')).toContainText('Lệnh đã bị hủy');
    await expect(page.getByRole('heading', { name: 'Lệnh không hoàn tất' })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Tạo lệnh mới' })).toBeVisible();
  });

  test('UC-06 E4: Core refuses the withdrawal and the customer is told the money was refunded', async ({ page }) => {
    await openCash(page);
    await placeOrder(page, 'Nạp tiền', '5000000');
    await newOrder(page);
    await placeOrder(page, 'Rút tiền', '1000111');
    await expect(page.getByRole('region', { name: 'Kết quả lệnh' })).toContainText('Rút tiền không thành công, đã hoàn tiền');
    await expect(page.getByRole('region', { name: NAV })).toContainText('5.000.000');
  });

  test('process 2c: a stuck deposit goes through three rounds, back-office closes it, the customer sees the result', async ({ page }) => {
    await openCash(page);
    await placeOrder(page, 'Nạp tiền', '1000444');
    await expect(page.getByRole('region', { name: 'Kết quả lệnh' })).toContainText('Giao dịch đang xử lý');

    await switchRole(page, 'NV0004');
    await goTo(page, 'Giao dịch cần xử lý');
    const queue = page.getByRole('region', { name: 'Giao dịch cần xử lý' });
    await expect(queue).toContainText('Không có giao dịch nào cần xử lý');
    for (let round = 1; round <= 3; round += 1) {
      await page.getByRole('button', { name: 'Chạy đối soát' }).click();
      await expect(page.getByTestId('job-result')).toContainText(`lượt ${round}`);
    }
    await expect(queue).toContainText('CIF100001');
    await expect(queue).toContainText('1.000.444');
    await expectNoHorizontalOverflow(page);
    await queue.getByRole('button', { name: /Chốt giao dịch/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Chốt giao dịch' });
    await dialog.getByRole('button', { name: 'Xác nhận chốt' }).click();
    await expect(dialog.getByText('Nhập ghi chú đối chiếu.')).toBeVisible();
    await dialog.getByLabel('Kết quả').selectOption('SUCCESS');
    await dialog.getByLabel('Ghi chú').fill('Đã đối chiếu với Core');
    await dialog.getByRole('button', { name: 'Xác nhận chốt' }).click();
    await expect(queue).toContainText('Không có giao dịch nào cần xử lý');

    await switchRole(page, actors.customerAlpha);
    await goTo(page, NAV);
    await expect(page.getByRole('region', { name: NAV })).toContainText('1.000.444');
    await expect(page.getByRole('region', { name: 'Kết quả giao dịch gần đây' })).toContainText('Thành công');
  });

  test('UC-08: back-office runs settlement for a chosen date and reads the run report', async ({ page }) => {
    await openApp(page);
    await switchRole(page, 'NV0004');
    await goTo(page, 'Giao dịch cần xử lý');
    await page.getByLabel('Ngày chạy').fill('2026-11-15');
    await page.getByRole('button', { name: 'Chạy tất toán' }).click();
    await expect(page.getByTestId('job-result')).toContainText('Tất toán ngày 15/11/2026');
    await expect(page.getByRole('region', { name: 'Báo cáo tất toán' })).toContainText('15/11/2026');
    await expectNoHorizontalOverflow(page);
  });

  test('UC-07: the assigned RM reads the customer history; back-office finds it by CIF', async ({ page }) => {
    await openCash(page);
    await placeOrder(page, 'Nạp tiền', '5000000');

    await switchRole(page, actors.rmAlpha);
    await page.evaluate(id => { window.location.hash = `#/rm/customers/${id}`; }, customerId);
    const history = page.getByRole('region', { name: 'Lịch sử giao dịch' });
    await expect(history).toContainText('5.000.000');
    await expectNoHorizontalOverflow(page);

    await switchRole(page, 'NV0004');
    await goTo(page, 'Giao dịch cần xử lý');
    await page.getByLabel('Mã CIF').fill('CIF100001');
    await page.getByRole('button', { name: 'Tra cứu' }).click();
    await expect(page.getByRole('region', { name: 'Tra cứu giao dịch' })).toContainText('5.000.000');
  });
});

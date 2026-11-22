/**
 * Guard for `npm run reset:demo`, which DROPs a database. Everything that decides "is this safe to drop" lives here so a test can
 * pin it. Messages never contain the connection string: it carries the database password.
 */
export class ResetRefused extends Error {}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const DEFAULT_TARGET = 'wms_demo';
// wms_demo, wms_demo_two ...: never `postgres`, never the test databases (wms_test_*), never a name a shell or SQL could misread.
const TARGET_NAME = /^wms_demo[a-z0-9_]*$/;

/** @param {{ env: Record<string, string | undefined>, args: string[] }} input */
export function planReset({ env, args }) {
  let targetName = DEFAULT_TARGET;
  let yes = false;
  for (const arg of args) {
    if (arg === '--yes') yes = true;
    else if (arg.startsWith('--db=')) targetName = arg.slice('--db='.length);
    else throw new ResetRefused(`Tham số không hợp lệ: ${arg}. Chỉ dùng --yes và --db=<tên>.`);
  }
  if (env.NODE_ENV === 'production') throw new ResetRefused('Không chạy khi NODE_ENV=production.');

  let server;
  try { server = new URL(env.DATABASE_URL ?? ''); } catch { server = null; }
  if (!server || !/^postgres(ql)?:$/.test(server.protocol)) throw new ResetRefused('Thiếu hoặc sai DATABASE_URL (cần chuỗi kết nối PostgreSQL).');
  if (!LOOPBACK.has(server.hostname)) throw new ResetRefused('Chỉ reset database trên máy này (localhost hoặc 127.0.0.1); DATABASE_URL đang trỏ máy khác.');
  if (!TARGET_NAME.test(targetName)) throw new ResetRefused('Tên database phải bắt đầu bằng wms_demo (chữ thường, số, dấu gạch dưới), ví dụ --db=wms_demo.');

  const adminUrl = new URL(server);
  adminUrl.pathname = '/postgres';
  const targetUrl = new URL(server);
  targetUrl.pathname = `/${targetName}`;
  return { targetName, yes, adminUrl: adminUrl.toString(), targetUrl: targetUrl.toString() };
}

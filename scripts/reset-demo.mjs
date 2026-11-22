import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { planReset, ResetRefused } from './lib/reset-demo-guard.mjs';

// Rebuilds the local demo database from nothing: drop, create, migrate and load the team demo data (scripts/seed-demo.mjs).
// Run through `npm run reset:demo` (builds the API first). Add `-- --yes` to skip the question, `-- --db=wms_demo_x` for another name.
// Stop the API first or restart it afterwards: its connections are closed here.
function fail(message) {
  console.error(`reset:demo: ${message}`);
  process.exit(1);
}

let plan;
try {
  plan = planReset({ env: process.env, args: process.argv.slice(2) });
} catch (error) {
  if (error instanceof ResetRefused) fail(error.message);
  throw error;
}

if (!plan.yes) {
  if (!process.stdin.isTTY) fail(`Sẽ xóa toàn bộ database "${plan.targetName}". Không có terminal để hỏi xác nhận, thêm --yes để chạy.`);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await terminal.question(`Xóa toàn bộ database "${plan.targetName}" rồi nạp lại dữ liệu mẫu? Gõ yes để tiếp tục: `);
  terminal.close();
  if (answer.trim().toLowerCase() !== 'yes') fail('Đã hủy, không thay đổi gì.');
}

const admin = new pg.Client({ connectionString: plan.adminUrl });
try {
  await admin.connect();
  // The name was validated against /^wms_demo[a-z0-9_]*$/, so quoting it as an identifier is safe.
  await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [plan.targetName]);
  await admin.query(`DROP DATABASE IF EXISTS "${plan.targetName}"`);
  await admin.query(`CREATE DATABASE "${plan.targetName}"`);
} catch (error) {
  fail(`Không tạo lại được database "${plan.targetName}": ${error instanceof Error ? error.message : 'lỗi không rõ'}`);
} finally {
  await admin.end().catch(() => {});
}
console.log(`reset:demo: đã tạo lại "${plan.targetName}", đang migrate và nạp dữ liệu mẫu...`);

const seed = spawn(process.execPath, [fileURLToPath(new URL('./seed-demo.mjs', import.meta.url))], {
  env: { ...process.env, DATABASE_URL: plan.targetUrl, MOCK_AUTH_ENABLED: 'true', NODE_ENV: process.env.NODE_ENV ?? 'development' },
  stdio: 'inherit', shell: false, windowsHide: true,
});
seed.once('error', error => fail(`Không chạy được seed: ${error.message}`));
seed.once('close', code => {
  if (code !== 0) fail(`Seed thất bại (mã thoát ${code}).`);
  console.log(`reset:demo: xong. Khởi động lại API để dùng database "${plan.targetName}".`);
});

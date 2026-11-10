# AGENTS.md

Guidance for coding agents (Codex, Claude Code, Copilot, …) working in this repository.
Human-facing docs live in `README.md` (Vietnamese) and `docs/`. When this file and the code disagree, the code wins — fix this file in the same change.

## Project

WealthFlow – a university project for a Wealth Management System (WMS). This repo implements **Phân hệ 1: Khách hàng & Hồ sơ rủi ro** (onboarding, risk profiling, RM assignment, RM customer list) and **Phân hệ 2: Tài khoản & Dòng tiền** (deposit, withdrawal, reconciliation, cash history, term deposit settlement) and **Phân hệ 3: Sản phẩm & Định giá** (catalog, prices with maker-checker, Mark-to-Market valuation, drift alerts), with thin bridges to Phân hệ 4.

- `apps/api` – NestJS API (`/api/v1`), PostgreSQL via TypeORM migrations. One API, modules under `apps/api/src/modules/`:
  - `customer-risk/` – Phần 1 (onboarding, risk, RM assignment, RM customers, notifications/reminders)
  - `accounts-ledger/` – Phần 2 (`cash-order` UC-05/06, `reconciliation` process 2c, `maturity` UC-08, `cash-history` UC-07, `ledger.service` is the only writer of `ledger_entries`, `cash-jobs` the in-process schedule)
  - `portfolio-valuation/` – Phần 3 (`catalog.service` UC-09, `pricing.service` UC-10, `portfolio-valuer` + `portfolio-read.service` UC-11, `drift-scanner` + `portfolio-jobs` UC-12; `portfolio-scan.module` holds only the scanner so P1 and P2 can call it without a module cycle)
  - `advisory-trading/` – bridge for Phần 4 (owned by another team member; touch only through its contract)
  - `platform/` (http, validation, transactions, audit, OTP), `auth/` (mock IAM), `business/` (route wiring), `database/migrations/`
- `apps/web` – React 19 + Vite + shadcn/ui (`radix-nova` style, Radix, Tailwind CSS v4, lucide-react). Hash routing, Vietnamese UI.
- `tests/api` – Vitest integration tests on a real PostgreSQL. `tests/e2e` – Playwright on Microsoft Edge, projects `desktop` (1280px) and `mobile` (375px).
- `scripts/seed-demo.mjs` – runs migrations, then loads the team demo data once (`scripts/team-seed/wms_seed.sql`, copied byte for byte from the team; names and numbers are team-invented demo data; only change: its `demo-risk-v1-vi` questionnaire row is inserted as RETIRED because migration 008 already activates `demo-risk-v2-vi`). A second run is a no-op (skipped when `wms.staff_users` has rows). `infra/compose.yml` – demo PostgreSQL 15.
- Database: schema **`wms`** (the team DDL in `apps/api/src/database/team/wms_schema.sql`, applied by migration 008, which replaces the old `public` P1 tables; `public.migrations` stays in `public`). A local demo database from before R9 is rebuilt by 008 (its data is not carried over). `.gitattributes` marks the vendored `*.sql` as `-text` so their sha256 pins (checked by `tests/api/s21-team-seed.spec.ts` and the migration tests) survive Windows checkouts.
- Demo roles (login id = `employee_code` or CIF; the web picker lists them): **NV0001** Trưởng nhóm, **NV0002** and **NV0003** RM, customers **CIF100001–CIF100004**, **NV0004** Back-office (P2 screens, products, prices), **NV0005** Quản lý Back-office (`BACK_OFFICE_MANAGER`, price approvals only). The Core mock also knows CIF100005 (invitation only), **CIF100006** (eligible, for new invitations), **CIF100007** (blacklisted), **CIF100008** (credit group 3) and **CIF100009** (under 18).
- JSON naming (R9): API field names follow the team column in camelCase (`requestId`, `draftId`, `riskProfileId`, `notificationId`, `fullName`, `rmFullName`, `selectedCasaNo`, `accounts[].casaNo`); the full map is `docs/part1/05-api-json-names.vi.md`, P2 is in `docs/part2/01-overview.vi.md` and P3 in `docs/part3/01-overview.vi.md`. Rename only: paths, statuses and error codes did not change.
- Migration 009 is the one declared change to the team DDL: `portfolio_snapshots.snapshot_kind` (`DAILY`/`EVENT`), with the per-day unique applying to `DAILY` only. `s19` and `s21` list exactly that column and constraint as exceptions.
- P3 never writes `portfolio_holdings` (only UC-16 does), so accrued interest is computed on read. The team triggers on prices and bonds use `CURRENT_DATE`, so transactions writing them set `TIME ZONE 'Asia/Ho_Chi_Minh'` locally.
- The team trigger `fn_check_journal_balanced` names `ledger_entries` without a schema and runs at COMMIT, so every transaction that writes ledger entries must set `search_path` to `wms, public` locally. `LedgerService` does this; a new writer (P4 execution) must too or go through it.

## Setup and commands

Node **24.20.0** (`.nvmrc`). Install with `npm ci`. Copy `.env.example` to `.env` and set `JWT_SECRET` (see README).

| Task | Command |
|---|---|
| API (build + run, reads `.env`) | `npm run start:api` |
| Migrate + seed demo data | `npm run seed:demo` |
| Web dev server (proxies `/api` to :3000) | `npm run dev:web` |
| API integration tests | `npm run test:api` |
| E2E | `npm run test:e2e` |
| Lint / typecheck / build | `npm run lint` · `npm run typecheck` · `npm run build` |

- Tests need `WMS_TEST_POSTGRES_ADMIN_URL` pointing to a PostgreSQL role that can create databases; each run creates and drops its own database.
- E2E starts its own API on **:3000** and Vite on **:5173** (no reuse of running servers). Stop local dev servers first, and never run two E2E suites at once.
- E2E uses the installed Edge (`channel: 'msedge'`); no browser download.
- `CASH_JOBS_ENABLED` (default `true`) runs reconciliation and settlement in the API process, and `PORTFOLIO_JOBS_ENABLED` (default `true`) the 17:00 snapshot and drift scan; `tests/e2e/support/serve-api.mjs` turns both off and scenarios use the demo job buttons. The admin URL in `WMS_TEST_POSTGRES_ADMIN_URL` must contain a non-empty password, because the CLI tests assert that the password never appears in output.
- If `npm ci` fails with `EBUSY` on Windows, a sync client (e.g. OneDrive) is locking `node_modules`; retry or run from a clone outside the synced folder.

## Definition of done

Before saying a change is done: `npm run lint` (0 warnings), `npm run typecheck`, `npm run build`, `npm run test:api` and, for anything the UI can observe, `npm run test:e2e` — all green, run after the last edit. Report real numbers from that run; do not reuse old counts.

## Working rules

- **Tests first** for behaviour changes and bug fixes: write a failing test, see it fail for the right reason, then implement. Never weaken, skip or delete an existing test to make it pass; if a test looks wrong, say why and change it in its own commit.
- **Migrations are append-only.** Add a new file in `apps/api/src/database/migrations/` (next timestamp); never edit a shipped migration. Provide a working `down()`.
- **Module boundaries:** Phần 1 talks to Phần 2–4 only through their bridge services/contracts; do not query another module's tables directly from Phần 1 services.
- **Money** is a decimal string from the database to the UI. Never use JS floating-point arithmetic on amounts. Format with `Intl.NumberFormat('vi-VN')` (`apps/web/src/format.ts`).
- **Authorization is server-side.** Every endpoint checks role and scope (RM → own customers, LEADER → own team, CUSTOMER → own CIF, BACK_OFFICE → P2 operations, products and prices; BACK_OFFICE_MANAGER → price approvals only). Hiding a button is never the control.
- **Transactions:** one business transaction shares one entity manager for data, audit and outbox. Take capacity/RM locks before customer locks. Do not call Core or send OTP while holding data locks.
- **Idempotency:** mutating endpoints that accept `Idempotency-Key` bind it to actor, purpose, resource and payload; replays return the stored result.
- **Audit and logs** store metadata and filtered before/after only — never tokens, OTP codes or secrets. Failed OTP and denied access are audited (FAILURE / DENIED).
- **Mock auth, simulated Core and the demo OTP inbox** run only with `NODE_ENV` development/test and `MOCK_AUTH_ENABLED=true`; production config with mocks must keep failing at startup.
- **Business rules in code** (keep docs in sync when you change them): risk score 10–50 → Thận trọng (10–20) / Cân bằng (21–35) / Tăng trưởng (36–50); profile valid 12 calendar months (UTC); RM capacity 80; OTP TTL `OTP_TTL_SECONDS` (default 120, allowed 1–120 because the team `chk_otp_ttl` caps it at 120 s); RM transfer requires an ACTIVE service and a valid risk profile (`RISK_PROFILE_REQUIRED`); survey reminders at most once per customer per 24 h; deposit and withdrawal minimum 1,000,000 VND and 2 billion VND per Vietnam day each; a wrong or expired OTP fails the order; Core is given 2 s, then the order is PENDING; reconciliation every 5 minutes, back-office after 3 unanswered rounds; a credit raises and a debit lowers the investment account; interest = floor(principal × annual % × days held / 36500); a price change above 20% waits for a manager other than the person who entered it; a price older than 3 working days is labelled; drift alert at a deviation of 5 percentage points or more; snapshot and scan after 17:00 Vietnam time, and after a price change, a settlement or a new risk profile.
- **Questionnaire changes** go in as a new questionnaire version (migration); only one version may be ACTIVE (`ux_questionnaire_active`); confirmed profiles reference their version and stay immutable.
- **No new dependencies** without the maintainer's approval. Do not run `shadcn add/init/apply` without approval; reuse `apps/web/src/components/ui/*`.

## Web UI conventions

- Use the shadcn components in `components/ui` and the helpers in `apps/web/src/ui.tsx` (`Panel`, `PageTitle`, `Field` + `FieldError` + `invalidProps`, `BusyButton`, `ErrorAlert`, `Loading`, `Empty`, `RiskChip`, `OtpCodeInput`).
- Colours come from tokens in `apps/web/src/index.css` (`--primary`, `--sidebar*`, `--gold*`, `--ok*`, `--wait*`, `--risk-*`). No hard-coded hex/palette classes in components; add a token instead. Amber notices use `<Alert variant="warning">`.
- Accessibility baseline (checked by E2E): visible focus ring (sidebar uses `--sidebar-ring`); inline field errors with `aria-invalid` + `aria-describedby` and focus on the first invalid field; focus moves to result/success panels (`Panel focusOnMount`); persistent `role="status"` live regions; reduced motion stops infinite animations; no `transition-all`; inputs ≥16px on mobile; touch targets ≥44px; unique ids (`useId`).
- Native `<select>` and native radio inputs stay native — Playwright drives them with `selectOption`/`check`.
- Every layout must work at 375px without horizontal scrolling.

### E2E label contract (do not change without updating tests first)

Tests select by these exact Vietnamese strings/roles: heading `WealthFlow`; badge `Môi trường demo`; select `Vai trò demo`; button `Chuyển vai`; text `Đang dùng vai: <code>` (`NV0001`, `NV0002`, `NV0003`, `NV0004`, `NV0005`, `CIF100001`…`CIF100004`); role cards `Dùng vai <code>`; nav `Điều hướng chính`; OTP group `Mã OTP` with boxes `Chữ số 1`…`Chữ số 6` (maxLength 1); dialog `Xác nhận chuyển RM`; drift text `Kiểm tra danh mục chờ: N` (screen-reader text in the list); `Hồ sơ rủi ro: Cân bằng`; `Đề xuất chờ duyệt: 1`; region `Tài sản quản lý (AUM)`; `Điểm: N`; regions `Khảo sát rủi ro của khách hàng`, `Thông báo`, `Kết quả dự kiến`; P2: nav `Tài khoản đầu tư`, `Giao dịch cần xử lý`; regions `Tài khoản đầu tư`, `Kết quả lệnh`, `Kết quả giao dịch gần đây`, `Lịch sử giao dịch`, `Giao dịch cần xử lý`, `Báo cáo tất toán`, `Tra cứu giao dịch`; radios `Nạp tiền`, `Rút tiền`; field `Số tiền (VND)`; buttons `Tiếp tục`, `Xác nhận lệnh`, `Xác nhận OTP`, `Tạo lệnh mới`, `Chạy đối soát`, `Chạy tất toán`, `Xác nhận chốt`; dialog `Chốt giao dịch`; P3: nav `Sản phẩm`, `Giá và NAV`, `Duyệt giá`, `Danh mục`, `Cảnh báo lệch`; regions `Sản phẩm hiện có`, `Kết quả nhập giá`, `Giá đang chờ duyệt`, `Nhập giá từ CSV`, `Giá cần duyệt`, `Danh mục đầu tư`, `Tỷ trọng so với mục tiêu`, `Các khoản đang nắm giữ`, `Cảnh báo lệch tỷ trọng`; fields `Mã sản phẩm`, `Tên sản phẩm`, `Công ty quản lý quỹ`, `NAV ban đầu (VND)`, `Sản phẩm`, `Giá trị mới`, `Nội dung CSV`, `Lý do`; buttons `Thêm sản phẩm`, `Lưu giá`, `Nhập từ CSV`, `Chạy chụp danh mục`, `Xử lý giá <code>`, `Duyệt giá`, `Đánh dấu đã đọc: …`; dialog `Duyệt giá`; test ids `portfolio-aum`, `snapshot-result`. The customer list has 7 column headers on desktop. Search `tests/e2e` before renaming any visible text.

## Git and publishing

- Branch from `main`; keep commits focused (`test(red): …`, `feat(green): …`, `fix: …`, `docs: …`).
- This repository is **public**. Never commit `.env`, real credentials, personal data, course source documents (DOCX/HTML), CV material or screenshots with real data. Demo data is synthetic only.
- `.agents/handoff/`, `.local/`, `test-results/` and logs are git-ignored working areas; do not force-add them.
- Do not push or open pull requests unless the maintainer asks.

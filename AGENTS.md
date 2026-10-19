# AGENTS.md

Guidance for coding agents (Codex, Claude Code, Copilot, …) working in this repository.
Human-facing docs live in `README.md` (Vietnamese) and `docs/`. When this file and the code disagree, the code wins — fix this file in the same change.

## Project

WealthFlow – a university project for a Wealth Management System (WMS). This repo implements **Phân hệ 1: Khách hàng & Hồ sơ rủi ro** (onboarding, risk profiling, RM assignment, RM customer list) with thin bridges to Phân hệ 2–4.

- `apps/api` – NestJS API (`/api/v1`), PostgreSQL via TypeORM migrations. One API, modules under `apps/api/src/modules/`:
  - `customer-risk/` – Phần 1 (onboarding, risk, RM assignment, RM customers, notifications/reminders)
  - `accounts-ledger/`, `portfolio-valuation/`, `advisory-trading/` – bridges for Phần 2–4 (owned by other team members; touch only through their contracts)
  - `platform/` (http, validation, transactions, audit, OTP), `auth/` (mock IAM), `business/` (route wiring), `database/migrations/`
- `apps/web` – React 19 + Vite + shadcn/ui (`radix-nova` style, Radix, Tailwind CSS v4, lucide-react). Hash routing, Vietnamese UI.
- `tests/api` – Vitest integration tests on a real PostgreSQL. `tests/e2e` – Playwright on Microsoft Edge, projects `desktop` (1280px) and `mobile` (375px).
- `scripts/seed-demo.mjs` – runs migrations and seeds synthetic demo actors. `infra/compose.yml` – demo PostgreSQL 15.

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
- If `npm ci` fails with `EBUSY` on Windows, a sync client (e.g. OneDrive) is locking `node_modules`; retry or run from a clone outside the synced folder.

## Definition of done

Before saying a change is done: `npm run lint` (0 warnings), `npm run typecheck`, `npm run build`, `npm run test:api` and, for anything the UI can observe, `npm run test:e2e` — all green, run after the last edit. Report real numbers from that run; do not reuse old counts.

## Working rules

- **Tests first** for behaviour changes and bug fixes: write a failing test, see it fail for the right reason, then implement. Never weaken, skip or delete an existing test to make it pass; if a test looks wrong, say why and change it in its own commit.
- **Migrations are append-only.** Add a new file in `apps/api/src/database/migrations/` (next timestamp); never edit a shipped migration. Provide a working `down()`.
- **Module boundaries:** Phần 1 talks to Phần 2–4 only through their bridge services/contracts; do not query another module's tables directly from Phần 1 services.
- **Money** is a decimal string from the database to the UI. Never use JS floating-point arithmetic on amounts. Format with `Intl.NumberFormat('vi-VN')` (`apps/web/src/format.ts`).
- **Authorization is server-side.** Every endpoint checks role and scope (RM → own customers, LEADER → own team, CUSTOMER → own CIF). Hiding a button is never the control.
- **Transactions:** one business transaction shares one entity manager for data, audit and outbox. Take capacity/RM locks before customer locks. Do not call Core or send OTP while holding data locks.
- **Idempotency:** mutating endpoints that accept `Idempotency-Key` bind it to actor, purpose, resource and payload; replays return the stored result.
- **Audit and logs** store metadata and filtered before/after only — never tokens, OTP codes or secrets. Failed OTP and denied access are audited (FAILURE / DENIED).
- **Mock auth, simulated Core and the demo OTP inbox** run only with `NODE_ENV` development/test and `MOCK_AUTH_ENABLED=true`; production config with mocks must keep failing at startup.
- **Business rules in code** (keep docs in sync when you change them): risk score 10–50 → Thận trọng (10–20) / Cân bằng (21–35) / Tăng trưởng (36–50); profile valid 12 calendar months (UTC); RM capacity 80; OTP TTL `OTP_TTL_SECONDS` (default 120); RM transfer requires an ACTIVE service and a valid risk profile (`RISK_PROFILE_REQUIRED`); survey reminders at most once per customer per 24 h.
- **Questionnaire changes** go in as a new questionnaire version (migration); confirmed profiles reference their version and stay immutable.
- **No new dependencies** without the maintainer's approval. Do not run `shadcn add/init/apply` without approval; reuse `apps/web/src/components/ui/*`.

## Web UI conventions

- Use the shadcn components in `components/ui` and the helpers in `apps/web/src/ui.tsx` (`Panel`, `PageTitle`, `Field` + `FieldError` + `invalidProps`, `BusyButton`, `ErrorAlert`, `Loading`, `Empty`, `RiskChip`, `OtpCodeInput`).
- Colours come from tokens in `apps/web/src/index.css` (`--primary`, `--sidebar*`, `--gold*`, `--ok*`, `--wait*`, `--risk-*`). No hard-coded hex/palette classes in components; add a token instead. Amber notices use `<Alert variant="warning">`.
- Accessibility baseline (checked by E2E): visible focus ring (sidebar uses `--sidebar-ring`); inline field errors with `aria-invalid` + `aria-describedby` and focus on the first invalid field; focus moves to result/success panels (`Panel focusOnMount`); persistent `role="status"` live regions; reduced motion stops infinite animations; no `transition-all`; inputs ≥16px on mobile; touch targets ≥44px; unique ids (`useId`).
- Native `<select>` and native radio inputs stay native — Playwright drives them with `selectOption`/`check`.
- Every layout must work at 375px without horizontal scrolling.

### E2E label contract (do not change without updating tests first)

Tests select by these exact Vietnamese strings/roles: heading `WealthFlow`; badge `Môi trường demo`; select `Vai trò demo`; button `Chuyển vai`; text `Đang dùng vai: <actorId>`; nav `Điều hướng chính`; OTP group `Mã OTP` with boxes `Chữ số 1`…`Chữ số 6` (maxLength 1); dialog `Xác nhận chuyển RM`; drift text `Kiểm tra danh mục chờ: N` (screen-reader text in the list); `Hồ sơ rủi ro: Cân bằng`; `Đề xuất chờ duyệt: 1`; region `Tài sản quản lý (AUM)`; `Điểm: N`; regions `Khảo sát rủi ro của khách hàng`, `Thông báo`, `Kết quả dự kiến`. The customer list has 7 column headers on desktop. Search `tests/e2e` before renaming any visible text.

## Git and publishing

- Branch from `main`; keep commits focused (`test(red): …`, `feat(green): …`, `fix: …`, `docs: …`).
- This repository is **public**. Never commit `.env`, real credentials, personal data, course source documents (DOCX/HTML), CV material or screenshots with real data. Demo data is synthetic only.
- `.agents/handoff/`, `.local/`, `test-results/` and logs are git-ignored working areas; do not force-add them.
- Do not push or open pull requests unless the maintainer asks.

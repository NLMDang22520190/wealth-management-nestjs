-- =============================================================================
--  WMS - Wealth Management System (Hệ thống Quản lý tài sản số)
--  Schema CSDL PostgreSQL (>= 13), dựng từ tài liệu đặc tả hệ thống WMS
--
--  Bố cục:
--    0. Extension, schema, kiểu liệt kê (ENUM)
--    1. Nền tảng dùng chung: nhân sự, audit, OTP, idempotency, outbox
--    2. Phân hệ 1 - Khách hàng & Hồ sơ rủi ro        (UC-01 → UC-04)
--    3. Phân hệ 3 - Sản phẩm & Định giá danh mục       (UC-09 → UC-12)
--    4. Phân hệ 2 - Tài khoản & Dòng tiền, Sổ cái kép  (UC-05 → UC-08)
--    5. Phân hệ 4 - Tư vấn danh mục & Khớp lệnh        (UC-13 → UC-16)
--    6. Trigger thực thi quy tắc nghiệp vụ (BR-01, BR-15, BR-19, BR-25 ...)
--    7. View / hàm hỗ trợ (BR-06, BR-07, BR-08)
--    8. Dữ liệu danh mục chuẩn (ma trận Suitability & Target Allocation)
--    9. (Tùy chọn) Row-Level Security cho BR-08
--
--  Ghi chú: Phân hệ 3 được tạo trước Phân hệ 2 vì bảng tất toán tiền gửi
--  (UC-08) tham chiếu tới PORTFOLIO_HOLDINGS.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

DROP SCHEMA IF EXISTS wms CASCADE;
CREATE SCHEMA wms;
SET search_path TO wms, public;

-- -----------------------------------------------------------------------------
-- 0. KIỂU LIỆT KÊ
-- -----------------------------------------------------------------------------
-- Nhân sự & tác nhân
CREATE TYPE staff_role            AS ENUM ('RM', 'LEADER', 'BACK_OFFICE', 'BACK_OFFICE_MANAGER');
CREATE TYPE actor_role            AS ENUM ('CUSTOMER', 'RM', 'LEADER', 'BACK_OFFICE',
                                           'BACK_OFFICE_MANAGER', 'SYSTEM_JOB', 'SYSTEM_ENGINE');
CREATE TYPE audit_outcome         AS ENUM ('SUCCESS', 'FAILURE', 'DENIED');
CREATE TYPE otp_purpose           AS ENUM ('SERVICE_CONSENT', 'RISK_PROFILE_CONFIRM',
                                           'DEPOSIT', 'WITHDRAWAL', 'PROPOSAL_APPROVAL');
CREATE TYPE otp_status            AS ENUM ('ISSUED', 'VERIFIED', 'FAILED', 'EXPIRED');

-- Phân hệ 1
CREATE TYPE wealth_service_status AS ENUM ('PENDING_RISK_ASSESSMENT', 'ACTIVE');
CREATE TYPE onboarding_status     AS ENUM ('PENDING_CONSENT', 'CONFIRMED', 'EXPIRED');
CREATE TYPE reservation_status    AS ENUM ('ACTIVE', 'CONSUMED', 'EXPIRED');
CREATE TYPE questionnaire_status  AS ENUM ('ACTIVE', 'RETIRED');
CREATE TYPE risk_category         AS ENUM ('CONSERVATIVE', 'BALANCED', 'GROWTH');
CREATE TYPE notification_kind     AS ENUM ('RISK_SURVEY_REMINDER');

-- Phân hệ 2
CREATE TYPE account_status        AS ENUM ('ACTIVE', 'FROZEN', 'CLOSED');
CREATE TYPE cash_txn_type         AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'MATURITY_SETTLEMENT');
CREATE TYPE cash_txn_status       AS ENUM ('INIT', 'PENDING', 'SUCCESS', 'FAILED');
CREATE TYPE entry_side            AS ENUM ('DEBIT', 'CREDIT');
CREATE TYPE ledger_account_type   AS ENUM ('CUSTOMER_INVESTMENT', 'CORE_CLEARING',
                                           'TERM_DEPOSIT', 'INTEREST_PAYABLE',
                                           'BOND_HOLDING', 'FUND_HOLDING');

-- Phân hệ 3
CREATE TYPE asset_class           AS ENUM ('TERM_DEPOSIT', 'BOND', 'MUTUAL_FUND');
CREATE TYPE allocation_class      AS ENUM ('CASH', 'TERM_DEPOSIT', 'BOND', 'MUTUAL_FUND');
CREATE TYPE asset_status          AS ENUM ('ON_SALE', 'DISCONTINUED');
CREATE TYPE price_type            AS ENUM ('NAV', 'BOND_PRICE', 'INTEREST_RATE');
CREATE TYPE pricing_status        AS ENUM ('APPLIED', 'PENDING_APPROVAL', 'REJECTED');
CREATE TYPE approval_decision     AS ENUM ('APPROVED', 'REJECTED');
CREATE TYPE holding_status        AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE drift_alert_status    AS ENUM ('NEW', 'READ', 'ACTIONED', 'RESOLVED');
CREATE TYPE adjust_direction      AS ENUM ('INCREASE', 'DECREASE');

-- Phân hệ 4
CREATE TYPE proposal_status       AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'EXECUTING', 'EXECUTED',
                                           'REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED');
CREATE TYPE leg_action_type       AS ENUM ('BUY', 'SELL', 'OPEN', 'SETTLE');
CREATE TYPE session_status        AS ENUM ('IN_PROGRESS', 'COMMITTED', 'ROLLED_BACK');
CREATE TYPE invest_txn_status     AS ENUM ('INIT', 'EXECUTING_SELL', 'PENDING_SETTLEMENT',
                                           'EXECUTING_BUY', 'EXECUTED', 'FAILED');

-- Kiểu tiền: VND, 4 chữ số thập phân cho giá/NAV, 2 cho số tiền
CREATE DOMAIN money_vnd AS NUMERIC(20,2);
CREATE DOMAIN price_val AS NUMERIC(20,4);

-- =============================================================================
-- 1. NỀN TẢNG DÙNG CHUNG
-- =============================================================================

-- Nhóm RM (team) và nhân sự nội bộ (RM, Trưởng nhóm, Back-office) - đồng bộ từ Bank IAM/SSO
CREATE TABLE teams (
    team_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_code    VARCHAR(30)  NOT NULL UNIQUE,
    team_name    VARCHAR(200) NOT NULL,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE staff_users (
    staff_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    iam_subject  VARCHAR(100) NOT NULL UNIQUE,          -- subjectId từ IAM/SSO
    employee_code VARCHAR(30) NOT NULL UNIQUE,
    full_name    VARCHAR(200) NOT NULL,
    role         staff_role   NOT NULL,
    team_id      UUID REFERENCES teams(team_id),
    max_customers SMALLINT    NOT NULL DEFAULT 80,       -- BR-07: hạn mức 80 khách / RM
    is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT chk_staff_team CHECK (role NOT IN ('RM','LEADER') OR team_id IS NOT NULL),
    CONSTRAINT chk_staff_capacity CHECK (max_customers BETWEEN 1 AND 80)
);
COMMENT ON TABLE staff_users IS 'RM, Trưởng nhóm RM, Nhân viên/Quản lý Back-office';

-- Trưởng nhóm của từng team
ALTER TABLE teams ADD COLUMN leader_id UUID REFERENCES staff_users(staff_id);

-- Nhật ký kiểm toán hợp nhất (AuditEvent P1 + AuditLog P2/P3/P4) - BR-01, append-only
CREATE TABLE audit_logs (
    log_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    request_id      UUID,
    actor_id        VARCHAR(100) NOT NULL,             -- customer_id / staff_id / tên job
    actor_role      actor_role   NOT NULL,
    action          VARCHAR(60)  NOT NULL,             -- CREATE_PROPOSAL, INSERT_PRICE, APPROVE ...
    outcome         audit_outcome NOT NULL DEFAULT 'SUCCESS',
    reference_type  VARCHAR(60),                       -- PROPOSAL, CASH_TXN, ASSET ...
    reference_id    VARCHAR(100),
    old_value       JSONB,
    new_value       JSONB,
    payload_hash    CHAR(64),                          -- SHA-256 hex
    ip_address      INET,
    device_id       VARCHAR(128),                      -- header X-Device-Id (<= 128 ký tự)
    user_agent      TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_reference ON audit_logs (reference_type, reference_id);
CREATE INDEX ix_audit_actor     ON audit_logs (actor_id, created_at DESC);

-- Thử thách OTP (OtpChallenge P1 + OtpVerification P2/P4) - BR-03. Không lưu mã OTP thô.
CREATE TABLE otp_challenges (
    challenge_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id        VARCHAR(100) NOT NULL,
    purpose         otp_purpose  NOT NULL,
    operation_id    UUID         NOT NULL,             -- id lời mời / bản nháp / giao dịch / đề xuất
    payload_hash    CHAR(64)     NOT NULL,             -- gắn đúng nội dung cần ký
    code_hash       CHAR(64)     NOT NULL,
    salt            VARCHAR(64)  NOT NULL,
    status          otp_status   NOT NULL DEFAULT 'ISSUED',
    attempt_count   SMALLINT     NOT NULL DEFAULT 0,
    issued_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ  NOT NULL,             -- issued_at + 120 giây
    consumed_at     TIMESTAMPTZ,
    receipt_ref     UUID UNIQUE,                       -- mã chứng thực sau khi OTP hợp lệ
    signature       TEXT,
    CONSTRAINT chk_otp_ttl CHECK (expires_at <= issued_at + INTERVAL '120 seconds'),
    CONSTRAINT chk_otp_consumed CHECK (consumed_at IS NULL OR status = 'VERIFIED')
);
CREATE INDEX ix_otp_operation ON otp_challenges (operation_id, purpose);

-- Chống trùng lệnh ghi (BR-10, NFR-P1-04). TTL 300 giây cho nạp/rút.
CREATE TABLE idempotency_records (
    scope_actor     VARCHAR(100) NOT NULL,
    scope_purpose   VARCHAR(60)  NOT NULL,
    scope_resource  VARCHAR(100) NOT NULL DEFAULT '',
    idem_key        VARCHAR(100) NOT NULL,
    payload_hash    CHAR(64)     NOT NULL,
    response_status SMALLINT,
    response_body   JSONB,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ  NOT NULL DEFAULT now() + INTERVAL '300 seconds',
    PRIMARY KEY (scope_actor, scope_purpose, scope_resource, idem_key)
);

-- Transactional outbox: sự kiện gửi giữa các phân hệ (ServiceRegistered, RiskProfileConfirmed ...)
CREATE TABLE outbox_events (
    event_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type      VARCHAR(60)  NOT NULL,
    aggregate_type  VARCHAR(60)  NOT NULL,
    aggregate_id    UUID         NOT NULL,
    payload         JSONB        NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    published_at    TIMESTAMPTZ                         -- NULL = đang chờ xử lý
);
CREATE INDEX ix_outbox_pending ON outbox_events (created_at) WHERE published_at IS NULL;

-- =============================================================================
-- 2. PHÂN HỆ 1 - KHÁCH HÀNG & HỒ SƠ RỦI RO
-- =============================================================================

-- Danh mục phân loại rủi ro (BR-05, BR-18)
CREATE TABLE risk_categories (
    category          risk_category PRIMARY KEY,
    name_vi           VARCHAR(50) NOT NULL,
    min_score         SMALLINT    NOT NULL,
    max_score         SMALLINT    NOT NULL,
    max_product_risk  SMALLINT    NOT NULL CHECK (max_product_risk BETWEEN 1 AND 5),
    CONSTRAINT chk_score_range CHECK (min_score >= 10 AND max_score <= 50 AND min_score <= max_score)
);

-- Ma trận tỷ trọng mục tiêu (mục 2.5) - nguồn của RiskProfile.allocation
CREATE TABLE target_allocations (
    category          risk_category    NOT NULL REFERENCES risk_categories(category),
    allocation_class  allocation_class NOT NULL,
    target_weight     NUMERIC(5,2)     NOT NULL CHECK (target_weight BETWEEN 0 AND 100),
    drift_threshold   NUMERIC(5,2)     NOT NULL DEFAULT 5.00,   -- BR-16: lệch >= 5 điểm %
    PRIMARY KEY (category, allocation_class)
);

-- Khách hàng (gắn CIF duy nhất từ Core Banking)
CREATE TABLE customers (
    customer_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cif_id          VARCHAR(30)  NOT NULL UNIQUE,
    iam_subject     VARCHAR(100) UNIQUE,
    full_name       VARCHAR(200) NOT NULL,
    date_of_birth   DATE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Điều khoản dịch vụ có phiên bản, bất biến
CREATE TABLE service_terms (
    terms_version   VARCHAR(30) PRIMARY KEY,
    content         TEXT        NOT NULL,
    content_hash    CHAR(64)    NOT NULL UNIQUE,         -- SHA-256
    effective_from  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lời mời đăng ký do RM tạo (UC-01), hạn 72 giờ
CREATE TABLE onboarding_requests (
    request_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cif_id               VARCHAR(30)  NOT NULL,
    customer_name        VARCHAR(200) NOT NULL,
    selected_casa_no     VARCHAR(30)  NOT NULL,        -- CASA VND chính chủ chọn liên kết
    rm_id                UUID NOT NULL REFERENCES staff_users(staff_id),
    team_id              UUID NOT NULL REFERENCES teams(team_id),
    status               onboarding_status NOT NULL DEFAULT 'PENDING_CONSENT',
    terms_version        VARCHAR(30)  NOT NULL REFERENCES service_terms(terms_version),
    terms_hash           CHAR(64)     NOT NULL,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    expires_at           TIMESTAMPTZ  NOT NULL,
    confirmed_at         TIMESTAMPTZ,
    CONSTRAINT chk_onb_ttl CHECK (expires_at = created_at + INTERVAL '72 hours')
);
-- Tối đa 1 lời mời đang chờ ký / CIF
CREATE UNIQUE INDEX ux_onboarding_pending_cif ON onboarding_requests (cif_id)
    WHERE status = 'PENDING_CONSENT';

-- Giữ chỗ hạn mức RM khi tạo lời mời (BR-07, BR-P1-02) - composition 1-1 với lời mời
CREATE TABLE rm_capacity_reservations (
    reservation_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id      UUID NOT NULL UNIQUE REFERENCES onboarding_requests(request_id) ON DELETE CASCADE,
    rm_id           UUID NOT NULL REFERENCES staff_users(staff_id),
    status          reservation_status NOT NULL DEFAULT 'ACTIVE',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX ix_reservation_rm_active ON rm_capacity_reservations (rm_id) WHERE status = 'ACTIVE';

-- Bản ghi đồng ý điều khoản bằng OTP (append-only)
CREATE TABLE service_consents (
    consent_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id     UUID NOT NULL REFERENCES customers(customer_id),
    request_id      UUID NOT NULL UNIQUE REFERENCES onboarding_requests(request_id),
    terms_version   VARCHAR(30) NOT NULL REFERENCES service_terms(terms_version),
    terms_hash      CHAR(64)    NOT NULL,
    otp_receipt_ref UUID        NOT NULL UNIQUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bộ câu hỏi khảo sát có phiên bản (BR-04, BR-P1-03): 10 câu x 5 đáp án, điểm 1..5
CREATE TABLE risk_questionnaire_versions (
    version         VARCHAR(30) PRIMARY KEY,           -- vd: demo-risk-v2-vi
    questions       JSONB       NOT NULL,              -- [{id:q1,text,options:[{id:o1,text,points}]}]
    status          questionnaire_status NOT NULL DEFAULT 'ACTIVE',
    effective_from  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_q_count CHECK (jsonb_typeof(questions) = 'array' AND jsonb_array_length(questions) = 10)
);
-- Chỉ 1 phiên bản ACTIVE
CREATE UNIQUE INDEX ux_questionnaire_active ON risk_questionnaire_versions ((status))
    WHERE status = 'ACTIVE';

-- Bản xem trước kết quả khảo sát (TTL 24 giờ, bất biến)
CREATE TABLE risk_assessment_drafts (
    draft_id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id                     UUID NOT NULL REFERENCES customers(customer_id),
    questionnaire_version           VARCHAR(30) NOT NULL REFERENCES risk_questionnaire_versions(version),
    answers                         JSONB    NOT NULL,   -- [{questionId, optionId}] x 10
    score                           SMALLINT NOT NULL CHECK (score BETWEEN 10 AND 50),
    category                        risk_category NOT NULL REFERENCES risk_categories(category),
    max_product_risk                SMALLINT NOT NULL CHECK (max_product_risk BETWEEN 1 AND 5),
    allocation                      JSONB    NOT NULL,   -- {cash, deposit, bond, fund}
    expected_current_profile_version INT     NOT NULL DEFAULT 0 CHECK (expected_current_profile_version >= 0),
    payload_hash                    CHAR(64) NOT NULL,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at                      TIMESTAMPTZ NOT NULL,
    CONSTRAINT chk_draft_answers CHECK (jsonb_typeof(answers) = 'array' AND jsonb_array_length(answers) = 10),
    CONSTRAINT chk_draft_ttl CHECK (expires_at = created_at + INTERVAL '24 hours')
);
CREATE INDEX ix_draft_customer ON risk_assessment_drafts (customer_id, created_at DESC);

-- Hồ sơ khẩu vị rủi ro đã ký OTP (append-only, có phiên bản). Hiệu lực tính lúc đọc (BR-06).
CREATE TABLE risk_profiles (
    risk_profile_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id           UUID NOT NULL REFERENCES customers(customer_id),
    version               INT  NOT NULL CHECK (version > 0),
    draft_id              UUID NOT NULL UNIQUE REFERENCES risk_assessment_drafts(draft_id),
    questionnaire_version VARCHAR(30) NOT NULL REFERENCES risk_questionnaire_versions(version),
    answers               JSONB    NOT NULL,
    score                 SMALLINT NOT NULL CHECK (score BETWEEN 10 AND 50),
    category              risk_category NOT NULL REFERENCES risk_categories(category),
    max_product_risk      SMALLINT NOT NULL CHECK (max_product_risk BETWEEN 1 AND 5),
    allocation            JSONB    NOT NULL,
    payload_hash          CHAR(64) NOT NULL,
    otp_receipt_ref       UUID     NOT NULL UNIQUE,
    confirmed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at            TIMESTAMPTZ NOT NULL,           -- confirmed_at + 12 tháng lịch (UTC)
    UNIQUE (customer_id, version),
    -- expires_at = confirmed_at + 12 tháng lịch (UTC; 29/02 và ngày cuối tháng -> ngày cuối tháng đích),
    -- tính ở tầng dịch vụ; CSDL chỉ chặn sai lệch thô.
    CONSTRAINT chk_rp_expiry CHECK (expires_at BETWEEN confirmed_at + INTERVAL '12 months' - INTERVAL '3 days'
                                                   AND confirmed_at + INTERVAL '12 months' + INTERVAL '3 days')
);

-- Dịch vụ quản lý tài sản (mỗi CIF tối đa 1 dịch vụ - BR-P1-01)
CREATE TABLE wealth_services (
    service_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id              UUID NOT NULL UNIQUE REFERENCES customers(customer_id),
    consent_id               UUID NOT NULL UNIQUE REFERENCES service_consents(consent_id),
    status                   wealth_service_status NOT NULL DEFAULT 'PENDING_RISK_ASSESSMENT',
    linked_payment_account_no VARCHAR(30) NOT NULL,      -- CASA chính chủ (BR-09)
    current_risk_profile_id  UUID REFERENCES risk_profiles(risk_profile_id),
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    activated_at             TIMESTAMPTZ,
    CONSTRAINT chk_ws_active CHECK (status = 'PENDING_RISK_ASSESSMENT' OR current_risk_profile_id IS NOT NULL)
);

-- Lịch sử phân công RM (UC-01 tạm, UC-03 chính thức). Đúng 1 bản ghi hiện hành / khách (BR-08).
CREATE TABLE rm_assignments (
    assignment_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id     UUID NOT NULL REFERENCES customers(customer_id),
    rm_id           UUID NOT NULL REFERENCES staff_users(staff_id),
    team_id         UUID NOT NULL REFERENCES teams(team_id),
    version         INT  NOT NULL CHECK (version > 0),
    provisional     BOOLEAN NOT NULL DEFAULT FALSE,
    valid_from      TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_to        TIMESTAMPTZ,                          -- NULL = hiện hành
    assigned_by     UUID REFERENCES staff_users(staff_id),
    reason          VARCHAR(500),
    UNIQUE (customer_id, version),
    CONSTRAINT chk_rma_period CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE UNIQUE INDEX ux_rm_assignment_current ON rm_assignments (customer_id) WHERE valid_to IS NULL;
CREATE INDEX ix_rm_assignment_rm_current ON rm_assignments (rm_id) WHERE valid_to IS NULL;

-- Thông báo nhắc khảo sát rủi ro (BR-P1-06: tối đa 1 lần / khách / 24 giờ - kiểm tra ở tầng dịch vụ)
CREATE TABLE customer_notifications (
    notification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id     UUID NOT NULL REFERENCES customers(customer_id),
    kind            notification_kind NOT NULL DEFAULT 'RISK_SURVEY_REMINDER',
    message         TEXT NOT NULL,
    created_by      UUID NOT NULL REFERENCES staff_users(staff_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at         TIMESTAMPTZ
);
CREATE INDEX ix_notification_customer ON customer_notifications (customer_id, kind, created_at DESC);

-- =============================================================================
-- 3. PHÂN HỆ 3 - SẢN PHẨM & ĐỊNH GIÁ DANH MỤC
-- =============================================================================

-- Sản phẩm cha (Master Catalog) - BR-14
CREATE TABLE assets (
    asset_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_code      VARCHAR(30)  NOT NULL UNIQUE,         -- 409 PRODUCT_CODE_EXISTS
    asset_name      VARCHAR(200) NOT NULL,
    asset_class     asset_class  NOT NULL,
    risk_level      SMALLINT     NOT NULL CHECK (risk_level BETWEEN 1 AND 5),   -- BR-14
    min_investment  money_vnd    NOT NULL DEFAULT 0 CHECK (min_investment >= 0),
    status          asset_status NOT NULL DEFAULT 'ON_SALE',
    created_by      UUID REFERENCES staff_users(staff_id),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (asset_id, asset_class)                        -- cho FK kiểm tra lớp con
);

-- Lớp con (Class Table Inheritance, dùng chung asset_id)
CREATE TABLE term_deposit_products (
    asset_id      UUID PRIMARY KEY,
    asset_class   asset_class NOT NULL DEFAULT 'TERM_DEPOSIT' CHECK (asset_class = 'TERM_DEPOSIT'),
    term_months   SMALLINT     NOT NULL CHECK (term_months > 0),
    interest_rate NUMERIC(7,4) NOT NULL CHECK (interest_rate > 0),   -- % / năm
    FOREIGN KEY (asset_id, asset_class) REFERENCES assets(asset_id, asset_class) ON DELETE CASCADE
);

CREATE TABLE bond_products (
    asset_id      UUID PRIMARY KEY,
    asset_class   asset_class NOT NULL DEFAULT 'BOND' CHECK (asset_class = 'BOND'),
    face_value    money_vnd    NOT NULL CHECK (face_value > 0),
    coupon_rate   NUMERIC(7,4) NOT NULL CHECK (coupon_rate >= 0),
    issue_date    DATE,
    maturity_date DATE         NOT NULL,                 -- không ở quá khứ (trigger)
    issuer        VARCHAR(200) NOT NULL,
    FOREIGN KEY (asset_id, asset_class) REFERENCES assets(asset_id, asset_class) ON DELETE CASCADE
);

CREATE TABLE mutual_fund_products (
    asset_id      UUID PRIMARY KEY,
    asset_class   asset_class NOT NULL DEFAULT 'MUTUAL_FUND' CHECK (asset_class = 'MUTUAL_FUND'),
    fund_type     VARCHAR(30)  NOT NULL,                 -- MONEY_MARKET, BOND, BALANCED, EQUITY
    fund_manager  VARCHAR(200) NOT NULL,
    FOREIGN KEY (asset_id, asset_class) REFERENCES assets(asset_id, asset_class) ON DELETE CASCADE
);

-- Lịch sử giá / NAV / lãi suất (chỉ INSERT) - UC-10, BR-15
CREATE TABLE asset_pricing (
    pricing_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id        UUID NOT NULL REFERENCES assets(asset_id),
    price_type      price_type NOT NULL,
    value           price_val  NOT NULL CHECK (value > 0),
    previous_value  price_val  CHECK (previous_value > 0),
    change_pct      NUMERIC(9,4),                         -- |new-old|/old * 100
    effective_date  DATE       NOT NULL,                  -- không ở tương lai (trigger)
    status          pricing_status NOT NULL,
    created_by      UUID NOT NULL REFERENCES staff_users(staff_id),   -- Maker
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_pricing_volatility CHECK (
        change_pct IS NULL OR change_pct <= 20 OR status <> 'APPLIED' )   -- >20% phải qua duyệt
);
CREATE INDEX ix_pricing_latest ON asset_pricing (asset_id, price_type, effective_date DESC, created_at DESC);

-- Duyệt 2 lớp Maker-Checker cho giá biến động > 20%
CREATE TABLE price_approvals (
    approval_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pricing_id    UUID NOT NULL UNIQUE REFERENCES asset_pricing(pricing_id),
    maker_id      UUID NOT NULL REFERENCES staff_users(staff_id),
    checker_id    UUID NOT NULL REFERENCES staff_users(staff_id),
    decision      approval_decision NOT NULL,
    reason        VARCHAR(500) NOT NULL,
    decided_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_maker_checker CHECK (maker_id <> checker_id)
);

-- =============================================================================
-- 4. PHÂN HỆ 2 - TÀI KHOẢN & DÒNG TIỀN (SUB-LEDGER)
-- =============================================================================

-- Tài khoản đầu tư VND (mỗi khách đúng 1 tài khoản; không hỗ trợ tài khoản chung)
CREATE TABLE investment_accounts (
    account_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_no      VARCHAR(30) NOT NULL UNIQUE,
    customer_id     UUID NOT NULL UNIQUE REFERENCES customers(customer_id),
    cif_id          VARCHAR(30) NOT NULL REFERENCES customers(cif_id),
    currency        CHAR(3)     NOT NULL DEFAULT 'VND' CHECK (currency = 'VND'),
    balance         money_vnd   NOT NULL DEFAULT 0,
    held_amount     money_vnd   NOT NULL DEFAULT 0,        -- BR-12: phong tỏa khi rút / đặt lệnh
    status          account_status NOT NULL DEFAULT 'ACTIVE',
    opened_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at       TIMESTAMPTZ,
    version         INT NOT NULL DEFAULT 0,                -- optimistic locking
    CONSTRAINT chk_balance_non_negative CHECK (balance >= 0),
    CONSTRAINT chk_held_range CHECK (held_amount >= 0 AND held_amount <= balance),
    CONSTRAINT chk_closed CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL))
);
COMMENT ON COLUMN investment_accounts.held_amount IS 'available_balance = balance - held_amount';

-- Tài khoản kế toán mà bút toán ghi vào
CREATE TABLE ledger_accounts (
    ledger_account_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code                  VARCHAR(40)  NOT NULL UNIQUE,
    name                  VARCHAR(200) NOT NULL,
    type                  ledger_account_type NOT NULL,
    investment_account_id UUID UNIQUE REFERENCES investment_accounts(account_id),
    CONSTRAINT chk_ledger_customer CHECK (
        (type = 'CUSTOMER_INVESTMENT') = (investment_account_id IS NOT NULL))
);

-- Nắm giữ tài sản của tài khoản (chỉ UC-16 / UC-08 cập nhật)
CREATE TABLE portfolio_holdings (
    holding_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id        UUID NOT NULL REFERENCES investment_accounts(account_id),
    asset_id          UUID NOT NULL REFERENCES assets(asset_id),
    quantity          NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (quantity >= 0),   -- CCQ / trái phiếu
    avg_cost          price_val     NOT NULL DEFAULT 0 CHECK (avg_cost >= 0),
    principal         money_vnd     NOT NULL DEFAULT 0 CHECK (principal >= 0),  -- gốc tiền gửi
    locked_rate       NUMERIC(7,4),                         -- lãi suất chốt khi mở tiền gửi
    accrued_interest  money_vnd     NOT NULL DEFAULT 0 CHECK (accrued_interest >= 0),
    start_date        DATE,
    maturity_date     DATE,
    status            holding_status NOT NULL DEFAULT 'OPEN',
    updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT chk_holding_dates CHECK (maturity_date IS NULL OR start_date IS NULL OR maturity_date > start_date)
);
-- CCQ / trái phiếu: 1 dòng nắm giữ đang mở cho mỗi (tài khoản, sản phẩm);
-- tiền gửi có thể có nhiều món cùng sản phẩm (phân biệt bằng start_date).
CREATE UNIQUE INDEX ux_holding_open ON portfolio_holdings (account_id, asset_id, COALESCE(start_date, DATE '1900-01-01'))
    WHERE status = 'OPEN';
CREATE INDEX ix_holding_maturity ON portfolio_holdings (maturity_date) WHERE status = 'OPEN' AND maturity_date IS NOT NULL;

-- Giao dịch tiền (lớp trừu tượng CashTransaction)
CREATE TABLE cash_transactions (
    txn_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ref_no          VARCHAR(40) NOT NULL UNIQUE,
    account_id      UUID NOT NULL REFERENCES investment_accounts(account_id),
    txn_type        cash_txn_type   NOT NULL,
    amount          money_vnd       NOT NULL CHECK (amount > 0),
    status          cash_txn_status NOT NULL DEFAULT 'INIT',
    failure_reason  VARCHAR(500),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ,
    UNIQUE (txn_id, txn_type),
    -- BR-11: nạp/rút tối thiểu 1.000.000 VND
    CONSTRAINT chk_min_cash CHECK (txn_type = 'MATURITY_SETTLEMENT' OR amount >= 1000000),
    CONSTRAINT chk_completed CHECK ((status IN ('SUCCESS','FAILED')) = (completed_at IS NOT NULL))
);
CREATE INDEX ix_cash_txn_account ON cash_transactions (account_id, created_at DESC);
CREATE INDEX ix_cash_txn_pending ON cash_transactions (status, created_at) WHERE status = 'PENDING';

-- Nạp tiền từ CASA (UC-05)
CREATE TABLE deposit_transactions (
    txn_id           UUID PRIMARY KEY,
    txn_type         cash_txn_type NOT NULL DEFAULT 'DEPOSIT' CHECK (txn_type = 'DEPOSIT'),
    source_casa_no   VARCHAR(30)  NOT NULL,              -- BR-09: CASA cùng CIF
    idempotency_key  VARCHAR(100) NOT NULL,
    core_ref         VARCHAR(60) UNIQUE,
    retry_count      SMALLINT NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    otp_challenge_id UUID UNIQUE REFERENCES otp_challenges(challenge_id),
    FOREIGN KEY (txn_id, txn_type) REFERENCES cash_transactions(txn_id, txn_type) ON DELETE CASCADE
);

-- Rút tiền về CASA (UC-06)
CREATE TABLE withdrawal_transactions (
    txn_id              UUID PRIMARY KEY,
    txn_type            cash_txn_type NOT NULL DEFAULT 'WITHDRAWAL' CHECK (txn_type = 'WITHDRAWAL'),
    dest_casa_no        VARCHAR(30)  NOT NULL,           -- BR-09: CASA chính chủ đã liên kết
    idempotency_key     VARCHAR(100) NOT NULL,
    core_ref            VARCHAR(60) UNIQUE,
    retry_count         SMALLINT NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    needs_manual_review BOOLEAN  NOT NULL DEFAULT FALSE,
    otp_challenge_id    UUID UNIQUE REFERENCES otp_challenges(challenge_id),
    FOREIGN KEY (txn_id, txn_type) REFERENCES cash_transactions(txn_id, txn_type) ON DELETE CASCADE
);

-- Tất toán tiền gửi đến hạn (UC-08, BR-13) - mỗi món tiền gửi tất toán tối đa 1 lần
CREATE TABLE maturity_settlements (
    txn_id           UUID PRIMARY KEY,
    txn_type         cash_txn_type NOT NULL DEFAULT 'MATURITY_SETTLEMENT' CHECK (txn_type = 'MATURITY_SETTLEMENT'),
    holding_id       UUID NOT NULL UNIQUE REFERENCES portfolio_holdings(holding_id),   -- BR-P2-06
    settlement_key   VARCHAR(100) NOT NULL UNIQUE,
    principal_amount money_vnd NOT NULL CHECK (principal_amount > 0),
    interest_amount  money_vnd NOT NULL CHECK (interest_amount >= 0),
    days_held        INT       NOT NULL CHECK (days_held > 0),
    core_ref         VARCHAR(60),
    FOREIGN KEY (txn_id, txn_type) REFERENCES cash_transactions(txn_id, txn_type) ON DELETE CASCADE
);

-- Idempotency-Key duy nhất trên mỗi tài khoản cho nạp/rút
CREATE UNIQUE INDEX ux_deposit_idem    ON deposit_transactions (idempotency_key);
CREATE UNIQUE INDEX ux_withdrawal_idem ON withdrawal_transactions (idempotency_key);

-- =============================================================================
-- 5. PHÂN HỆ 4 - TƯ VẤN DANH MỤC & KHỚP LỆNH
-- =============================================================================

-- Đề xuất tư vấn (đóng băng sau khi rơi vào trạng thái kết thúc - BR-25)
CREATE TABLE proposals (
    proposal_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    proposal_code        VARCHAR(30) NOT NULL UNIQUE,          -- PROP-20261026-001
    customer_id          UUID NOT NULL REFERENCES customers(customer_id),
    rm_id                UUID NOT NULL REFERENCES staff_users(staff_id),
    account_id           UUID NOT NULL REFERENCES investment_accounts(account_id),
    risk_profile_id      UUID NOT NULL REFERENCES risk_profiles(risk_profile_id),   -- hồ sơ dùng để đối soát BR-18
    drift_alert_id       UUID,                                  -- nếu tạo từ cảnh báo lệch (FK thêm bên dưới)
    status               proposal_status NOT NULL DEFAULT 'PENDING_APPROVAL',
    total_estimated_buy  money_vnd NOT NULL DEFAULT 0 CHECK (total_estimated_buy  >= 0),
    total_estimated_sell money_vnd NOT NULL DEFAULT 0 CHECK (total_estimated_sell >= 0),
    cash_at_creation     money_vnd NOT NULL CHECK (cash_at_creation >= 0),
    note                 TEXT,
    otp_auth_ref         UUID UNIQUE,                           -- BR-03
    rejection_reason     VARCHAR(500),
    cancel_reason        VARCHAR(500),
    failure_reason       VARCHAR(500),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    expired_at           TIMESTAMPTZ NOT NULL,                  -- created_at + 24h (BR-21)
    approved_at          TIMESTAMPTZ,
    executed_at          TIMESTAMPTZ,
    closed_at            TIMESTAMPTZ,
    CONSTRAINT chk_prop_ttl    CHECK (expired_at = created_at + INTERVAL '24 hours'),
    -- BR-20: tổng MUA <= tiền mặt khả dụng + tổng BÁN ước tính
    CONSTRAINT chk_prop_budget CHECK (total_estimated_buy <= cash_at_creation + total_estimated_sell),
    CONSTRAINT chk_prop_approved CHECK (status NOT IN ('APPROVED','EXECUTING','EXECUTED')
                                        OR (otp_auth_ref IS NOT NULL AND approved_at IS NOT NULL)),
    CONSTRAINT chk_prop_executed CHECK ((status = 'EXECUTED') = (executed_at IS NOT NULL))
);
-- BR-24: mỗi khách chỉ 1 đề xuất PENDING_APPROVAL
CREATE UNIQUE INDEX ux_proposal_single_pending ON proposals (customer_id) WHERE status = 'PENDING_APPROVAL';
CREATE INDEX ix_proposal_rm ON proposals (rm_id, created_at DESC);
CREATE INDEX ix_proposal_expiry ON proposals (expired_at) WHERE status = 'PENDING_APPROVAL';

-- Chân lệnh trong giỏ đề xuất (composition 1..*)
CREATE TABLE proposal_legs (
    leg_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    proposal_id           UUID NOT NULL REFERENCES proposals(proposal_id) ON DELETE CASCADE,
    leg_no                SMALLINT NOT NULL CHECK (leg_no > 0),
    asset_id              UUID NOT NULL REFERENCES assets(asset_id),
    source_holding_id     UUID REFERENCES portfolio_holdings(holding_id),   -- cho SELL / SETTLE
    action_type           leg_action_type NOT NULL,
    order_quantity        NUMERIC(20,6) NOT NULL CHECK (order_quantity > 0),
    expected_price        price_val NOT NULL CHECK (expected_price > 0),
    estimated_amount      money_vnd NOT NULL,
    actual_executed_price price_val CHECK (actual_executed_price > 0),
    slippage_rate         NUMERIC(9,4),                       -- |NAV_tt - NAV_dk| / NAV_dk * 100 (BR-22)
    UNIQUE (proposal_id, leg_no),
    CONSTRAINT chk_leg_amount CHECK (estimated_amount = ROUND(order_quantity * expected_price, 2)),
    CONSTRAINT chk_leg_source CHECK (action_type IN ('BUY','OPEN') OR source_holding_id IS NOT NULL)
);
CREATE INDEX ix_leg_asset ON proposal_legs (asset_id);

-- Phiên khớp lệnh nguyên tử All-or-Nothing (BR-23) - tối đa 1 phiên / đề xuất
CREATE TABLE execution_sessions (
    session_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_code       VARCHAR(40) NOT NULL UNIQUE,            -- SESS-20261026-XXXX
    proposal_id        UUID NOT NULL UNIQUE REFERENCES proposals(proposal_id),
    status             session_status NOT NULL DEFAULT 'IN_PROGRESS',
    is_atomic_success  BOOLEAN NOT NULL DEFAULT FALSE,
    started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at       TIMESTAMPTZ,
    CONSTRAINT chk_session_success CHECK (is_atomic_success = (status = 'COMMITTED')),
    CONSTRAINT chk_session_done CHECK ((status = 'IN_PROGRESS') = (completed_at IS NULL))
);

-- Giao dịch tài chính thực tế (chứng từ, độc lập với văn kiện tư vấn)
CREATE TABLE investment_transactions (
    transaction_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_no   VARCHAR(40) NOT NULL UNIQUE,
    session_id       UUID NOT NULL REFERENCES execution_sessions(session_id),
    proposal_leg_id  UUID NOT NULL UNIQUE REFERENCES proposal_legs(leg_id),
    account_id       UUID NOT NULL REFERENCES investment_accounts(account_id),
    asset_id         UUID NOT NULL REFERENCES assets(asset_id),
    holding_id       UUID REFERENCES portfolio_holdings(holding_id),
    action_type      leg_action_type NOT NULL,
    quantity         NUMERIC(20,6) NOT NULL CHECK (quantity > 0),
    executed_price   price_val NOT NULL CHECK (executed_price > 0),
    pricing_id       UUID REFERENCES asset_pricing(pricing_id),     -- giá/NAV dùng để khớp
    executed_amount  money_vnd NOT NULL CHECK (executed_amount > 0),
    status           invest_txn_status NOT NULL DEFAULT 'INIT',
    error_code       VARCHAR(60),
    executed_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_itx_executed CHECK ((status = 'EXECUTED') = (executed_at IS NOT NULL)),
    CONSTRAINT chk_itx_error    CHECK (status <> 'FAILED' OR error_code IS NOT NULL)
);
CREATE INDEX ix_itx_account ON investment_transactions (account_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- Sổ cái kép bất biến (BR-19) - dùng chung cho Phân hệ 2 và Phân hệ 4
-- -----------------------------------------------------------------------------
CREATE TABLE ledger_entries (
    entry_id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    journal_id                UUID NOT NULL,                 -- nhóm bút toán cân bằng Nợ = Có
    cash_txn_id               UUID REFERENCES cash_transactions(txn_id),
    investment_transaction_id UUID REFERENCES investment_transactions(transaction_id),
    ledger_account_id         UUID NOT NULL REFERENCES ledger_accounts(ledger_account_id),
    side                      entry_side NOT NULL,
    amount                    money_vnd  NOT NULL CHECK (amount > 0),
    balance_after             money_vnd,                     -- số dư TK đầu tư sau bút toán (nếu có)
    reversal_of               BIGINT UNIQUE REFERENCES ledger_entries(entry_id),   -- bút toán đảo
    description               VARCHAR(500),
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_entry_source CHECK (num_nonnulls(cash_txn_id, investment_transaction_id) = 1)
);
CREATE INDEX ix_ledger_journal  ON ledger_entries (journal_id);
CREATE INDEX ix_ledger_cash     ON ledger_entries (cash_txn_id)               WHERE cash_txn_id IS NOT NULL;
CREATE INDEX ix_ledger_invest   ON ledger_entries (investment_transaction_id) WHERE investment_transaction_id IS NOT NULL;
CREATE INDEX ix_ledger_account  ON ledger_entries (ledger_account_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- Định giá MtM & cảnh báo lệch tỷ trọng (Phân hệ 3, đặt sau vì cần customers/RM)
-- -----------------------------------------------------------------------------
-- Ảnh chụp danh mục lúc 17:00 (chỉ INSERT) - BR-17
CREATE TABLE portfolio_snapshots (
    snapshot_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id     UUID NOT NULL REFERENCES customers(customer_id),
    account_id      UUID NOT NULL REFERENCES investment_accounts(account_id),
    snapshot_date   DATE NOT NULL,
    cash_balance    money_vnd NOT NULL DEFAULT 0,
    deposit_value   money_vnd NOT NULL DEFAULT 0,          -- gốc + lãi dự thu
    bond_value      money_vnd NOT NULL DEFAULT 0,
    fund_value      money_vnd NOT NULL DEFAULT 0,
    aum             money_vnd NOT NULL,
    unrealized_pnl  money_vnd NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (customer_id, snapshot_date),
    CONSTRAINT chk_aum CHECK (aum = cash_balance + deposit_value + bond_value + fund_value)
);

-- Cảnh báo lệch tỷ trọng (BR-16)
CREATE TABLE drift_alerts (
    alert_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    snapshot_id      UUID NOT NULL REFERENCES portfolio_snapshots(snapshot_id),
    customer_id      UUID NOT NULL REFERENCES customers(customer_id),
    rm_id            UUID NOT NULL REFERENCES staff_users(staff_id),
    risk_profile_id  UUID NOT NULL REFERENCES risk_profiles(risk_profile_id),   -- nguồn target_weight
    allocation_class allocation_class NOT NULL,
    actual_weight    NUMERIC(6,2) NOT NULL CHECK (actual_weight BETWEEN 0 AND 100),
    target_weight    NUMERIC(6,2) NOT NULL CHECK (target_weight BETWEEN 0 AND 100),
    deviation        NUMERIC(6,2) GENERATED ALWAYS AS (ABS(actual_weight - target_weight)) STORED,
    status           drift_alert_status NOT NULL DEFAULT 'NEW',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at          TIMESTAMPTZ,
    actioned_at      TIMESTAMPTZ,
    UNIQUE (snapshot_id, allocation_class),
    CONSTRAINT chk_drift_threshold CHECK (ABS(actual_weight - target_weight) >= 5)
);
CREATE INDEX ix_drift_rm_status ON drift_alerts (rm_id, status, created_at DESC);

ALTER TABLE proposals
    ADD CONSTRAINT fk_proposal_drift_alert FOREIGN KEY (drift_alert_id) REFERENCES drift_alerts(alert_id);

-- Gợi ý tái cân bằng (chỉ để RM tham khảo)
CREATE TABLE rebalance_suggestions (
    suggestion_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id         UUID NOT NULL REFERENCES drift_alerts(alert_id) ON DELETE CASCADE,
    allocation_class allocation_class NOT NULL,
    direction        adjust_direction NOT NULL,
    adjust_amount    money_vnd NOT NULL CHECK (adjust_amount > 0),
    UNIQUE (alert_id, allocation_class)
);

-- =============================================================================
-- 6. TRIGGER THỰC THI QUY TẮC NGHIỆP VỤ
-- =============================================================================

-- 6.1 Bảng append-only: cấm UPDATE / DELETE (BR-01, BR-19, bản ghi bất biến)
CREATE OR REPLACE FUNCTION fn_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Bảng % là append-only: không được % (BR-01/BR-19)', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'insufficient_privilege';
END $$;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['audit_logs','ledger_entries','risk_profiles','risk_assessment_drafts',
                             'service_consents','service_terms','asset_pricing','price_approvals',
                             'portfolio_snapshots']
    LOOP
        EXECUTE format('CREATE TRIGGER trg_%s_append_only BEFORE UPDATE OR DELETE ON %I
                        FOR EACH ROW EXECUTE FUNCTION fn_forbid_mutation()', t, t);
    END LOOP;
END $$;

-- Bộ câu hỏi đã dùng không được sửa nội dung (chỉ được chuyển sang RETIRED)
CREATE OR REPLACE FUNCTION fn_questionnaire_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' OR NEW.questions IS DISTINCT FROM OLD.questions
       OR NEW.version IS DISTINCT FROM OLD.version THEN
        RAISE EXCEPTION 'Phiên bản bộ câu hỏi % không được sửa / xóa (BR-P1-03)', OLD.version;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_questionnaire_guard BEFORE UPDATE OR DELETE ON risk_questionnaire_versions
    FOR EACH ROW EXECUTE FUNCTION fn_questionnaire_guard();

-- 6.2 Sổ cái kép: tổng Nợ = tổng Có trên mỗi journal, kiểm tra lúc COMMIT (BR-19)
CREATE OR REPLACE FUNCTION fn_check_journal_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_debit NUMERIC; v_credit NUMERIC; v_cnt INT;
BEGIN
    SELECT COALESCE(SUM(amount) FILTER (WHERE side = 'DEBIT'), 0),
           COALESCE(SUM(amount) FILTER (WHERE side = 'CREDIT'), 0),
           COUNT(*)
      INTO v_debit, v_credit, v_cnt
      FROM ledger_entries WHERE journal_id = NEW.journal_id;
    IF v_cnt < 2 OR v_debit <> v_credit THEN
        RAISE EXCEPTION 'Journal % không cân bằng: Nợ=% Có=% (BR-19)', NEW.journal_id, v_debit, v_credit;
    END IF;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_ledger_balanced
    AFTER INSERT ON ledger_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION fn_check_journal_balanced();

-- 6.3 Tính bất biến của trạng thái kết thúc + máy trạng thái đề xuất (BR-25)
CREATE OR REPLACE FUNCTION fn_proposal_state_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status IN ('EXECUTED','REJECTED','CANCELLED','EXPIRED','FAILED') THEN
        RAISE EXCEPTION 'Đề xuất % đã ở trạng thái kết thúc %, không được thay đổi (BR-25)',
            OLD.proposal_code, OLD.status;
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
           (OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('APPROVED','REJECTED','CANCELLED','EXPIRED','FAILED'))
        OR (OLD.status = 'APPROVED'         AND NEW.status IN ('EXECUTING','FAILED'))
        OR (OLD.status = 'EXECUTING'        AND NEW.status IN ('EXECUTED','FAILED'))
    ) THEN
        RAISE EXCEPTION 'Chuyển trạng thái không hợp lệ: % -> %', OLD.status, NEW.status;
    END IF;
    -- Nội dung văn kiện tư vấn không được sửa sau khi gửi
    IF (NEW.customer_id, NEW.rm_id, NEW.account_id, NEW.total_estimated_buy, NEW.total_estimated_sell, NEW.created_at)
       IS DISTINCT FROM
       (OLD.customer_id, OLD.rm_id, OLD.account_id, OLD.total_estimated_buy, OLD.total_estimated_sell, OLD.created_at) THEN
        RAISE EXCEPTION 'Không được sửa nội dung đề xuất đã gửi';
    END IF;
    IF NEW.status IN ('EXECUTED','REJECTED','CANCELLED','EXPIRED','FAILED') THEN
        NEW.closed_at := COALESCE(NEW.closed_at, now());
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_proposal_state_guard BEFORE UPDATE ON proposals
    FOR EACH ROW EXECUTE FUNCTION fn_proposal_state_guard();
CREATE TRIGGER trg_proposal_no_delete BEFORE DELETE ON proposals
    FOR EACH ROW EXECUTE FUNCTION fn_forbid_mutation();

-- Chân lệnh chỉ được sửa (giá khớp, trượt giá) khi đề xuất chưa kết thúc
CREATE OR REPLACE FUNCTION fn_leg_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_status proposal_status;
BEGIN
    SELECT status INTO v_status FROM proposals WHERE proposal_id = OLD.proposal_id;
    IF v_status IN ('EXECUTED','REJECTED','CANCELLED','EXPIRED','FAILED') THEN
        RAISE EXCEPTION 'Đề xuất đã đóng băng, không được sửa chân lệnh (BR-25)';
    END IF;
    IF (NEW.asset_id, NEW.action_type, NEW.order_quantity, NEW.expected_price)
       IS DISTINCT FROM (OLD.asset_id, OLD.action_type, OLD.order_quantity, OLD.expected_price) THEN
        RAISE EXCEPTION 'Không được sửa nội dung chân lệnh đã gửi';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_leg_guard BEFORE UPDATE ON proposal_legs
    FOR EACH ROW EXECUTE FUNCTION fn_leg_guard();

-- 6.4 Suitability: sản phẩm trong giỏ không vượt mức rủi ro tối đa, phải đang bán (BR-18)
CREATE OR REPLACE FUNCTION fn_leg_suitability() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_max SMALLINT; v_risk SMALLINT; v_status asset_status;
BEGIN
    SELECT rp.max_product_risk INTO v_max
      FROM proposals p JOIN risk_profiles rp ON rp.risk_profile_id = p.risk_profile_id
     WHERE p.proposal_id = NEW.proposal_id;
    SELECT risk_level, status INTO v_risk, v_status FROM assets WHERE asset_id = NEW.asset_id;
    IF NEW.action_type IN ('BUY','OPEN') THEN
        IF v_risk > v_max THEN
            RAISE EXCEPTION 'SUITABILITY_VIOLATION: sản phẩm rủi ro mức % vượt mức tối đa % (BR-18)', v_risk, v_max;
        END IF;
        IF v_status <> 'ON_SALE' THEN
            RAISE EXCEPTION 'Sản phẩm đã ngừng bán, không được đưa vào lệnh mua';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_leg_suitability BEFORE INSERT ON proposal_legs
    FOR EACH ROW EXECUTE FUNCTION fn_leg_suitability();

-- 6.5 Giá: ngày hiệu lực không ở tương lai; trái phiếu không đáo hạn trong quá khứ
CREATE OR REPLACE FUNCTION fn_pricing_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.effective_date > CURRENT_DATE THEN
        RAISE EXCEPTION 'Ngày hiệu lực giá không được ở tương lai';
    END IF;
    IF NEW.previous_value IS NOT NULL AND NEW.change_pct IS NULL THEN
        NEW.change_pct := ROUND(ABS(NEW.value - NEW.previous_value) / NEW.previous_value * 100, 4);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_pricing_validate BEFORE INSERT ON asset_pricing
    FOR EACH ROW EXECUTE FUNCTION fn_pricing_validate();

CREATE OR REPLACE FUNCTION fn_bond_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.maturity_date < CURRENT_DATE THEN
        RAISE EXCEPTION 'Ngày đáo hạn trái phiếu không được ở quá khứ';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_bond_validate BEFORE INSERT ON bond_products
    FOR EACH ROW EXECUTE FUNCTION fn_bond_validate();

-- Trạng thái giá: chỉ được chuyển từ PENDING_APPROVAL qua bảng price_approvals.
-- (asset_pricing là append-only: kết quả duyệt được ghi bằng bản ghi price_approvals,
--  giá hiệu lực = bản ghi APPLIED hoặc PENDING_APPROVAL đã có approval APPROVED - xem view v_asset_latest_price)

-- 6.6 Đồng bộ updated_at cho assets
CREATE OR REPLACE FUNCTION fn_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
CREATE TRIGGER trg_assets_touch   BEFORE UPDATE ON assets             FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();
CREATE TRIGGER trg_holdings_touch BEFORE UPDATE ON portfolio_holdings FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();

-- =============================================================================
-- 7. VIEW / HÀM HỖ TRỢ
-- =============================================================================

-- BR-06: hiệu lực hồ sơ rủi ro tính lúc đọc (UC-03 và UC-13 dùng chung)
CREATE OR REPLACE FUNCTION fn_risk_profile_valid(p_risk_profile_id UUID, p_at TIMESTAMPTZ DEFAULT now())
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT p_at < expires_at FROM risk_profiles WHERE risk_profile_id = p_risk_profile_id
$$;

CREATE OR REPLACE VIEW v_customer_current_risk AS
SELECT c.customer_id, c.cif_id, c.full_name,
       ws.status          AS service_status,
       rp.risk_profile_id, rp.version, rp.score, rp.category, rp.max_product_risk,
       rp.allocation, rp.confirmed_at, rp.expires_at,
       CASE WHEN rp.risk_profile_id IS NULL THEN 'NONE'
            WHEN rp.expires_at <= now()     THEN 'EXPIRED'
            ELSE 'VALID' END AS profile_validity
  FROM customers c
  LEFT JOIN wealth_services ws ON ws.customer_id = c.customer_id
  LEFT JOIN risk_profiles  rp ON rp.risk_profile_id = ws.current_risk_profile_id;

-- BR-07: tải của RM = khách hiện hành + chỗ giữ còn hạn (chặn khi >= 80)
CREATE OR REPLACE VIEW v_rm_load AS
SELECT s.staff_id AS rm_id, s.full_name, s.team_id, s.max_customers,
       COALESCE(a.cnt, 0)                     AS current_customers,
       COALESCE(r.cnt, 0)                     AS active_reservations,
       COALESCE(a.cnt, 0) + COALESCE(r.cnt, 0) AS load,
       COALESCE(a.cnt, 0) + COALESCE(r.cnt, 0) >= s.max_customers AS is_full
  FROM staff_users s
  LEFT JOIN (SELECT rm_id, COUNT(*) cnt FROM rm_assignments WHERE valid_to IS NULL GROUP BY rm_id) a
         ON a.rm_id = s.staff_id
  LEFT JOIN (SELECT rm_id, COUNT(*) cnt FROM rm_capacity_reservations
              WHERE status = 'ACTIVE' AND expires_at > now() GROUP BY rm_id) r
         ON r.rm_id = s.staff_id
 WHERE s.role = 'RM';
-- Khi tạo lời mời / nhận chuyển giao: SELECT ... FROM staff_users WHERE staff_id = :rm FOR UPDATE;
-- rồi kiểm tra v_rm_load.load < 80 trong cùng transaction để tránh vượt hạn mức đồng thời.

-- Số dư khả dụng của tài khoản đầu tư
CREATE OR REPLACE VIEW v_account_balance AS
SELECT account_id, account_no, customer_id, balance, held_amount,
       balance - held_amount AS available_balance, status
  FROM investment_accounts;

-- Giá hiệu lực mới nhất của mỗi sản phẩm (bỏ qua giá đang chờ duyệt hoặc bị từ chối - BR-15)
CREATE OR REPLACE VIEW v_asset_latest_price AS
SELECT DISTINCT ON (p.asset_id, p.price_type)
       p.asset_id, p.price_type, p.value, p.effective_date, p.pricing_id
  FROM asset_pricing p
  LEFT JOIN price_approvals a ON a.pricing_id = p.pricing_id
 WHERE p.status = 'APPLIED'
    OR (p.status = 'PENDING_APPROVAL' AND a.decision = 'APPROVED')
 ORDER BY p.asset_id, p.price_type, p.effective_date DESC, p.created_at DESC;

-- RM hiện hành của khách (dùng cho BR-08, DriftAlert.rm_id)
CREATE OR REPLACE VIEW v_customer_current_rm AS
SELECT ra.customer_id, ra.rm_id, ra.team_id, ra.provisional, ra.valid_from
  FROM rm_assignments ra WHERE ra.valid_to IS NULL;

-- =============================================================================
-- 8. DỮ LIỆU DANH MỤC CHUẨN
-- =============================================================================
INSERT INTO risk_categories (category, name_vi, min_score, max_score, max_product_risk) VALUES
    ('CONSERVATIVE', 'Thận trọng',  10, 20, 2),
    ('BALANCED',     'Cân bằng',    21, 35, 3),
    ('GROWTH',       'Tăng trưởng', 36, 50, 5);

INSERT INTO target_allocations (category, allocation_class, target_weight) VALUES
    ('CONSERVATIVE', 'CASH', 10), ('CONSERVATIVE', 'TERM_DEPOSIT', 50), ('CONSERVATIVE', 'BOND', 30), ('CONSERVATIVE', 'MUTUAL_FUND', 10),
    ('BALANCED',     'CASH',  5), ('BALANCED',     'TERM_DEPOSIT', 30), ('BALANCED',     'BOND', 30), ('BALANCED',     'MUTUAL_FUND', 35),
    ('GROWTH',       'CASH',  5), ('GROWTH',       'TERM_DEPOSIT', 15), ('GROWTH',       'BOND', 20), ('GROWTH',       'MUTUAL_FUND', 60);

-- Tài khoản kế toán hệ thống
INSERT INTO ledger_accounts (code, name, type) VALUES
    ('CORE_CLEARING',    'Tài khoản trung gian thanh toán Core Banking', 'CORE_CLEARING'),
    ('TERM_DEPOSIT',     'Tiền gửi có kỳ hạn của khách hàng',            'TERM_DEPOSIT'),
    ('INTEREST_PAYABLE', 'Lãi tiền gửi phải trả',                         'INTEREST_PAYABLE'),
    ('BOND_HOLDING',     'Trái phiếu nắm giữ hộ khách hàng',              'BOND_HOLDING'),
    ('FUND_HOLDING',     'Chứng chỉ quỹ nắm giữ hộ khách hàng',           'FUND_HOLDING');

-- =============================================================================
-- 9. (TÙY CHỌN) ROW-LEVEL SECURITY CHO BR-08
--    Ứng dụng đặt: SET app.current_staff_id = '<uuid>'; SET app.current_role = 'RM' | 'LEADER';
--    Bỏ comment để bật.
-- =============================================================================
/*
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_customers_scope ON customers USING (
    current_setting('app.current_role', true) NOT IN ('RM','LEADER')
    OR EXISTS (SELECT 1 FROM rm_assignments ra
                WHERE ra.customer_id = customers.customer_id AND ra.valid_to IS NULL
                  AND ( (current_setting('app.current_role') = 'RM'
                         AND ra.rm_id = current_setting('app.current_staff_id')::uuid)
                     OR (current_setting('app.current_role') = 'LEADER'
                         AND ra.team_id = (SELECT team_id FROM staff_users
                                            WHERE staff_id = current_setting('app.current_staff_id')::uuid)) ))
);
-- Áp dụng tương tự cho investment_accounts, cash_transactions, proposals, drift_alerts ...
*/

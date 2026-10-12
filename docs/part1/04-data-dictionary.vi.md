# Từ điển dữ liệu — Phần 1

Cơ sở dữ liệu: PostgreSQL. Schema được quản lý bằng migration; ứng dụng không dùng `synchronize`. Tài liệu này mô tả các bảng nền đã có trong source; các bảng risk và tích hợp RM sẽ được bổ sung khi triển khai tương ứng.

## Đăng ký dịch vụ

| Bảng | Khóa và dữ liệu chính | Ý nghĩa và ràng buộc |
|---|---|---|
| `mock_actors` | actor_id, subject_id, role, cif_id, rm_id, team_id, active | Danh tính demo tin cậy; quyền lấy từ bảng này, không lấy role/CIF do trình duyệt tự gửi |
| `service_terms` | version, content, content_hash | Phiên bản điều khoản demo bất biến; hash SHA-256 |
| `customers` | id UUID, cif_id UNIQUE, name, created_at | Khách đã hoàn tất consent; CIF là mã từ Core |
| `onboarding_requests` | id, cif_id, selected_account_id, rm_id, team_id, status, terms_version, terms_hash, created_at, expires_at | Yêu cầu có thời hạn 72 giờ; chỉ một yêu cầu đang chờ cho mỗi CIF |
| `rm_capacity_reservations` | id, onboarding_request_id UNIQUE, rm_id, status, expires_at | Giữ chỗ trong giới hạn 80 khách khi chờ consent; ACTIVE / CONSUMED / EXPIRED |
| `service_consents` | id, request_id UNIQUE, customer_id UNIQUE, terms_version, terms_hash, otp_receipt_ref UNIQUE | Bằng chứng khách xác nhận đúng điều khoản; không lưu mã OTP |
| `wealth_services` | id, customer_id UNIQUE, status, linked_payment_account_id, consent_id UNIQUE, current_risk_profile_id | Dịch vụ bắt đầu ở PENDING_RISK_ASSESSMENT; hồ sơ rủi ro hiện hành được tham chiếu bằng ID |
| `investment_accounts` | id, customer_id UNIQUE, currency, balance, created_at | Bridge Phần 2 tạo tài khoản VND số dư 0 cùng transaction consent; chưa phải toàn bộ ledger/nạp/rút |
| `rm_assignment_history` | id, customer_id, rm_id, team_id, valid_from, valid_to, provisional | Lịch sử phân công; partial unique index bảo đảm một RM hiện hành cho một khách |

## Bảo vệ thao tác và tích hợp

| Bảng | Dữ liệu chính | Ý nghĩa |
|---|---|---|
| `otp_challenges` | actor_id, purpose, operation_id, payload_hash, code_hash, salt, expires_at, consumed_at, receipt_ref | OTP một lần gắn chủ thể, mục đích và payload; chỉ lưu salted hash. Receipt khác mã xác nhận |
| `idempotency_records` | scope + key (PK), payload_hash, response, created_at | Scope gồm actor, mục đích, resource. Cùng key/payload trả lại kết quả; payload khác bị conflict |
| `audit_events` | id, action, outcome, actor_id, resource_id, payload, metadata, created_at | Nhật ký append-only cùng transaction thành công. Metadata gồm requestId, IP, User-Agent và before/after đã lọc; có audit cho tạo lời mời, tạo OTP và hoàn tất consent |
| `outbox_events` | id, event_type, aggregate_id, payload, created_at, published_at | Sự kiện được ghi cùng transaction; publish sau commit. Chưa tuyên bố có hệ thống delivery phân tán |

Khóa tư vấn PostgreSQL có phạm vi transaction: khóa RM theo thứ tự rồi khóa CIF. Các module phải dùng chung quy tắc để tránh vượt capacity và để phân công/duyệt đề xuất có thứ tự nhất quán. Không giữ transaction chờ gọi mạng Core hoặc gửi OTP.

## Dữ liệu công khai

Seed và ảnh demo phải là dữ liệu tổng hợp. Không đưa CIF thật, giấy tờ, tài khoản ngân hàng, CV, access token, OTP, `.env` hay log riêng vào repo public. Các adapter Core/IAM/OTP là mô phỏng phục vụ đồ án; tích hợp ngân hàng thật cần adapter và kiểm định riêng.


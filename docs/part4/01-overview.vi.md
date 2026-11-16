# Phần 4: Tư vấn và Giao dịch

Hiện thực UC-13 (tạo đề xuất), UC-14 (hủy đề xuất), UC-15 (khách duyệt hoặc từ chối bằng Smart OTP) và UC-16 (khớp lệnh trọn gói). Mã nguồn ở `apps/api/src/modules/advisory-trading/`, giao diện ở `apps/web/src/pages/Proposals.tsx` (RM) và `MyProposals.tsx` (khách). Phần này không thêm migration.

## Vòng đời đề xuất

| Trạng thái | Khi nào |
|---|---|
| `PENDING_APPROVAL` | RM vừa tạo; hết hạn đúng 24 giờ sau |
| `CANCELLED` | RM hủy, lý do 10 đến 255 ký tự |
| `REJECTED` | Khách từ chối, kèm lý do |
| `EXPIRED` | Quá 24 giờ: khi có người mở, thao tác, tạo đề xuất mới cho khách, hoặc job mỗi phút |
| `FAILED` | Trượt giá trên 5%, hoặc khớp lệnh lỗi (đã rollback) |
| `APPROVED` → `EXECUTING` → `EXECUTED` | Khách nhập đúng OTP; cả ba bước trong cùng một transaction với khớp lệnh |

Trạng thái kết thúc không đổi được nữa (BR-25), do trigger của nhóm giữ. Mỗi khách tối đa một đề xuất chờ duyệt (BR-24).

## Tạo đề xuất (UC-13)

- Khách phải do RM đang phụ trách, dịch vụ `ACTIVE`, hồ sơ rủi ro còn hiệu lực.
- Chân lệnh: `BUY` (sản phẩm, số lượng), `SELL` (khoản đang giữ, số lượng), `OPEN` (sản phẩm tiền gửi, số tiền gốc), `SETTLE` (khoản tiền gửi, cả khoản).
- Giá dự kiến do server lấy: giá mới nhất qua `v_asset_latest_price`; tiền gửi theo quy ước seed (số lượng = gốc, giá = 1).
- Sản phẩm mua phải đang bán, có giá, không vượt mức rủi ro tối đa (BR-18) và đạt mức đầu tư tối thiểu. Lỗi trả `details.legNo`.
- Ngân sách (BR-20): tổng mua và mở ≤ tiền mặt khả dụng + tổng bán và tất toán ước tính. Không phong tỏa tiền khi tạo.
- Tạo từ cảnh báo lệch: lưu `drift_alert_id`, cảnh báo chuyển `ACTIONED`. Khi đề xuất kết thúc ở bất kỳ trạng thái nào, cảnh báo chuyển `RESOLVED` để lần quét sau có thể cảnh báo lại.

## Duyệt (UC-15)

1. `approval-challenge`: so giá mới nhất với giá dự kiến của mọi chân quỹ và trái phiếu. Lệch trên 5% → đề xuất `FAILED` (`SLIPPAGE_EXCEEDED`), không gửi OTP. Đúng 5% vẫn cho qua.
2. Nếu không lệch, gửi OTP gắn với đề xuất và nội dung các chân lệnh.
3. Sai OTP: đề xuất vẫn chờ, tối đa 3 lần cho một mã (`OTP_ATTEMPTS_EXCEEDED`), mỗi lần sai ghi audit `FAILURE`.
4. Đúng OTP: kiểm tra trượt giá lần nữa (giá có thể đổi trong lúc khách nhập mã), rồi khớp lệnh.

## Khớp lệnh (UC-16)

Một transaction, khóa tài khoản rồi đề xuất. Bán và tất toán trước, sau đó kiểm tra tiền thực tế đủ cho phần mua (`INSUFFICIENT_FUNDS_FOR_EXECUTION`), rồi mua và mở mới. Lỗi bất kỳ → rollback toàn bộ, rồi một transaction ngắn ghi `FAILED`, phiên `ROLLED_BACK` và audit; API vẫn trả 200 với `status: FAILED`.

| Chân | Holdings | Sổ cái (Có tăng, Nợ giảm tài khoản đầu tư) |
|---|---|---|
| `SELL` | Giảm số lượng, về 0 thì `CLOSED` | Có khách, Nợ `FUND_HOLDING`/`BOND_HOLDING` |
| `SETTLE` | Đóng cả khoản; trả gốc + lãi dồn tích theo lãi suất chốt đến hôm nay | Có khách; Nợ `TERM_DEPOSIT` (gốc), `INTEREST_PAYABLE` (lãi) |
| `BUY` | Cộng vào khoản đang mở, giá vốn bình quân gia quyền | Nợ khách, Có `FUND_HOLDING`/`BOND_HOLDING` |
| `OPEN` | Khoản mới, lãi suất hiện hành, đáo hạn sau số tháng của kỳ hạn | Nợ khách, Có `TERM_DEPOSIT` |

- Giá khớp là giá mới nhất lúc khớp. Mỗi chân là một `investment_transactions` và một journal cân; `LedgerService` nhận `investmentTransactionId` thay cho `cashTxnId`.
- Holdings chỉ được ghi qua cầu nối P3 `portfolio-valuation/holdings-mutation.ts`.
- Sau khi khớp: `DriftScanner` (trigger `EXECUTION`) định giá lại và quét lệch, luôn ghi snapshot `EVENT`.
- Trigger của nhóm trên đề xuất và chân lệnh dùng kiểu không có tiền tố schema, nên mọi transaction ghi đề xuất đặt `search_path` về `wms, public` cục bộ (như `LedgerService`).

## Quyết định với các điểm mâu thuẫn của đặc tả

| Vấn đề | Chọn | Lý do |
|---|---|---|
| Trượt giá: "không cho duyệt" (FR-15) hay `FAILED` (BR-22) | `FAILED` với `SLIPPAGE_EXCEEDED` | UC-15 ngoại lệ 3 và BR-22 |
| Sai OTP | Thử lại tối đa 3 lần, đề xuất vẫn chờ | UC-15 ngoại lệ 4 (khác nạp/rút của P2) |
| Duyệt và khớp: đồng bộ hay job | Đồng bộ, cùng một transaction | UC-15 bước 8 gọi trực tiếp UC-16; khớp lệnh là mô phỏng nội bộ, không gọi Core |
| Tất toán trước hạn | Gốc + lãi dồn tích | Đặc tả không nói; khớp với giá trị UC-11 đang hiển thị |
| Chân lệnh `COMPLETED` | Kết quả nằm ở `investment_transactions` (`EXECUTED`) và `actual_executed_price` | `proposal_legs` không có cột trạng thái |
| Thông báo cho khách và RM | Suy từ danh sách đề xuất; outbox `ProposalCreated`, `ProposalExecuted` | Chưa có kênh push thật |

## API (tiền tố `/api/v1`)

Mọi lệnh `POST` cần `Idempotency-Key`.

| Vai trò | Endpoint |
|---|---|
| RM | `POST /customers/:customerId/proposals`, `GET /rm/proposals?status=`, `POST /proposals/:id/cancel` |
| RM, Trưởng nhóm | `GET /customers/:customerId/proposals`, `GET /proposals/:id` (mỗi lượt xem ghi audit) |
| Khách | `GET /me/proposals`, `GET /me/proposals/:id`, `POST /me/proposals/:id/reject`, `POST /me/proposals/:id/approval-challenge`, `POST /me/proposals/:id/approve` |

Mã lỗi riêng: `PROPOSAL_PENDING_EXISTS`, `SUITABILITY_VIOLATION`, `PRODUCT_NOT_ON_SALE`, `PRICE_UNAVAILABLE`, `BELOW_MIN_INVESTMENT`, `HOLDING_NOT_FOUND`, `QUANTITY_EXCEEDS_HOLDING`, `BUDGET_EXCEEDED`, `ALERT_NOT_FOUND`, `ALERT_NOT_OPEN`, `PROPOSAL_NOT_PENDING`, `PROPOSAL_EXPIRED`, `SLIPPAGE_EXCEEDED`, `OTP_ATTEMPTS_EXCEEDED`; dùng lại `RISK_PROFILE_REQUIRED` (422) và các mã OTP có sẵn.

## Giới hạn hiện tại

- Chưa có phí giao dịch và tất toán một phần.
- Hai chân `OPEN` cùng một sản phẩm tiền gửi trong một đề xuất bị chặn, vì schema chỉ cho một khoản đang mở mỗi sản phẩm và ngày bắt đầu.
- Biến `PROPOSAL_JOBS_ENABLED` (mặc định `true`) bật job hết hạn trong API; E2E tắt nó.

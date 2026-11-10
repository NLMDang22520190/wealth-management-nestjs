# Phần 2: Tài khoản và Dòng tiền

Hiện thực UC-05 (nạp tiền), UC-06 (rút tiền), UC-07 (lịch sử và sổ cái), UC-08 (tất toán tiền gửi đến hạn) và quy trình đối soát 2c. Mã nguồn ở `apps/api/src/modules/accounts-ledger/`, giao diện ở `apps/web/src/pages/Cash.tsx` và `BackOffice.tsx`. Phần này không thêm migration: mọi bảng đã có trong schema `wms` của nhóm.

## Luồng tiền

Core Banking được gọi ngoài mọi khóa dữ liệu, tối đa 2 giây. Không có phản hồi không có nghĩa là thất bại, nên giao dịch chuyển `PENDING` để đối soát.

| Bước | Nạp tiền | Rút tiền |
|---|---|---|
| Tạo lệnh | Kiểm tra quy tắc, tạo `INIT` và OTP | Như nạp, thêm phong tỏa số tiền |
| Xác nhận OTP | Tiêu thụ OTP, chưa ghi sổ | Tiêu thụ OTP, ghi 2 bút toán, trừ số dư và phong tỏa |
| Core đồng ý | Ghi 2 bút toán, cộng số dư, `SUCCESS` | `SUCCESS` |
| Core từ chối | `FAILED`, không có bút toán | Bút toán đảo, hoàn số dư, `FAILED` |
| Core không phản hồi | `PENDING`, không có bút toán | `PENDING`, giữ bút toán |
| OTP sai hoặc hết hạn | `FAILED`, phải tạo lệnh mới | `FAILED`, giải tỏa, phải tạo lệnh mới |

## Quyết định với các điểm mâu thuẫn của đặc tả

| Vấn đề | Chọn | Lý do |
|---|---|---|
| Chiều bút toán | Có làm tăng, Nợ làm giảm TK đầu tư | Khớp seed và NFR-P2-03; UC-16 khi hiện thực cần theo cùng chiều |
| Tất toán có gọi Core không | Không | Quy trình 2d và UC-08 chi tiết hơn BR-13 |
| Idempotency 5 phút hay 24 giờ | 24 giờ | Dùng chung `platform/transactions.ts`, đáp ứng cả BR-10 và NFR-P2-05 |
| Trạng thái `MATURED` của khoản gửi | `holding_status = 'CLOSED'` | Enum của schema nhóm |

## Job nền

`cash-jobs.ts` kiểm tra mỗi phút, khóa `pg_try_advisory_lock` để chỉ một instance chạy tại một thời điểm. Đặt `CASH_JOBS_ENABLED=false` để tắt.

- **Đối soát, mỗi 5 phút:** hỏi Core giao dịch `PENDING` theo `ref_no`, chỉ sau 60 giây kể từ lúc dùng OTP, vì lệnh gọi Core vừa hết giờ chờ có thể vẫn đang chạy. Nút chạy demo bỏ qua khoảng chờ này. Sau 3 lượt không có phản hồi, giao dịch vào hàng chờ Back-office.
- **Dọn lệnh dở, cùng lượt đối soát:** OTP hết hạn mà chưa dùng thì `FAILED` và giải tỏa; OTP đã dùng quá 60 giây mà chưa có kết quả thì chuyển `PENDING`.
- **Tất toán, sau 00:30 giờ Việt Nam:** chạy một lần mỗi ngày, API khởi động muộn thì chạy bù. Mỗi khoản một transaction. Kết quả lượt chạy lưu trong `audit_logs` (`MATURITY_RUN_COMPLETED`).
- **Lãi:** `floor(gốc × lãi suất năm × số ngày gửi / 36500)`, tính trong SQL `numeric`. Chạy trễ không tính thêm ngày.

## API (tiền tố `/api/v1`)

Mọi lệnh `POST` của khách và Back-office cần `Idempotency-Key`. Số tiền là chuỗi decimal, tối đa 2 chữ số lẻ.

| Vai trò | Endpoint | Ghi chú |
|---|---|---|
| Khách | `GET /me/investment-account` | Số dư, hạn mức còn lại, CASA |
| Khách | `POST /me/deposits`, `POST /me/withdrawals` | Body `sourceCasaNo` hoặc `destCasaNo`, `amount`; trả `txnId`, `refNo`, `challengeId`, `expiresAt` |
| Khách | `POST /me/deposits/:id/confirm`, `POST /me/withdrawals/:id/confirm` | Body `challengeId`, `code`; trả 200 với `status` là `SUCCESS`, `FAILED` hoặc `PENDING` |
| Khách | `GET /me/cash-transactions`, `GET /me/cash-transactions/:id` | Lọc `type`, `status`, `from`, `to`, `page`, `pageSize`; mặc định 30 ngày; chi tiết có `entries` |
| Khách | `GET /me/cash-notifications` | 20 giao dịch vừa kết thúc |
| RM, Trưởng nhóm | `GET /customers/:id/cash-transactions`, `.../:txnId` | Theo phân công hiện hành; mỗi lượt xem ghi audit |
| Back-office | `GET /back-office/cash-transactions`, `.../:id` | Thêm lọc `cifId`, `needsReview`; mỗi lượt xem ghi audit |
| Back-office | `POST /back-office/cash-transactions/:id/resolve` | Body `outcome`, `note` |
| Back-office | `GET /back-office/maturity-runs` | 20 lượt tất toán gần nhất |
| Back-office, chỉ khi mock | `POST /demo/jobs/reconciliation`, `POST /demo/jobs/maturity-settlement` | Body của tất toán có `asOf` tùy chọn |

Mã lỗi riêng: `ACCOUNT_NOT_FOUND`, `ACCOUNT_NOT_ACTIVE`, `CASA_NOT_ELIGIBLE`, `AMOUNT_BELOW_MINIMUM`, `DAILY_LIMIT_EXCEEDED` (`details.remaining`), `INSUFFICIENT_AVAILABLE_BALANCE` (`details.maxAmount`), `TXN_NOT_CONFIRMABLE`, `TXN_NOT_RESOLVABLE`, `JOB_RUNNING`.

## Kịch bản demo của Core mô phỏng

Chọn theo số tiền, chỉ ở chế độ mock (`platform/demo-core.ts`). Số dư CASA là giá trị cố định, không bị trừ.

| Số tiền | Kết quả |
|---|---|
| `1.000.111` | Core từ chối |
| `1.000.222` | Không phản hồi, đối soát thấy đã hạch toán |
| `1.000.333` | Không phản hồi, đối soát thấy chưa hạch toán |
| `1.000.444` | Không phản hồi cả 3 lượt, chuyển Back-office |

## Giới hạn hiện tại

- Chưa có thao tác đóng băng hoặc đóng tài khoản; trạng thái `FROZEN` đã được tôn trọng khi nạp, rút và tất toán.
- Tính lại AUM thật thuộc Phần 3: Phần 2 chỉ phát sự kiện outbox `CashTransactionCompleted` và `MaturitySettled`.
- Thông báo cho khách suy từ giao dịch đã kết thúc, chưa có push thật và trạng thái đã đọc.
- `NV0005` (`BACK_OFFICE_MANAGER`) chưa đăng nhập được.

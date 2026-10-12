# Chương 1 — Tổng quan WealthFlow

## Bối cảnh

Khách hàng cá nhân có thể nắm giữ tiền gửi, trái phiếu và chứng chỉ quỹ nhưng cần một góc nhìn thống nhất để được tư vấn phù hợp. Khi RM theo dõi thủ công, hồ sơ rủi ro có thể hết hạn, quyền quản lý không rõ sau chuyển giao và đề xuất có thể vượt khẩu vị của khách.

WealthFlow là bản demo học thuật của hệ thống Wealth Management theo mô hình **tư vấn có kiểm soát**. RM đăng ký dịch vụ và tư vấn; khách hàng tự xác nhận điều khoản, hồ sơ rủi ro và đề xuất. Đề xuất mua mới phải phù hợp với hồ sơ rủi ro còn hiệu lực. Hệ thống hỗ trợ theo dõi danh mục và cảnh báo sai lệch phân bổ, không tự quyết định đầu tư thay khách.

## Mục tiêu

1. Chuẩn hóa onboarding trên CIF có sẵn, ghi nhận sự đồng ý bằng OTP mô phỏng.
2. Đánh giá khẩu vị bằng bảng khảo sát versioned, giữ lịch sử và mốc đánh giá lại.
3. Phân công RM rõ ràng; hạn mức 80, phạm vi nhóm và quyền hiện hành được kiểm tra tại backend.
4. Tạo nền source NestJS/React để bốn thành viên phát triển các phân hệ trong cùng repo.
5. Chứng minh luồng chính và ngoại lệ bằng dữ liệu giả lập và kiểm thử PostgreSQL thật; không sử dụng kết quả kiểm thử dự kiến làm kết quả đã chạy.

## Mô hình nghiệp vụ được lựa chọn

**Mô hình A:** khách có một tài khoản đầu tư riêng liên kết với tài khoản thanh toán VND chính chủ. P2 quản lý nạp/rút và sổ cái nội bộ; P3 quản lý sản phẩm/định giá; P4 quản lý đề xuất và thực thi mô phỏng. Đây là lựa chọn đã được duyệt, thay vì mô hình chỉ tổng hợp tài sản và gửi lệnh tới hệ thống nguồn.

Một NestJS API chia bốn module, một PostgreSQL và một React app. Đây là **modular monolith**, không phải bốn microservices được triển khai riêng. Sự thay đổi kiến trúc đã được chấp thuận để phù hợp nhóm và tránh mô tả giao dịch nguyên tử qua hệ thống ngoài một cách sai lệch.

## Phạm vi

| Nhóm | Trong phạm vi repo phần 1 | Phần tiếp theo / ngoài phạm vi |
|---|---|---|
| Khách hàng | UC01 đăng ký, UC02 risk, UC03 RM assignment, UC04 danh sách và detail | Không tạo KYC hoặc CIF ngân hàng mới |
| Nền tảng | Auth mock ký token, validation, audit, idempotency, transaction, outbox, DB migration, UI shell | Không tích hợp SSO/SmartOTP ngân hàng thật |
| P2 | Contract mở account số dư0 phục vụ onboarding | UC05–08 nạp/rút/đối soát/đáo hạn và ledger hoàn chỉnh do P2 làm |
| P3 | Contract dữ liệu snapshot/holdings/cảnh báo phục vụ P1; thiếu dữ liệu có nhãn | UC09–12 catalog/NAV/valuation/drift engine hoàn chỉnh do P3 làm |
| P4 | Contract đề xuất pending và hủy nguyên tử khi chuyển RM | UC13–16 tư vấn/duyệt/khớp lệnh/ledger hoàn chỉnh do P4 làm |
| Tài sản | Tiền mặt đầu tư, tiền gửi, trái phiếu, chứng chỉ quỹ trong domain chung | Giao dịch cổ phiếu sàn, vàng, bảo hiểm, tài khoản chung ngoài đồ án |

## Phương pháp phân tích và hiện thực

Phân tích hướng đối tượng với Use Case, sequence/state diagrams, mô hình dữ liệu quan hệ và ma trận quy tắc. Source tách controller/application/domain/infrastructure ở mức phù hợp. Những luồng security và cập nhật nguyên tử được kiểm thử trước khi triển khai, tách vai trò tester/implementer/reviewer.

Các hệ thống Core/IAM/OTP trong demo là adapter giả lập. Tài liệu, UI và README phải chỉ rõ điều này. Tính nguyên tử nội bộ dựa trên transaction PostgreSQL; không khẳng định PostgreSQL rollback có thể hoàn tác giao dịch ngân hàng bên ngoài.

## Trách nhiệm thành viên 1

Thành viên1 dựng repo, nền tảng dùng chung và hoàn chỉnh backend/React UC01–04; làm chương1, UC tổng thể, đặc tả UC01–04, sequence risk và tài liệu dữ liệu liên quan. Thành viên1 phối hợp bàn giao contract và tổng hợp báo cáo; không mặc định sở hữu toàn bộ nghiệp vụ phần2–4.

Xem [kế hoạch đã duyệt](../planning/implementation-plan.vi.md) cho lịch6tuần, assumptions và ranh giới chi tiết. Tài liệu kết quả kiểm tra và những giới hạn của bản source sẽ được ghi theo bản chạy thực tế tại lúc bàn giao.

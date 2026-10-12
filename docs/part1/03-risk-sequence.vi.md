# UC02 — Trình tự xác nhận hồ sơ rủi ro

Tài liệu thiết kế theo kế hoạch đã duyệt. Các tên trạng thái và API cần được đối chiếu với source khi hoàn tất triển khai; đây chưa phải biên bản kiểm thử.

## Mục tiêu

Khách hàng xem 10 câu hỏi, lưu bản nháp và xem kết quả dự kiến. Hồ sơ chỉ có hiệu lực sau khi khách xác nhận OTP. Mỗi lần xác nhận tạo một phiên bản mới; lịch sử không bị ghi đè. Lần xác nhận đầu tiên kích hoạt dịch vụ Wealth Management.

```mermaid
sequenceDiagram
    actor C as Khách hàng
    participant UI as React
    participant API as NestJS — Customer & Risk
    participant OTP as OTP demo
    participant DB as PostgreSQL
    participant P3 as Portfolio bridge
    C->>UI: Trả lời 10 câu hỏi (1–5 điểm)
    UI->>API: POST /me/risk-assessments
    API->>DB: Kiểm tra quyền; lưu draft + hash + phiên bản hiện tại
    DB-->>API: Draft được lưu
    API-->>UI: Điểm, nhóm risk, tỷ trọng dự kiến
    Note over UI,DB: Preview chưa thay đổi hồ sơ hiện hành
    UI->>API: POST /otp/challenges (RISK_PROFILE_CONFIRM)
    API->>DB: Lưu challenge gắn actor + draft + hash
    API->>OTP: Gửi mã sau khi transaction đã kết thúc
    OTP-->>C: Mã OTP demo
    C->>UI: Nhập mã và xác nhận
    UI->>API: POST /me/risk-assessments/:id/confirm + Idempotency-Key
    API->>DB: Khóa khách; đọc lại quyền, phiên bản và thời hạn
    alt Draft cũ, OTP sai/hết hạn hoặc không đúng chủ thể
        API-->>UI: Lỗi có mã ổn định; không cập nhật hồ sơ
    else Xác nhận hợp lệ
        API->>DB: Consume OTP + append profile + cập nhật current pointer
        API->>P3: Đọc holdings qua cùng transaction context
        API->>DB: Audit + outbox; cảnh báo khi hạ risk
        Note over API,DB: Không tự bán tài sản
        DB-->>API: Commit tất cả thay đổi
        API-->>UI: Hồ sơ hiện hành và lịch sử phiên bản
    end
```

## Quy tắc chấm điểm

| Tổng điểm | Nhóm | Mức rủi ro sản phẩm tối đa | Tiền / Tiền gửi / Trái phiếu / Quỹ |
|---|---|---|---|
| 10–20 | Conservative | 2 | 10% / 50% / 30% / 10% |
| 21–35 | Balanced | 3 | 5% / 30% / 30% / 35% |
| 36–50 | Growth | 5 | 5% / 15% / 20% / 60% |

Hồ sơ có thời hạn 12 tháng lịch; ngày cuối tháng được điều chỉnh về ngày hợp lệ của tháng đích. OTP không được dùng lại hoặc dùng cho consent đăng ký. Hai bản nháp dựa trên cùng phiên bản không được cùng ghi đè hồ sơ: bản xác nhận sau phải nhận xung đột và khách xem lại kết quả.

## Ranh giới tích hợp

OTP và Core trong repo là adapter demo, không phải kết nối ngân hàng thật. Phần 3 cung cấp dữ liệu holdings và cảnh báo để Phần 1 đọc; thuật toán định giá đầy đủ thuộc người phụ trách Phần 3. Audit chỉ lưu metadata và before/after đã lọc, không lưu mã OTP hay access token.



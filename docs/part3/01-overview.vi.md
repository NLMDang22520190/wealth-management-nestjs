# Phần 3: Sản phẩm và Định giá danh mục

Hiện thực UC-09 (danh mục sản phẩm), UC-10 (giá, NAV, lãi suất), UC-11 (xem danh mục và định giá Mark-to-Market) và UC-12 (cảnh báo lệch tỷ trọng). Mã nguồn ở `apps/api/src/modules/portfolio-valuation/`, giao diện ở `apps/web/src/pages/Products.tsx`, `Prices.tsx`, `PriceApprovals.tsx`, `Portfolio.tsx`, `DriftAlerts.tsx`.

## Khác với DDL của nhóm

Có một thay đổi, ở migration `009`: thêm `portfolio_snapshots.snapshot_kind` (`DAILY` hoặc `EVENT`, mặc định `DAILY`) và thay `UNIQUE (customer_id, snapshot_date)` bằng unique một phần chỉ áp cho `DAILY`.

Lý do: UC-12 quét cả sau UC-10, UC-08, UC-02, mà mỗi cảnh báo phải trỏ tới một snapshot; nếu một khách chỉ có một snapshot mỗi ngày thì lần chụp 17:00 sẽ không còn chỗ. `tests/api/s19-wms-schema.spec.ts` và `s21-team-seed.spec.ts` khai báo đúng cột và constraint này là ngoại lệ, phần còn lại vẫn khóa theo DDL.

## Quyết định với các điểm mâu thuẫn của đặc tả

| Vấn đề | Chọn | Lý do |
|---|---|---|
| Ngưỡng lệch: `>= 5` hay `> 5` | `>= 5` điểm phần trăm, so sau khi làm tròn 2 chữ số | BR-16, quy trình 3d và `CHECK` của schema |
| Quy tắc 20% có áp cho lãi suất không | Có, cho cả NAV, giá trái phiếu và lãi suất | FR-10 và quy trình 3b; BR-15 chỉ nêu NAV và giá trái phiếu |
| Giao tiếp I-05 (P1 → P3 bằng sự kiện) | Quét lệch gọi trực tiếp sau commit; sự kiện `RiskHoldingsCheckRequested` giữ nguyên cho việc RM kiểm tra | `published_at` rỗng đang có nghĩa "RM chưa kiểm tra", tiêu thụ sự kiện sẽ làm sai `Kiểm tra danh mục chờ` |
| Lỗi truy cập `NOT_YOUR_CUSTOMER` | Giữ `403 FORBIDDEN` và audit `DENIED` | Thống nhất với P1, P2 |
| Mã lỗi `VALIDATION_FAILED` | Giữ `VALIDATION_ERROR` | Mã chung của `StrictBodyPipe` |
| Tỷ trọng mục tiêu lấy từ đâu | `risk_profiles.allocation` của hồ sơ hiện hành; ngưỡng từ `target_allocations.drift_threshold` | Đặc tả mục quan hệ 8 |

## Định giá (BR-17)

Tính khi xem, không ghi dữ liệu. P3 không ghi `portfolio_holdings` vì bảng này chỉ UC-16 được cập nhật, nên cột `accrued_interest` không được dùng.

| Lớp | Giá trị | Giá vốn |
|---|---|---|
| Tiền gửi | gốc + `floor(gốc × locked_rate × số ngày đã gửi / 36500)`, tối đa đến ngày đáo hạn | gốc |
| Trái phiếu | số lượng × giá tham chiếu mới nhất | số lượng × `avg_cost` |
| Chứng chỉ quỹ | số lượng × NAV mới nhất | số lượng × `avg_cost` |

- AUM = tiền mặt khả dụng + giá trị các khoản trên. Tiền và tỷ trọng tính bằng BigInt, không dùng số thực.
- Giá chờ duyệt hoặc bị từ chối không được dùng, nhờ view `v_asset_latest_price`.
- Giá cũ hơn 3 ngày làm việc (thứ Hai đến thứ Sáu, chưa tính ngày lễ) được gắn nhãn, không bị từ chối.
- Sản phẩm chưa có giá: giá trị `null`, không tính vào AUM, danh mục là `INCOMPLETE`, và lượt quét bỏ qua khách này.

## Duyệt giá (BR-15)

`asset_pricing` và `price_approvals` chỉ cho thêm dòng. Biến động trên 20% thì dòng giá có trạng thái `PENDING_APPROVAL`; quyết định là một dòng mới trong `price_approvals`, còn trạng thái dòng giá không đổi (seed của nhóm cũng làm vậy). Chỉ `BACK_OFFICE_MANAGER` được duyệt, và không được duyệt giá do chính mình nhập. Mỗi sản phẩm có tối đa một giá chờ duyệt.

## Quét lệch (UC-12)

`DriftScanner.scanCustomer` dùng chung cho mọi nguồn, mỗi khách một transaction. Lỗi khi quét sau một nghiệp vụ chỉ ghi log, không làm hỏng nghiệp vụ đó; job 17:00 sẽ làm bù.

| Nguồn | Khách được quét | Snapshot |
|---|---|---|
| Job, sau 17:00 giờ Việt Nam | Dịch vụ `ACTIVE`, chưa có `DAILY` của ngày | `DAILY` |
| UC-10, giá có hiệu lực (trừ lãi suất) | Đang giữ sản phẩm đó | Luôn ghi `EVENT` |
| UC-08, sau lượt tất toán | Tài khoản vừa được tất toán | `EVENT` khi có cảnh báo cần tạo |
| UC-02, sau xác nhận hồ sơ | Khách đó | `EVENT` khi có cảnh báo cần tạo |

- Chỉ tạo cảnh báo khi AUM khác 0, hồ sơ rủi ro còn hiệu lực và có RM phụ trách. Khách hồ sơ hết hạn vẫn có snapshot.
- Mỗi cặp khách và nhóm tài sản có một cảnh báo đang mở: số đổi thì `RESOLVED` và tạo mới, hết lệch thì `RESOLVED`, `ACTIONED` giữ nguyên để P4 xử lý.
- Gợi ý là số tiền đưa nhóm về đúng mục tiêu: `|giá trị − mục tiêu × AUM / 100|`. Hệ thống không tự đặt lệnh.
- Danh sách cảnh báo của RM đi theo phân công hiện hành, không theo `rm_id` trên cảnh báo.
- Cảnh báo sản phẩm vượt mức rủi ro (UC-09) tính khi xem, nên tự hết khi không còn vượt mức.

## API (tiền tố `/api/v1`)

Mọi lệnh `POST` và `PATCH` nghiệp vụ cần `Idempotency-Key`. Tiền và giá là chuỗi decimal.

| Vai trò | Endpoint | Ghi chú |
|---|---|---|
| Back-office | `GET /back-office/assets`, `GET .../:id` | Lọc `assetClass`, `status`, `q`; chi tiết có lịch sử giá |
| Back-office | `POST /back-office/assets` | Bản ghi cha, bản ghi con và giá khởi tạo trong một transaction |
| Back-office | `PATCH .../assets/:id/status`, `.../risk-level` | |
| Back-office | `POST /back-office/prices` | Trả giá cũ, mới, `changePct`, `status`, `scan` |
| Back-office | `POST /back-office/prices/import` | Body `csv`, cột `assetCode,value,effectiveDate`, tối đa 500 dòng; trả kết quả từng dòng |
| Back-office, Quản lý | `GET /back-office/prices/pending` | |
| Quản lý | `POST /back-office/prices/:id/approve`, `.../reject` | Body `reason` |
| RM, Trưởng nhóm | `GET /products` | Sản phẩm đang bán |
| Khách | `GET /me/portfolio`, `GET /me/portfolio/aum-history` | Lịch sử có `days`, mặc định 90, tối đa 365 |
| RM, Trưởng nhóm | `GET /customers/:id/portfolio`, `.../aum-history`, `.../drift-alerts` | Theo phân công hiện hành; mỗi lượt xem ghi audit |
| RM | `GET /rm/drift-alerts`, `POST /rm/drift-alerts/:id/read` | |
| RM | `GET /rm/product-risk-warnings` | |
| Back-office, chỉ khi mock | `POST /demo/jobs/portfolio-snapshot` | Body có `asOf` tùy chọn |

Mã lỗi riêng: `PRODUCT_CODE_EXISTS`, `BOND_MATURITY_PASSED`, `ASSET_NOT_FOUND`, `PRICE_PENDING_EXISTS`, `PRICE_NOT_LATEST`, `PRICE_NOT_PENDING`, `MAKER_CHECKER_VIOLATION`, `ALERT_NOT_FOUND`, `ACCOUNT_NOT_FOUND`, `JOB_RUNNING`.

## Giới hạn hiện tại

- Chưa có nút "Tạo đề xuất tái cân bằng": nút này và việc chuyển cảnh báo sang `ACTIONED` thuộc UC-13 của P4.
- Quét lệch sau UC-10 chạy đồng bộ trong request, ổn với dữ liệu demo nhưng sẽ chậm nếu có rất nhiều khách giữ một sản phẩm.
- RM nhận cảnh báo qua màn hình `Cảnh báo lệch`, chưa có push thật.
- Sửa thông tin sản phẩm ngoài trạng thái và mức rủi ro chưa được hỗ trợ.
- Import CSV: nếu lượt lưu kết quả cuối cùng lỗi sau khi các dòng đã ghi, gửi lại cùng khóa sẽ xử lý lại file.

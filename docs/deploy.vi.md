# Deploy bản demo: Netlify (giao diện) + Render (API) + Neon (PostgreSQL)

Đây là **bản demo**: IAM, Core Banking và OTP đều giả lập, ai biết địa chỉ trang đều đổi vai tùy ý. Chỉ dùng dữ liệu mẫu, không đưa dữ liệu thật vào.

```
Trình duyệt ──> Netlify (apps/web, file tĩnh)
                   │  /api/*  chuyển tiếp (proxy)
                   ▼
               Render (apps/api, NestJS) ──> Neon (PostgreSQL, schema wms)
```

## 1. Neon (cơ sở dữ liệu)
1. Tạo project trên Neon, chọn PostgreSQL 15 trở lên (schema của nhóm cần ≥ 13).
2. Lấy chuỗi kết nối **trực tiếp** (không phải bản pooler), dạng `postgresql://…@…neon.tech/<db>?sslmode=require`. API dùng khóa tư vấn của PostgreSQL và chạy migration lúc khởi động, nên không dùng pooler.
3. Nạp dữ liệu mẫu **một lần** từ máy bạn (không đưa chuỗi kết nối vào file nào của repo):

```bash
export DATABASE_URL='<chuỗi kết nối Neon>'
npm ci
npm run seed:demo
```

`seed:demo` chạy migration rồi nạp dữ liệu mẫu của nhóm; chạy lại vẫn an toàn.

## 2. Render (API)
1. Render > New > Blueprint > chọn repo này; Render đọc `render.yaml`.
2. Khi được hỏi `DATABASE_URL`, dán chuỗi kết nối Neon. `JWT_SECRET` Render tự sinh.
3. Chờ build xong, mở `https://<tên-dịch-vụ>.onrender.com/api/v1/health/ready`: phải trả 200.

Lưu ý gói free: dịch vụ ngủ khi nhàn rỗi (lần gọi đầu chậm vài chục giây) và các job định kỳ trong tiến trình (đối soát, tất toán, chụp danh mục 17:00, hết hạn đề xuất) chỉ chạy khi dịch vụ đang thức.

`NODE_ENV` phải là `development` vì code từ chối `MOCK_AUTH_ENABLED=true` khi `NODE_ENV=production`.

## 3. Netlify (giao diện)
1. Sửa `netlify.toml`: thay `wealthflow-api` bằng tên dịch vụ thật trên Render.
2. Netlify > Add new site > Import from Git > chọn repo. Lệnh build và thư mục xuất bản đã có trong `netlify.toml`; phiên bản Node lấy từ `.nvmrc`.
3. Mở địa chỉ Netlify, chọn **Vai trò demo** như hướng dẫn trong README.

## Chạy máy cá nhân vẫn như cũ
Biến `HOST` mặc định `127.0.0.1`. Chỉ khi deploy mới đặt `HOST=0.0.0.0`.

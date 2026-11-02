# Tên trường JSON của API Phần 1 (R9)

Từ migration `008` (schema `wms` của nhóm), mọi API Phần 1 dùng tên cột của nhóm viết camelCase cho cùng một dữ liệu. Quy tắc (D-R9-10):

- Chỉ đổi tên: đường dẫn, mã HTTP, mã lỗi, tập trường và giá trị giữ nguyên; không thêm hay bỏ trường.
- `id` chung chung đổi thành tên khóa chính của bảng nhóm: `customerId`, `requestId`, `draftId`, `riskProfileId`, `assignmentId`, `notificationId`, `challengeId`, `staffId`.
- Tên khách `name` thành `fullName`; tên khách trong lời mời thành `customerName`; `selectedAccountId` thành `selectedCasaNo`; `rmName` thành `rmFullName` (lấy từ `staff_users.full_name`, trước đây là mã nhân viên).
- Trường không có cột tương ứng (số tính toán, nhãn như `valid`, `cash`, `aum`, `holdingsCheck`, `assignmentVersion`, `riskProfileValid`, `lastReminderAt`) giữ tên cũ. Id câu hỏi/đáp án (`questions[].id`, `options[].id`) nằm trong JSONB nên giữ `id`.
- Tham số truy vấn (`?name=`, `?sort=name`, `?page`, `?pageSize`, `?risk`, `?riskExpiry`, `?serviceStatus`, `?direction`) là bộ lọc/sắp xếp, không phải trường JSON, nên giữ nguyên.
- Nhật ký `audit_logs` (`old_value`/`new_value`) không phải JSON của API và giữ cấu trúc cũ (ví dụ `id`).
- Hợp đồng Core banking (`CoreBanking.lookup`: `name`, `accounts[].id`) là hợp đồng bên ngoài, không đổi; API tự đổi tên khi trả về.

## Bản đồ theo endpoint (cũ thành mới)

| Endpoint | Cũ | Mới |
|---|---|---|
| `POST /onboarding/customer-lookup` (200) | `name` | `fullName` |
| | `accounts[].id` | `accounts[].casaNo` |
| | `cifRef, dateOfBirth, active, eligible, accounts[].ownerCifId, currency, active` | không đổi |
| `POST /onboarding/requests` (201) | body `selectedAccountId` | body `selectedCasaNo` |
| | phản hồi `id` | `requestId` |
| | `status, expiresAt, termsVersion` | không đổi |
| `GET /me/onboarding-requests` | `items[].id` | `items[].requestId` |
| `GET /me/onboarding-requests/:id` | `id`, `terms` | `requestId`, `terms` (không đổi) |
| `POST /me/onboarding-requests/:id/confirm` | `requestId, customerId, serviceId, accountId, status` | không đổi (đã dùng tên khóa nhóm) |
| `POST /otp/challenges`, `GET /me/otp-challenges/:id/demo-code` | `challengeId, expiresAt, code, operationId, purpose` | không đổi |
| `GET /risk-questionnaires/current` | `version, questions[].id/text, options[].id/text` | không đổi |
| `POST /me/risk-assessments` (201) | `id` | `draftId` |
| | `questionnaireVersion, answers, score, category, maxProductRisk, allocation, expectedCurrentProfileVersion, payloadHash, expiresAt` | không đổi |
| `POST /me/risk-assessments/:id/confirm` (200) | `id` | `riskProfileId` |
| | `draftId, customerId, version, questionnaireVersion, answers, score, category, maxProductRisk, allocation, confirmedAt, expiresAt, valid` | không đổi |
| `GET /me/risk-profile`, `GET /customers/:id/risk-profile` | `current.id` | `current.riskProfileId` |
| | `current.*` còn lại, `holdingsCheck` | không đổi |
| `GET /me/risk-profile/history`, `GET /customers/:id/risk-profile/history` | `items[].id` | `items[].riskProfileId` |
| | `total, page, pageSize` | không đổi |
| `GET /rm/customers` (item) và `GET /customers/:id` | `name` | `fullName` |
| | `currentRisk.id` | `currentRisk.riskProfileId` |
| | `customerId, serviceStatus, currentAssignment{rmId,teamId,version,provisional,validFrom}, currentRisk.category/version/expiresAt/valid, aum, cash, driftAlerts, pendingProposals` | không đổi |
| `GET /team/rms` (item) | `rmName` | `rmFullName` |
| | `rmId, teamId, active, assigned, reserved, available, capacityLimit` | không đổi |
| `GET /team/customers` (item) | `name` | `fullName` |
| | `rmName` | `rmFullName` |
| | `customerId, rmId, assignmentVersion, riskProfileValid, lastReminderAt` | không đổi |
| `POST /customers/:id/rm-assignment` | body `targetRmId, reason, expectedAssignmentVersion`; phản hồi `customerId, rmId, teamId, version, changed, cancelledProposals` | không đổi |
| `POST /team/risk-survey-reminders` | body `customerIds`; phản hồi `sent, skipped[].customerId/reason` | không đổi |
| `GET /notifications` | `items[].id` | `items[].notificationId` |
| | `kind, message, createdAt, readAt` | không đổi |
| `POST /notifications/:id/read` | `id` | `notificationId` |
| | `readAt` | không đổi |
| `GET /auth/me`, `POST /mock-auth/token` | `actorId, subjectId, role, cifId, rmId, teamId`; `accessToken, expiresIn` | không đổi |

Ghi chú: tên khách trong lời mời (`customerName`) chỉ nằm ở cột `onboarding_requests.customer_name`; API hiện không trả trường này nên không có thay đổi tương ứng. `staffId` và `assignmentId` chưa xuất hiện trong phản hồi P1 nào (RM được nhận diện bằng `rmId`, theo mẫu của nhóm).

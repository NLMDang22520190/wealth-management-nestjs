// Thin API client. The access token lives in this module's memory only: never in storage, never in the URL.
let accessToken: string | null = null;
export function setToken(token: string | null): void { accessToken = token; }

export class ApiFailure extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) { super(message); }
}

interface Options { method?: string; body?: unknown; key?: string; signal?: AbortSignal; auth?: boolean }

export async function api<T>(path: string, options: Options = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.key) headers['idempotency-key'] = options.key;
  if (options.auth !== false && accessToken) headers.authorization = `Bearer ${accessToken}`;
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers, signal: options.signal,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiFailure(0, 'NETWORK', 'network');
  }
  const raw = await response.text();
  let parsed: unknown = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  if (!response.ok) {
    const body = (parsed ?? {}) as { code?: string; message?: string; details?: unknown };
    throw new ApiFailure(response.status, body.code ?? 'UNKNOWN', body.message ?? 'error', body.details);
  }
  return parsed as T;
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Idempotency keys follow the user's intent: the same intent (same signature) retried keeps the same key,
 * so a retry after a network failure can never perform the operation twice. A new intent gets a new key.
 */
const intents = new Map<string, { signature: string; key: string }>();
export function intentKey(name: string, signature: string): string {
  const known = intents.get(name);
  if (known && known.signature === signature) return known.key;
  const key = `web-${name}-${crypto.randomUUID()}`;
  intents.set(name, { signature, key });
  return key;
}
export function intentDone(name: string): void { intents.delete(name); }

const messages: Record<string, string> = {
  NETWORK: 'Không kết nối được máy chủ. Kiểm tra kết nối rồi thử lại.',
  UNAUTHORIZED: 'Phiên demo không hợp lệ hoặc đã hết hạn. Hãy chuyển vai lại.',
  FORBIDDEN: 'Bạn không có quyền thực hiện thao tác này',
  NOT_FOUND: 'Không tìm thấy dữ liệu yêu cầu',
  CUSTOMER_NOT_FOUND: 'Không tìm thấy khách hàng',
  PRODUCT_CODE_EXISTS: 'Mã sản phẩm đã tồn tại.',
  BOND_MATURITY_PASSED: 'Ngày đáo hạn của trái phiếu đã qua.',
  ASSET_NOT_FOUND: 'Không tìm thấy sản phẩm.',
  PRICE_PENDING_EXISTS: 'Sản phẩm này đang có giá chờ duyệt.',
  PRICE_NOT_LATEST: 'Đã có giá mới hơn ngày hiệu lực này.',
  PRICE_NOT_PENDING: 'Giá này không còn chờ duyệt.',
  MAKER_CHECKER_VIOLATION: 'Người nhập giá không được tự duyệt giá của mình.',
  ALERT_NOT_FOUND: 'Không tìm thấy cảnh báo.',
  VALIDATION_ERROR: 'Dữ liệu chưa hợp lệ. Kiểm tra lại các trường đã nhập.',
  OTP_INVALID: 'Mã OTP không đúng. Kiểm tra lại mã rồi nhập lại.',
  OTP_PURPOSE_MISMATCH: 'Mã OTP không dùng cho thao tác này. Hãy gửi mã mới.',
  OTP_BINDING_MISMATCH: 'Mã OTP không khớp với thao tác này. Hãy gửi mã mới.',
  OTP_ALREADY_USED: 'Mã OTP đã được dùng. Hãy gửi mã mới.',
  OTP_EXPIRED: 'Mã OTP đã hết hạn. Hãy gửi mã mới.',
  IDEMPOTENCY_CONFLICT: 'Yêu cầu trùng khóa nhưng khác nội dung. Hãy thử lại thao tác.',
  ONBOARDING_EXISTS: 'Đã có lời mời đăng ký đang chờ khách hàng đồng ý',
  ONBOARDING_EXPIRED: 'Lời mời đã hết hạn. RM cần tạo lời mời mới.',
  SERVICE_EXISTS: 'Khách hàng đã đăng ký dịch vụ',
  RM_CAPACITY_EXCEEDED: 'RM đã đủ 80 khách hàng, không thể nhận thêm',
  RM_ASSIGNMENT_STALE: 'Phân công đã thay đổi. Tải lại để xem phân công hiện tại trước khi chuyển.',
  RISK_PROFILE_REQUIRED: 'Khách chưa hoàn thành khảo sát rủi ro',
  RM_INACTIVE: 'RM nhận không còn hoạt động',
  SERVICE_INACTIVE: 'Dịch vụ của khách hàng chưa hoạt động nên chưa thể chuyển RM',
  CUSTOMER_INELIGIBLE: 'Khách hàng chưa đủ điều kiện đăng ký dịch vụ',
  ACCOUNT_INELIGIBLE: 'Tài khoản đã chọn không đủ điều kiện',
  RISK_PROFILE_STALE: 'Hồ sơ rủi ro đã thay đổi. Hãy xem lại kết quả dự kiến.',
  RISK_DRAFT_EXPIRED: 'Kết quả dự kiến đã hết hạn. Hãy xem lại kết quả dự kiến.',
  QUESTIONNAIRE_VERSION_MISMATCH: 'Bộ câu hỏi đã được cập nhật. Hãy tải lại trang khảo sát.',
  RATE_LIMITED: 'Bạn tra cứu quá nhiều lần. Hãy thử lại sau ít phút.',
  CORE_UNAVAILABLE: 'Hệ thống lõi ngân hàng tạm thời không khả dụng. Hãy thử lại sau.',
  UNAVAILABLE: 'Dịch vụ tạm thời không khả dụng. Hãy thử lại sau.',
  ACCOUNT_NOT_FOUND: 'Không tìm thấy tài khoản đầu tư',
  ACCOUNT_NOT_ACTIVE: 'Tài khoản đầu tư đang không hoạt động',
  CASA_NOT_ELIGIBLE: 'Tài khoản thanh toán không đủ điều kiện',
  AMOUNT_BELOW_MINIMUM: 'Số tiền thấp hơn mức tối thiểu',
  DAILY_LIMIT_EXCEEDED: 'Vượt hạn mức trong ngày',
  INSUFFICIENT_AVAILABLE_BALANCE: 'Số dư khả dụng không đủ',
  TXN_NOT_CONFIRMABLE: 'Lệnh này không còn xác nhận được',
  TXN_NOT_RESOLVABLE: 'Giao dịch này không còn chờ Back-office xử lý',
  JOB_RUNNING: 'Một tác vụ khác đang chạy. Hãy thử lại sau ít phút.',
};

/** Vietnamese message for an error; `overrides` lets a screen say something more specific for a code or status. */
export function describe(error: unknown, overrides: Record<string, string> = {}): string {
  if (!(error instanceof ApiFailure)) return 'Đã xảy ra lỗi không mong muốn. Hãy thử lại.';
  return overrides[error.code] ?? overrides[String(error.status)] ?? messages[error.code]
    ?? (error.status >= 500 ? 'Máy chủ gặp lỗi. Hãy thử lại sau.' : 'Không thể hoàn tất thao tác. Hãy thử lại.');
}

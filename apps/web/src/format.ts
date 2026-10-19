const dateFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' });
const dateTimeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit',
  year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** dd/MM/yyyy in Asia/Ho_Chi_Minh. */
export function formatDate(iso: string): string { return dateFormat.format(new Date(iso)); }
export function formatDateTime(iso: string): string { return dateTimeFormat.format(new Date(iso)).replace(',', ''); }

/** Integer-safe VND: the decimal string from the API is regrouped as text; no Number arithmetic touches money. */
export function formatVnd(value: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return value;
  const grouped = match[2]!.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${match[1]}${grouped}${match[3] ? `,${match[3]}` : ''} ₫`;
}

export const riskLabels: Record<string, string> = { CONSERVATIVE: 'Thận trọng', BALANCED: 'Cân bằng', GROWTH: 'Tăng trưởng' };
export function riskLabel(category: string): string { return riskLabels[category] ?? category; }

const compactFormat = new Intl.NumberFormat('vi-VN', { notation: 'compact', compactDisplay: 'long', maximumFractionDigits: 2 });
/** Display-only short form ("1,73 tỷ ₫"); never used for arithmetic. Pair it with a title holding formatVnd. */
export function formatCompactVnd(value: string): string {
  const amount = Number(value);
  return Number.isFinite(amount) ? `${compactFormat.format(amount)} ₫` : value;
}

const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function formatTime(date: Date): string { return timeFormat.format(date); }

const provenanceLabels: Record<string, string> = { SYNTHETIC_P3_READ_BRIDGE: 'Dữ liệu tổng hợp (demo)' };
export function provenanceLabel(code: string): string { return provenanceLabels[code] ?? code; }

/** First 8 characters of an id: enough to tell RMs apart without printing a whole UUID. */
export function shortId(id: string): string { return id.slice(0, 8); }
export function rmText(id: string, name?: string | null): string { return name ? `${name} · ${shortId(id)}` : shortId(id); }

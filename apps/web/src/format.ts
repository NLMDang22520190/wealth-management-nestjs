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

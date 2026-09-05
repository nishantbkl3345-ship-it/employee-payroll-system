const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});
const compactCurrency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});
const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

export const money = (v: unknown): string => currency.format(Number(v) || 0);
export const moneyCompact = (v: unknown): string => compactCurrency.format(Number(v) || 0);
export const num = (v: unknown): string => number.format(Number(v) || 0);
export const hours = (v: unknown): string => `${number.format(Number(v) || 0)}h`;
export const pct = (v: unknown): string => `${(Number(v) || 0).toFixed(1)}%`;

export const day = (v: unknown): string => (v ? String(v).slice(0, 10) : '—');

export const dateTime = (v: unknown): string => {
  if (!v) return '—';
  const d = new Date(String(v));
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

export const duration = (ms: unknown): string => {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.floor(n / 60000)}m ${Math.round((n % 60000) / 1000)}s`;
};

export const weekday = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { weekday: 'short' });
};

const escape = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Minimal RFC4180 writer. A BOM keeps Excel happy with UTF-8. */
export function toCsv(headers: string[], rows: unknown[][], { bom = true } = {}): string {
  const lines = [headers.map(escape).join(','), ...rows.map((r) => r.map(escape).join(','))];
  return (bom ? '﻿' : '') + lines.join('\r\n') + '\r\n';
}

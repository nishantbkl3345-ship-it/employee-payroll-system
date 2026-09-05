/** Small, dependency-free date/time helpers. Everything is treated as a wall
 *  clock in the organisation's local time — timesheets are not timezone data. */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SLASH_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/; // DD/MM/YYYY
const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

export function parseDate(input: string): string | null {
  const s = input.trim();
  let y: number, m: number, d: number;

  const iso = DATE_RE.exec(s);
  if (iso) {
    y = +iso[1];
    m = +iso[2];
    d = +iso[3];
  } else {
    const slash = SLASH_DATE_RE.exec(s);
    if (!slash) return null;
    d = +slash[1];
    m = +slash[2];
    y = +slash[3];
  }

  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  // Round-trip through UTC to reject impossible days such as 2025-02-30.
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Minutes since midnight, or null when unparseable. */
export function parseTimeToMinutes(input: string): number | null {
  const m = TIME_RE.exec(input.trim());
  if (!m) return null;
  const h = +m[1];
  const min = +m[2];
  const sec = m[3] ? +m[3] : 0;
  if (h > 23 || min > 59 || sec > 59) return null;
  return h * 60 + min + sec / 60;
}

export function formatMinutes(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function todayISO(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

/** Monday of the ISO week containing `isoDate` (YYYY-MM-DD). */
export function weekStart(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay() || 7; // Sunday(0) -> 7
  dt.setUTCDate(dt.getUTCDate() - (dow - 1));
  return dt.toISOString().slice(0, 10);
}

/** ISO-8601 week label, e.g. "2025-W03". */
export function isoWeek(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dayNum = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum); // Thursday of this week
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((dt.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK_TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Only ISO dates are accepted. Locale formats like 03/04/2025 are ambiguous
 * between day-first and month-first, and silently picking one would shift pay
 * periods, so those are rejected as invalid instead.
 */
export function parseWorkDate(input: string): string | null {
  const match = ISO_DATE.exec(input.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const date = new Date(Date.UTC(year, month - 1, day));
  const roundTrips =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;

  return roundTrips ? input.trim() : null;
}

/** Minutes since midnight, or null when the value is not a valid clock time. */
export function parseClockTime(input: string): number | null {
  const match = CLOCK_TIME.exec(input.trim());
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = match[3] ? Number(match[3]) : 0;
  if (hours > 23 || minutes > 59 || seconds > 59) return null;

  return hours * 60 + minutes + seconds / 60;
}

export function todayIso(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Monday of the ISO week containing `isoDate`. */
export function weekStart(isoDate: string): string {
  const date = utcDate(isoDate);
  const isoDayOfWeek = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - (isoDayOfWeek - 1));
  return date.toISOString().slice(0, 10);
}

/** ISO-8601 week label, e.g. "2025-W03". */
export function isoWeek(isoDate: string): string {
  const date = utcDate(isoDate);
  const isoDayOfWeek = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - isoDayOfWeek);

  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${pad(week)}`;
}

export const roundHours = (hours: number): number => Math.round(hours * 100) / 100;

function utcDate(isoDate: string): Date {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

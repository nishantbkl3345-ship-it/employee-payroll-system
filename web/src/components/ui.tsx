import type { ReactNode } from 'react';

export function Card({
  title,
  subtitle,
  action,
  children,
  className = '',
  bodyClass = 'p-5',
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClass?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-surface-line px-5 py-4">
          <div>
            {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-ink-soft">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

/** A headline figure. The number is the mark — no chart junk around it. */
export function StatTile({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'accent' | 'positive' | 'danger';
}) {
  const toneClass = {
    default: 'text-ink',
    accent: 'text-accent',
    positive: 'text-positive',
    danger: 'text-danger',
  }[tone];
  return (
    <div className="card px-5 py-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">{label}</p>
      <p className={`tnum mt-1.5 text-2xl font-semibold ${toneClass}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-ink-muted">{hint}</p>}
    </div>
  );
}

const BADGE_TONES: Record<string, string> = {
  valid: 'bg-positive/10 text-[#0f7a55] ring-positive/20',
  completed: 'bg-positive/10 text-[#0f7a55] ring-positive/20',
  invalid: 'bg-danger/10 text-[#a92f2e] ring-danger/20',
  failed: 'bg-danger/10 text-[#a92f2e] ring-danger/20',
  duplicate: 'bg-warn/10 text-[#8a5f00] ring-warn/20',
  processing: 'bg-brand-50 text-brand-700 ring-brand-200',
  queued: 'bg-brand-50 text-brand-700 ring-brand-200',
  pending: 'bg-surface-sunken text-ink-soft ring-surface-line',
  neutral: 'bg-surface-sunken text-ink-soft ring-surface-line',
};

export function Badge({ tone = 'neutral', children }: { tone?: string; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
        BADGE_TONES[tone] ?? BADGE_TONES.neutral
      }`}
    >
      {children}
    </span>
  );
}

export function ProgressBar({
  percent,
  label,
  sublabel,
  animated = false,
}: {
  percent: number;
  label?: ReactNode;
  sublabel?: ReactNode;
  animated?: boolean;
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div>
      {(label || sublabel) && (
        <div className="mb-1.5 flex items-baseline justify-between gap-3 text-sm">
          <span className="font-medium text-ink">{label}</span>
          <span className="tnum text-xs text-ink-soft">{sublabel}</span>
        </div>
      )}
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken ring-1 ring-inset ring-surface-line"
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`h-full rounded-full bg-brand-500 transition-[width] duration-500 ease-out ${
            animated ? 'animate-pulse' : ''
          }`}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-90" fill="currentColor" d="M12 2a10 10 0 0 1 10 10h-3a7 7 0 0 0-7-7V2z" />
    </svg>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <p className="text-sm font-semibold text-ink">{title}</p>
      {description && <p className="max-w-sm text-sm text-ink-soft">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-[#a92f2e] ring-1 ring-inset ring-danger/20">
      {children}
    </p>
  );
}

/** Column header that toggles sort direction. */
export function SortHeader({
  label,
  field,
  sort,
  dir,
  onSort,
  align = 'left',
}: {
  label: string;
  field: string;
  sort: string;
  dir: 'asc' | 'desc';
  onSort: (field: string) => void;
  align?: 'left' | 'right';
}) {
  const active = sort === field;
  return (
    <th className={`th ${align === 'right' ? 'text-right' : ''}`}>
      <button
        type="button"
        onClick={() => onSort(field)}
        className={`inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-ink ${
          active ? 'text-ink' : ''
        }`}
        aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        {label}
        <span aria-hidden="true" className={active ? 'opacity-100' : 'opacity-25'}>
          {active && dir === 'asc' ? '▲' : '▼'}
        </span>
      </button>
    </th>
  );
}

/** Placeholder rows that keep a table's height stable while it loads. */
export function TableSkeleton({ rows = 5, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="divide-y divide-surface-line" aria-hidden="true">
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex gap-4 px-4 py-3">
          {Array.from({ length: columns }, (_, column) => (
            <div
              key={column}
              className="h-4 flex-1 animate-pulse rounded bg-surface-sunken"
              style={{ maxWidth: column === 0 ? 'none' : '6rem' }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function Pager({
  page,
  pageSize,
  total,
  onChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;

  return (
    <div className="flex items-center justify-between gap-3 border-t border-surface-line px-4 py-3">
      <span className="text-xs text-ink-soft">
        Page {page + 1} of {pages}
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          className="btn-secondary px-3 py-1.5 text-xs"
          disabled={page === 0}
          onClick={() => onChange(page - 1)}
        >
          Previous
        </button>
        <button
          type="button"
          className="btn-secondary px-3 py-1.5 text-xs"
          disabled={page + 1 >= pages}
          onClick={() => onChange(page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}

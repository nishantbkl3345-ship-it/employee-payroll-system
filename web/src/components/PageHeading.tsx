import type { ReactNode } from 'react';

export function PageHeading({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-ink">{title}</h1>
        {subtitle && <div className="mt-1 text-sm text-ink-soft">{subtitle}</div>}
      </div>
      {action}
    </div>
  );
}

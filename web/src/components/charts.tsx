import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { money, moneyCompact, num } from '../lib/format';

/* Palette slots come from a CVD-validated categorical ordering (blue, orange,
 * aqua). Regular hours/pay are always slot 1; overtime is always slot 2 — the
 * colour follows the measure, never its rank in the current filter. */
const SERIES = {
  regular: '#2a78d6',
  overtime: '#eb6834',
  surface: '#ffffff',
  grid: '#ececE7',
  axis: '#84837c',
};

const AXIS = {
  tick: { fill: SERIES.axis, fontSize: 11 },
  axisLine: false as const,
  tickLine: false as const,
};

function TooltipCard({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ label: string; value: string; color?: string }>;
}) {
  return (
    <div className="rounded-lg border border-surface-line bg-white px-3 py-2 shadow-card">
      <p className="mb-1 text-xs font-semibold text-ink">{title}</p>
      <ul className="space-y-0.5">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center gap-2 text-xs text-ink-soft">
            {r.color && (
              <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: r.color }} aria-hidden />
            )}
            <span>{r.label}</span>
            <span className="tnum ml-auto font-medium text-ink">{r.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChartEmpty({ message }: { message: string }) {
  return (
    <div className="flex h-64 items-center justify-center text-sm text-ink-muted">{message}</div>
  );
}

/* ------------------------------------------------------------------ *
 * Payroll cost by department — one measure across categories, so a
 * single hue. Horizontal bars keep long department names readable.
 * ------------------------------------------------------------------ */
export function DepartmentCostChart({
  data,
}: {
  data: Array<{ department: string; grossPay: number; employees: number }>;
}) {
  if (!data.length) return <ChartEmpty message="No departments in this pay run yet" />;
  const rows = [...data].sort((a, b) => b.grossPay - a.grossPay);
  const height = Math.max(220, rows.length * 44 + 40);

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 72, bottom: 4, left: 8 }}>
          <CartesianGrid horizontal={false} stroke={SERIES.grid} />
          <XAxis type="number" {...AXIS} tickFormatter={(v) => moneyCompact(v)} />
          <YAxis type="category" dataKey="department" width={104} {...AXIS} />
          <Tooltip
            cursor={{ fill: 'rgba(11,11,11,0.04)' }}
            content={({ active, payload }) =>
              active && payload?.length ? (
                <TooltipCard
                  title={payload[0].payload.department}
                  rows={[
                    { label: 'Gross pay', value: money(payload[0].payload.grossPay), color: SERIES.regular },
                    { label: 'Employees', value: num(payload[0].payload.employees) },
                  ]}
                />
              ) : null
            }
          />
          <Bar dataKey="grossPay" radius={[0, 4, 4, 0]} barSize={18} isAnimationActive={false}>
            {rows.map((row) => (
              <Cell key={row.department} fill={SERIES.regular} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      {/* Direct labels: the figures stay legible without hovering. */}
      <ul className="sr-only">
        {rows.map((r) => (
          <li key={r.department}>{`${r.department}: ${money(r.grossPay)}`}</li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Regular vs overtime hours — two series, stacked, with a 2px surface
 * gap between segments so the boundary reads even at small sizes.
 * ------------------------------------------------------------------ */
export function HoursSplitChart({
  data,
}: {
  data: Array<{ department: string; regularHours: number; overtimeHours: number }>;
}) {
  if (!data.length) return <ChartEmpty message="No hours recorded yet" />;
  const rows = [...data].sort(
    (a, b) => b.regularHours + b.overtimeHours - (a.regularHours + a.overtimeHours),
  );
  const height = Math.max(220, rows.length * 44 + 60);

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 8 }}>
          <CartesianGrid horizontal={false} stroke={SERIES.grid} />
          <XAxis type="number" {...AXIS} tickFormatter={(v) => `${num(v)}h`} />
          <YAxis type="category" dataKey="department" width={104} {...AXIS} />
          <Tooltip
            cursor={{ fill: 'rgba(11,11,11,0.04)' }}
            content={({ active, payload }) =>
              active && payload?.length ? (
                <TooltipCard
                  title={payload[0].payload.department}
                  rows={[
                    {
                      label: 'Regular',
                      value: `${num(payload[0].payload.regularHours)}h`,
                      color: SERIES.regular,
                    },
                    {
                      label: 'Overtime',
                      value: `${num(payload[0].payload.overtimeHours)}h`,
                      color: SERIES.overtime,
                    },
                  ]}
                />
              ) : null
            }
          />
          <Legend
            verticalAlign="bottom"
            height={28}
            iconType="square"
            iconSize={9}
            formatter={(value) => <span className="text-xs text-ink-soft">{value}</span>}
          />
          <Bar
            dataKey="regularHours"
            name="Regular hours"
            stackId="hours"
            fill={SERIES.regular}
            stroke={SERIES.surface}
            strokeWidth={2}
            barSize={18}
            isAnimationActive={false}
          />
          <Bar
            dataKey="overtimeHours"
            name="Overtime hours"
            stackId="hours"
            fill={SERIES.overtime}
            stroke={SERIES.surface}
            strokeWidth={2}
            radius={[0, 4, 4, 0]}
            barSize={18}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Week-over-week payroll trend — 2px lines, 8px markers, shared
 * crosshair tooltip. One y-axis only (both series are dollars).
 * ------------------------------------------------------------------ */
export function WeeklyTrendChart({
  data,
}: {
  data: Array<{ isoWeek: string; grossPay: number; overtimePay: number; changePct?: number | null }>;
}) {
  if (data.length < 1) return <ChartEmpty message="No weekly data yet" />;

  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
          <CartesianGrid vertical={false} stroke={SERIES.grid} />
          <XAxis dataKey="isoWeek" {...AXIS} />
          <YAxis {...AXIS} tickFormatter={(v) => moneyCompact(v)} width={56} />
          <Tooltip
            cursor={{ stroke: SERIES.axis, strokeDasharray: '3 3' }}
            content={({ active, payload, label }) =>
              active && payload?.length ? (
                <TooltipCard
                  title={String(label)}
                  rows={[
                    { label: 'Gross pay', value: money(payload[0].payload.grossPay), color: SERIES.regular },
                    {
                      label: 'Overtime pay',
                      value: money(payload[0].payload.overtimePay),
                      color: SERIES.overtime,
                    },
                    ...(payload[0].payload.changePct != null
                      ? [{ label: 'vs previous week', value: `${payload[0].payload.changePct > 0 ? '+' : ''}${payload[0].payload.changePct}%` }]
                      : []),
                  ]}
                />
              ) : null
            }
          />
          <Legend
            verticalAlign="top"
            align="right"
            height={24}
            iconType="plainline"
            iconSize={14}
            formatter={(value) => <span className="text-xs text-ink-soft">{value}</span>}
          />
          <Line
            type="monotone"
            dataKey="grossPay"
            name="Gross pay"
            stroke={SERIES.regular}
            strokeWidth={2}
            dot={{ r: 4, strokeWidth: 2, stroke: SERIES.surface, fill: SERIES.regular }}
            activeDot={{ r: 6, strokeWidth: 2, stroke: SERIES.surface }}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="overtimePay"
            name="Overtime pay"
            stroke={SERIES.overtime}
            strokeWidth={2}
            dot={{ r: 4, strokeWidth: 2, stroke: SERIES.surface, fill: SERIES.overtime }}
            activeDot={{ r: 6, strokeWidth: 2, stroke: SERIES.surface }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/* A compact meter: overtime share of total payroll. Not a pie — one value. */
export function ShareMeter({ label, pct, note }: { label: string; pct: number; note?: string }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-soft">{label}</span>
        <span className="tnum text-lg font-semibold text-ink">{clamped.toFixed(1)}%</span>
      </div>
      <div className="mt-2 flex h-2.5 w-full overflow-hidden rounded-full bg-surface-sunken ring-1 ring-inset ring-surface-line">
        <div style={{ width: `${clamped}%`, background: SERIES.overtime }} />
      </div>
      {note && <p className="mt-1.5 text-xs text-ink-muted">{note}</p>}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { DepartmentCostChart, HoursSplitChart, ShareMeter, WeeklyTrendChart } from '../components/charts';
import {
  Badge,
  Card,
  EmptyState,
  ErrorNote,
  ProgressBar,
  SortHeader,
  Spinner,
  StatTile,
} from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, day, duration, hours, money, num, pct } from '../lib/format';
import { useJobStream } from '../lib/useJobStream';
import { PageHeading } from './Dashboard';

type Tab = 'payroll' | 'rows' | 'metrics' | 'logs';
const TABS: Array<[Tab, string]> = [
  ['payroll', 'Payroll'],
  ['rows', 'Rows & errors'],
  ['metrics', 'Metrics'],
  ['logs', 'Activity log'],
];

const PAGE_SIZE = 25;

export default function JobDetail() {
  const { id = '' } = useParams();
  const { canManage } = useAuth();
  const [tab, setTab] = useState<Tab>('payroll');
  const [job, setJob] = useState<any>(null);
  const [metrics, setMetrics] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const { progress } = useJobStream(id);
  const live = progress[id];

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ job: any; metrics: any }>(`/api/jobs/${id}`);
      setJob(data.job);
      setMetrics(data.metrics);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load job');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Reload once the live stream says the job settled.
  useEffect(() => {
    if (live?.status === 'completed' || live?.status === 'failed') void load();
  }, [live?.status, load]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : `${label} failed`);
    } finally {
      setBusy(null);
    }
  };

  if (error && !job) return <ErrorNote>{error}</ErrorNote>;
  if (!job)
    return (
      <div className="grid h-64 place-items-center text-ink-soft">
        <Spinner className="h-5 w-5" />
      </div>
    );

  const status = live?.status ?? job.status;
  const running = ['pending', 'queued', 'processing'].includes(status);

  return (
    <div className="space-y-6">
      <PageHeading
        title={job.filename}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Badge tone={status}>{status}</Badge>
            <span>{dateTime(job.created_at)}</span>
            {job.uploaded_by_name && <span>· {job.uploaded_by_name}</span>}
            <span className="font-mono text-xs text-ink-muted">{job.correlation_id}</span>
          </span>
        }
        action={
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => api.download(`/api/jobs/${id}/export/annotated.csv`, `annotated-${job.filename}`)}
            >
              Annotated CSV
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => api.download(`/api/jobs/${id}/export/payroll.csv`, `payroll-${job.filename}`)}
              disabled={status !== 'completed'}
            >
              Payroll CSV
            </button>
            {canManage && (
              <>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={!!busy || status !== 'completed'}
                  onClick={() => act('Re-run aggregation', () => api.post(`/api/jobs/${id}/reaggregate`))}
                >
                  {busy === 'Re-run aggregation' && <Spinner />}
                  Re-run aggregation
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={!!busy || running}
                  onClick={() => act('Reprocess', () => api.post(`/api/jobs/${id}/process`))}
                >
                  {busy === 'Reprocess' && <Spinner />}
                  Reprocess file
                </button>
              </>
            )}
          </div>
        }
      />

      {error && <ErrorNote>{error}</ErrorNote>}

      {running && (
        <Card title="Processing" subtitle={live?.stage ?? job.stage}>
          <ProgressBar
            percent={live?.percent ?? (job.total_rows ? (job.processed_rows / job.total_rows) * 100 : 0)}
            label={live?.stage ?? job.stage}
            sublabel={`${num(live?.processedRows ?? job.processed_rows)} / ${num(live?.totalRows ?? job.total_rows)} rows`}
            animated
          />
        </Card>
      )}

      {status === 'failed' && job.error && <ErrorNote>Processing failed: {job.error}</ErrorNote>}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatTile label="Total rows" value={num(job.total_rows)} hint={`${duration(job.duration_ms)} to process`} />
        <StatTile label="Valid" value={num(job.valid_rows)} tone="positive" hint={metrics ? pct(metrics.quality.validPct) : undefined} />
        <StatTile label="Invalid" value={num(job.invalid_rows)} tone="danger" />
        <StatTile label="Duplicates" value={num(job.duplicate_rows)} />
        <StatTile
          label="Gross pay"
          value={metrics ? money(metrics.totals.grossPay) : '—'}
          hint={metrics ? `${num(metrics.totals.employees)} employees` : undefined}
        />
      </div>

      <div className="no-print flex gap-1 overflow-x-auto border-b border-surface-line">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`-mb-px whitespace-nowrap border-b-2 px-3.5 py-2 text-sm font-medium transition-colors ${
              tab === key
                ? 'border-brand-500 text-ink'
                : 'border-transparent text-ink-soft hover:border-surface-line hover:text-ink'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'payroll' && <PayrollTab jobId={id} canManage={canManage} onChanged={load} metrics={metrics} />}
      {tab === 'rows' && <RowsTab jobId={id} />}
      {tab === 'metrics' && <MetricsTab metrics={metrics} job={job} />}
      {tab === 'logs' && <LogsTab jobId={id} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function PayrollTab({
  jobId,
  canManage,
  metrics,
  onChanged,
}: {
  jobId: string;
  canManage: boolean;
  metrics: any;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState('');
  const [department, setDepartment] = useState('all');
  const [sort, setSort] = useState('gross');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [rate, setRate] = useState('');
  const [version, setVersion] = useState(0); // bumped after a rate correction to refetch

  const departments: string[] = useMemo(
    () => (metrics?.byDepartment ?? []).map((d: any) => d.department),
    [metrics],
  );

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({
      sort,
      dir,
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
    });
    if (query) params.set('q', query);
    if (department !== 'all') params.set('department', department);

    const timer = setTimeout(() => {
      api
        .get<{ rows: any[]; total: number }>(`/api/jobs/${jobId}/payroll?${params}`)
        .then((d) => {
          setRows(d.rows);
          setTotal(d.total);
        })
        .finally(() => setLoading(false));
    }, 200); // debounce the search box
    return () => clearTimeout(timer);
  }, [jobId, sort, dir, page, query, department, version]);

  const onSort = (field: string) => {
    if (field === sort) setDir(dir === 'asc' ? 'desc' : 'asc');
    else {
      setSort(field);
      setDir('desc');
    }
    setPage(0);
  };

  const saveRate = async (code: string) => {
    const value = Number(rate);
    if (!Number.isFinite(value) || value <= 0) return;
    await api.patch(`/api/jobs/${jobId}/employees/${encodeURIComponent(code)}/rate`, { hourlyRate: value });
    setEditing(null);
    setRate('');
    setVersion((v) => v + 1);
    onChanged();
  };

  return (
    <Card bodyClass="p-0">
      <div className="flex flex-wrap items-center gap-3 border-b border-surface-line p-4">
        <input
          className="input max-w-xs"
          placeholder="Search employee or ID…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
          aria-label="Search payroll"
        />
        <select
          className="input max-w-[200px]"
          value={department}
          onChange={(e) => {
            setDepartment(e.target.value);
            setPage(0);
          }}
          aria-label="Filter by department"
        >
          <option value="all">All departments</option>
          {departments.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <span className="ml-auto text-xs text-ink-soft">
          {loading ? 'Loading…' : `${num(total)} employee${total === 1 ? '' : 's'}`}
        </span>
      </div>

      {rows.length === 0 && !loading ? (
        <EmptyState title="No payroll lines" description="Nothing matched this filter, or the job has no valid rows." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-surface-line bg-surface-sunken">
              <tr>
                <SortHeader label="Employee" field="employee" sort={sort} dir={dir} onSort={onSort} />
                <SortHeader label="Department" field="department" sort={sort} dir={dir} onSort={onSort} />
                <SortHeader label="Days" field="days" sort={sort} dir={dir} onSort={onSort} align="right" />
                <SortHeader label="Regular" field="regular" sort={sort} dir={dir} onSort={onSort} align="right" />
                <SortHeader label="Overtime" field="overtime" sort={sort} dir={dir} onSort={onSort} align="right" />
                <SortHeader label="Rate" field="rate" sort={sort} dir={dir} onSort={onSort} align="right" />
                <SortHeader label="Gross pay" field="gross" sort={sort} dir={dir} onSort={onSort} align="right" />
                {canManage && <th className="th" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-line">
              {rows.map((row) => (
                <tr key={row.employee_code} className="hover:bg-surface-sunken/60">
                  <td className="td">
                    <Link
                      to={`/employees/${encodeURIComponent(row.employee_code)}?jobId=${jobId}`}
                      className="font-medium text-brand-600 hover:text-brand-700"
                    >
                      {row.employee_name}
                    </Link>
                    <span className="ml-2 text-xs text-ink-muted">{row.employee_code}</span>
                  </td>
                  <td className="td text-ink-soft">{row.department}</td>
                  <td className="td tnum text-right">{num(row.days_worked)}</td>
                  <td className="td tnum text-right">{hours(row.regular_hours)}</td>
                  <td className="td tnum text-right">
                    {row.overtime_hours > 0 ? (
                      <span className="font-medium text-accent">{hours(row.overtime_hours)}</span>
                    ) : (
                      <span className="text-ink-muted">—</span>
                    )}
                  </td>
                  <td className="td tnum text-right">
                    {editing === row.employee_code ? (
                      <input
                        className="input w-24 py-1 text-right"
                        type="number"
                        min={0.01}
                        step={0.5}
                        autoFocus
                        value={rate}
                        onChange={(e) => setRate(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void saveRate(row.employee_code);
                          if (e.key === 'Escape') setEditing(null);
                        }}
                      />
                    ) : (
                      money(row.hourly_rate)
                    )}
                  </td>
                  <td className="td tnum text-right font-semibold">{money(row.gross_pay)}</td>
                  {canManage && (
                    <td className="td text-right">
                      {editing === row.employee_code ? (
                        <span className="flex justify-end gap-1">
                          <button type="button" className="btn-primary px-2 py-1 text-xs" onClick={() => void saveRate(row.employee_code)}>
                            Save
                          </button>
                          <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setEditing(null)}>
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="btn-ghost px-2 py-1 text-xs"
                          onClick={() => {
                            setEditing(row.employee_code);
                            setRate(String(row.hourly_rate));
                          }}
                          title="Correct this rate and re-run payroll"
                        >
                          Fix rate
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pager page={page} pageSize={PAGE_SIZE} total={total} onChange={setPage} />
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function RowsTab({ jobId }: { jobId: string }) {
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState('all');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
    if (status !== 'all') params.set('status', status);
    if (query) params.set('q', query);
    const timer = setTimeout(() => {
      api
        .get<{ rows: any[]; total: number }>(`/api/jobs/${jobId}/rows?${params}`)
        .then((d) => {
          setRows(d.rows);
          setTotal(d.total);
        })
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(timer);
  }, [jobId, status, query, page]);

  const parseErrors = (value: any) => (Array.isArray(value) ? value : JSON.parse(value ?? '[]'));

  return (
    <Card bodyClass="p-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-surface-line p-4">
        {['all', 'valid', 'invalid', 'duplicate'].map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              setStatus(s);
              setPage(0);
            }}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
              status === s ? 'bg-brand-50 text-brand-700' : 'text-ink-soft hover:bg-surface-sunken'
            }`}
          >
            {s}
          </button>
        ))}
        <input
          className="input ml-auto max-w-xs"
          placeholder="Search employee, ID or department…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
          aria-label="Search rows"
        />
      </div>

      {rows.length === 0 && !loading ? (
        <EmptyState title="No rows" description="Nothing matched this filter." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-surface-line bg-surface-sunken">
              <tr>
                <th className="th">#</th>
                <th className="th">Employee</th>
                <th className="th">Date</th>
                <th className="th">Shift</th>
                <th className="th text-right">Hours</th>
                <th className="th text-right">Reg / OT</th>
                <th className="th text-right">Gross</th>
                <th className="th">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-line">
              {rows.map((row) => {
                const errors = parseErrors(row.errors);
                return (
                  <tr key={row.row_number} className="align-top hover:bg-surface-sunken/60">
                    <td className="td tnum text-ink-muted">{row.row_number}</td>
                    <td className="td">
                      <span className="font-medium">{row.employee_name || '—'}</span>
                      <span className="ml-2 text-xs text-ink-muted">{row.employee_code}</span>
                      <p className="text-xs text-ink-muted">{row.department}</p>
                    </td>
                    <td className="td text-ink-soft">{day(row.work_date)}</td>
                    <td className="td tnum text-ink-soft">
                      {row.clock_in ?? '—'} → {row.clock_out ?? '—'}
                    </td>
                    <td className="td tnum text-right">{row.status === 'valid' ? hours(row.hours_worked) : '—'}</td>
                    <td className="td tnum text-right text-ink-soft">
                      {row.status === 'valid' ? `${num(row.regular_hours)} / ${num(row.overtime_hours)}` : '—'}
                    </td>
                    <td className="td tnum text-right">{row.status === 'valid' ? money(row.gross_pay) : '—'}</td>
                    <td className="td">
                      <Badge tone={row.status}>{row.status}</Badge>
                      {errors.length > 0 && (
                        <ul className="mt-1.5 space-y-1">
                          {errors.map((e: any, i: number) => (
                            <li key={i} className="max-w-xs whitespace-normal text-xs text-ink-soft">
                              <span className="font-mono text-[11px] font-medium text-[#a92f2e]">{e.code}</span>{' '}
                              {e.message}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Pager page={page} pageSize={PAGE_SIZE} total={total} onChange={setPage} />
    </Card>
  );
}

/* ------------------------------------------------------------------ */

function MetricsTab({ metrics, job }: { metrics: any; job: any }) {
  if (!metrics)
    return (
      <Card>
        <EmptyState title="No metrics yet" description="Metrics appear once the job finishes processing." />
      </Card>
    );

  const t = metrics.totals;
  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Payroll cost by department">
          <DepartmentCostChart data={metrics.byDepartment} />
        </Card>
        <Card title="Regular vs overtime hours">
          <HoursSplitChart data={metrics.byDepartment} />
        </Card>
      </div>

      <Card title="Weekly payroll trend" subtitle="Within this pay run">
        <WeeklyTrendChart data={metrics.weekly} />
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Totals">
          <dl className="space-y-2.5 text-sm">
            <Line label="Gross pay" value={money(t.grossPay)} />
            <Line label="Regular pay" value={money(t.regularPay)} />
            <Line label="Overtime pay" value={money(t.overtimePay)} />
            <Line label="Regular hours" value={hours(t.regularHours)} />
            <Line label="Overtime hours" value={hours(t.overtimeHours)} />
            <Line label="Avg hours / employee" value={hours(t.avgHoursPerEmployee)} />
            <Line label="σ hours per employee" value={hours(t.stddevEmployeeHours)} />
            <Line label="σ shift length" value={hours(t.stddevShiftHours)} />
          </dl>
        </Card>

        <Card title="Overtime share">
          <ShareMeter label="Of total payroll" pct={t.overtimePctOfPayroll} note={`${pct(t.overtimeHoursPct)} of hours`} />
          <div className="mt-6">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-soft">Rules applied</p>
            <dl className="space-y-2 text-sm">
              <Line label="Daily threshold" value={`${num(metrics.rules.dailyThreshold)}h`} />
              <Line label="Weekly threshold" value={`${num(metrics.rules.weeklyThreshold)}h`} />
              <Line label="Multiplier" value={`${num(metrics.rules.multiplier)}×`} />
            </dl>
          </div>
        </Card>

        <Card title="Run details">
          <dl className="space-y-2.5 text-sm">
            <Line label="Pay period" value={`${day(job.period_start)} → ${day(job.period_end)}`} />
            <Line label="Rows" value={num(job.total_rows)} />
            <Line label="Duration" value={duration(job.duration_ms)} />
            <Line label="Avg per row" value={job.avg_row_ms ? `${Number(job.avg_row_ms).toFixed(2)}ms` : '—'} />
            <Line label="Source" value={job.source_format?.toUpperCase() ?? 'CSV'} />
            <Line label="Correlation id" value={job.correlation_id} mono />
          </dl>
        </Card>
      </div>

      <Card title="Error breakdown" subtitle="Validation failures by rule" bodyClass="p-0">
        {metrics.quality.errorBreakdown.length === 0 ? (
          <EmptyState title="No validation errors" description="Every row in this file passed validation." />
        ) : (
          <table className="w-full">
            <thead className="border-b border-surface-line bg-surface-sunken">
              <tr>
                <th className="th">Rule</th>
                <th className="th text-right">Rows affected</th>
                <th className="th text-right">Share of file</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-line">
              {metrics.quality.errorBreakdown.map((e: any) => (
                <tr key={e.code}>
                  <td className="td font-mono text-xs">{e.code}</td>
                  <td className="td tnum text-right">{num(e.count)}</td>
                  <td className="td tnum text-right text-ink-soft">
                    {pct((e.count / Math.max(1, metrics.quality.totalRows)) * 100)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function Line({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-soft">{label}</dt>
      <dd className={`font-medium text-ink ${mono ? 'font-mono text-xs' : 'tnum'}`}>{value}</dd>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function LogsTab({ jobId }: { jobId: string }) {
  const [logs, setLogs] = useState<any[]>([]);
  const [correlationId, setCorrelationId] = useState('');
  const { events } = useJobStream(jobId);

  useEffect(() => {
    api
      .get<{ logs: any[]; correlationId: string }>(`/api/jobs/${jobId}/logs`)
      .then((d) => {
        setLogs(d.logs);
        setCorrelationId(d.correlationId);
      })
      .catch(() => setLogs([]));
  }, [jobId, events.length]);

  const tone: Record<string, string> = {
    info: 'text-ink-soft',
    warn: 'text-[#8a5f00]',
    error: 'text-[#a92f2e]',
    debug: 'text-ink-muted',
  };

  return (
    <Card
      title="Activity log"
      subtitle={
        <>
          Structured events for correlation id <span className="font-mono">{correlationId}</span>
        </>
      }
      bodyClass="p-0"
    >
      {logs.length === 0 ? (
        <EmptyState title="No events yet" />
      ) : (
        <ol className="divide-y divide-surface-line">
          {logs.map((log) => (
            <li key={log.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-3 text-sm">
              <span className="tnum w-40 shrink-0 text-xs text-ink-muted">{dateTime(log.created_at)}</span>
              <span className={`w-12 shrink-0 text-xs font-semibold uppercase ${tone[log.level] ?? ''}`}>
                {log.level}
              </span>
              <span className="w-48 shrink-0 font-mono text-xs text-brand-600">{log.event}</span>
              <span className="min-w-0 flex-1 text-ink">{log.message}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function Pager({
  page,
  pageSize,
  total,
  onChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-between gap-3 border-t border-surface-line px-4 py-3">
      <span className="text-xs text-ink-soft">
        Page {page + 1} of {pages}
      </span>
      <div className="flex gap-2">
        <button type="button" className="btn-secondary px-3 py-1.5 text-xs" disabled={page === 0} onClick={() => onChange(page - 1)}>
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

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { DepartmentCostChart, HoursSplitChart, ShareMeter, WeeklyTrendChart } from '../components/charts';
import { PageHeading } from '../components/PageHeading';
import { Badge, Card, EmptyState, ErrorNote, ProgressBar, Spinner, StatTile } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { day, duration, hours, money, num, pct } from '../lib/format';
import { useJobStream } from '../lib/useJobStream';

interface Overview {
  latestJob: any | null;
  metrics: any | null;
  organizationTrend: any[];
  jobStats: { total_jobs: number; completed_jobs: number; failed_jobs: number; rows_ingested: number };
  activeJobs: any[];
}

export default function Dashboard() {
  const { canManage, user } = useAuth();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { progress } = useJobStream();

  const load = useCallback(() => {
    api
      .get<Overview>('/api/reports/overview')
      .then(setData)
      .catch((caught) => setError(caught.message));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Reload once a job that was still running reports completion.
  const activeJobIds = (data?.activeJobs ?? []).map((job) => job.id).join(',');
  useEffect(() => {
    const finished = activeJobIds
      .split(',')
      .filter(Boolean)
      .some((jobId) => progress[jobId]?.status === 'completed');
    if (finished) load();
  }, [progress, activeJobIds, load]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data)
    return (
      <div className="grid h-64 place-items-center text-ink-soft">
        <Spinner className="h-5 w-5" />
      </div>
    );

  const m = data.metrics;
  const active = data.activeJobs ?? [];

  if (!m) {
    return (
      <div className="space-y-6">
        <PageHeading title={`Welcome, ${user?.name?.split(' ')[0] ?? 'there'}`} subtitle="No payroll has been processed yet." />
        {active.length > 0 && <ActiveJobs jobs={active} progress={progress} />}
        <Card>
          <EmptyState
            title="No pay runs yet"
            description={
              canManage
                ? 'Upload a timesheet CSV or JSON file to validate the rows, compute payroll and populate this dashboard.'
                : 'Your HR team has not processed a payroll file yet. Your payslip will appear here once they do.'
            }
            action={
              canManage ? (
                <Link to="/upload" className="btn-primary">
                  Upload a timesheet
                </Link>
              ) : undefined
            }
          />
        </Card>
      </div>
    );
  }

  const t = m.totals;

  return (
    <div className="space-y-6">
      <PageHeading
        title="Payroll overview"
        subtitle={
          data.latestJob
            ? `Latest pay run — ${data.latestJob.filename} · ${day(data.latestJob.periodStart)} to ${day(
                data.latestJob.periodEnd,
              )}`
            : undefined
        }
        action={
          data.latestJob && (
            <Link to={`/jobs/${data.latestJob.id}`} className="btn-secondary">
              Open pay run
            </Link>
          )
        }
      />

      {active.length > 0 && <ActiveJobs jobs={active} progress={progress} />}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Total payroll cost" value={money(t.grossPay)} hint={`${num(t.employees)} employees paid`} />
        <StatTile
          label="Overtime cost"
          value={money(t.overtimePay)}
          hint={`${pct(t.overtimePctOfPayroll)} of total payroll`}
          tone="accent"
        />
        <StatTile
          label="Hours worked"
          value={hours(t.totalHours)}
          hint={`${hours(t.regularHours)} regular · ${hours(t.overtimeHours)} overtime`}
        />
        <StatTile
          label="Avg hours / employee"
          value={hours(t.avgHoursPerEmployee)}
          hint={`σ ${num(t.stddevEmployeeHours)}h across employees`}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Payroll cost by department" subtitle="Gross pay for the latest completed pay run">
          <DepartmentCostChart data={m.byDepartment} />
        </Card>

        <Card title="Regular vs overtime hours" subtitle="Hours split per department">
          <HoursSplitChart data={m.byDepartment} />
        </Card>
      </div>

      <Card
        title="Weekly payroll trend"
        subtitle="Gross and overtime pay per ISO week across every completed pay run"
      >
        {data.organizationTrend.length ? (
          <WeeklyTrendChart
            data={data.organizationTrend.map((w: any) => ({
              isoWeek: w.iso_week,
              grossPay: Number(w.gross_pay),
              overtimePay: Number(w.overtime_pay),
            }))}
          />
        ) : (
          <WeeklyTrendChart data={m.weekly} />
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Top 5 employees by overtime" className="lg:col-span-2" bodyClass="p-0">
          {m.topOvertime.length === 0 ? (
            <EmptyState title="No overtime recorded" description="Every shift stayed inside the configured thresholds." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-surface-line bg-surface-sunken">
                  <tr>
                    <th className="th">Employee</th>
                    <th className="th">Department</th>
                    <th className="th text-right">Overtime</th>
                    <th className="th text-right">Overtime pay</th>
                    <th className="th text-right">Share of hours</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-line">
                  {m.topOvertime.map((row: any) => (
                    <tr key={row.employeeCode} className="hover:bg-surface-sunken/60">
                      <td className="td">
                        <Link to={`/employees/${row.employeeCode}`} className="font-medium text-brand-600 hover:text-brand-700">
                          {row.employeeName}
                        </Link>
                        <span className="ml-2 text-xs text-ink-muted">{row.employeeCode}</span>
                      </td>
                      <td className="td text-ink-soft">{row.department}</td>
                      <td className="td tnum text-right font-medium">{hours(row.overtimeHours)}</td>
                      <td className="td tnum text-right">{money(row.overtimePay)}</td>
                      <td className="td tnum text-right text-ink-soft">
                        {pct(row.totalHours ? (row.overtimeHours / row.totalHours) * 100 : 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="space-y-6">
          <Card title="Overtime share">
            <ShareMeter
              label="Overtime cost"
              pct={t.overtimePctOfPayroll}
              note={`${pct(t.overtimeHoursPct)} of all hours worked were overtime.`}
            />
            <div className="mt-5 space-y-3 border-t border-surface-line pt-4 text-sm">
              <Row label="Avg shift length" value={hours(t.avgShiftHours)} />
              <Row label="Shift length σ" value={hours(t.stddevShiftHours)} hint="higher = more irregular scheduling" />
              <Row label="Days worked" value={num(t.daysWorked)} />
            </div>
          </Card>

          <Card title="Data quality" subtitle={`${num(m.quality.totalRows)} rows ingested`}>
            <div className="space-y-3">
              <ProgressBar
                percent={m.quality.validPct}
                label="Valid rows"
                sublabel={`${num(m.quality.validRows)} / ${num(m.quality.totalRows)}`}
              />
              <div className="flex flex-wrap gap-2 pt-1">
                <Badge tone="invalid">{num(m.quality.invalidRows)} invalid</Badge>
                <Badge tone="duplicate">{num(m.quality.duplicateRows)} duplicates</Badge>
              </div>
              {m.quality.errorBreakdown.length > 0 && (
                <ul className="space-y-1 border-t border-surface-line pt-3 text-xs">
                  {m.quality.errorBreakdown.slice(0, 5).map((e: any) => (
                    <li key={e.code} className="flex justify-between gap-3">
                      <span className="font-mono text-ink-soft">{e.code}</span>
                      <span className="tnum font-medium text-ink">{num(e.count)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        </div>
      </div>

      {m.irregularSchedules?.length > 0 && (
        <Card
          title="Irregular scheduling"
          subtitle="Highest standard deviation of shift length — worth a look from a scheduling perspective"
          bodyClass="p-0"
        >
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-surface-line bg-surface-sunken">
                <tr>
                  <th className="th">Employee</th>
                  <th className="th">Department</th>
                  <th className="th text-right">Shifts</th>
                  <th className="th text-right">Avg shift</th>
                  <th className="th text-right">σ shift length</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-line">
                {m.irregularSchedules.map((row: any) => (
                  <tr key={row.employeeCode} className="hover:bg-surface-sunken/60">
                    <td className="td">
                      <Link to={`/employees/${row.employeeCode}`} className="font-medium text-brand-600 hover:text-brand-700">
                        {row.employeeName}
                      </Link>
                    </td>
                    <td className="td text-ink-soft">{row.department}</td>
                    <td className="td tnum text-right">{num(row.shifts)}</td>
                    <td className="td tnum text-right">{hours(row.avgShiftHours)}</td>
                    <td className="td tnum text-right font-medium">{hours(row.stddevShiftHours)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile label="Pay runs processed" value={num(data.jobStats.completed_jobs)} hint={`${num(data.jobStats.total_jobs)} total`} />
        <StatTile label="Rows ingested" value={num(data.jobStats.rows_ingested)} />
        <StatTile
          label="Last run duration"
          value={duration(data.latestJob?.durationMs)}
          hint={data.latestJob ? `${num(data.latestJob.totalRows)} rows` : undefined}
        />
      </div>
    </div>
  );
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-ink-soft">
        {label}
        {hint && <span className="ml-1 text-xs text-ink-muted">({hint})</span>}
      </span>
      <span className="tnum font-medium text-ink">{value}</span>
    </div>
  );
}

function ActiveJobs({ jobs, progress }: { jobs: any[]; progress: Record<string, any> }) {
  return (
    <Card title="Processing now" subtitle="Live progress from the worker pool">
      <div className="space-y-4">
        {jobs.map((job) => {
          const p = progress[job.id] ?? {};
          const processed = p.processedRows ?? job.processed_rows ?? 0;
          const total = p.totalRows ?? job.total_rows ?? 0;
          const percent = p.percent ?? (total ? (processed / total) * 100 : 0);
          return (
            <div key={job.id}>
              <ProgressBar
                percent={percent}
                label={
                  <Link to={`/jobs/${job.id}`} className="hover:text-brand-600">
                    {job.filename}
                  </Link>
                }
                sublabel={`${p.stage ?? job.stage} · ${num(processed)} / ${num(total)} rows`}
                animated
              />
            </div>
          );
        })}
      </div>
    </Card>
  );
}

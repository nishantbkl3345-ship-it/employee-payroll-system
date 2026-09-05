import type { ReactNode } from 'react';
import { DepartmentCostChart, HoursSplitChart, ShareMeter, WeeklyTrendChart } from '../../components/charts';
import { Card, EmptyState } from '../../components/ui';
import { day, duration, hours, money, num, pct } from '../../lib/format';

export default function MetricsTab({ metrics, job }: { metrics: any; job: any }) {
  if (!metrics) {
    return (
      <Card>
        <EmptyState title="No metrics yet" description="Metrics appear once the pay run finishes." />
      </Card>
    );
  }

  const totals = metrics.totals;

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
            <Figure label="Gross pay" value={money(totals.grossPay)} />
            <Figure label="Regular pay" value={money(totals.regularPay)} />
            <Figure label="Overtime pay" value={money(totals.overtimePay)} />
            <Figure label="Regular hours" value={hours(totals.regularHours)} />
            <Figure label="Overtime hours" value={hours(totals.overtimeHours)} />
            <Figure label="Avg hours / employee" value={hours(totals.avgHoursPerEmployee)} />
            <Figure label="σ hours per employee" value={hours(totals.stddevEmployeeHours)} />
            <Figure label="σ shift length" value={hours(totals.stddevShiftHours)} />
          </dl>
        </Card>

        <Card title="Overtime share">
          <ShareMeter
            label="Of total payroll"
            pct={totals.overtimePctOfPayroll}
            note={`${pct(totals.overtimeHoursPct)} of hours worked`}
          />
          <div className="mt-6">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-soft">Rules applied</p>
            <dl className="space-y-2 text-sm">
              <Figure label="Daily threshold" value={`${num(metrics.rules.dailyThreshold)}h`} />
              <Figure label="Weekly threshold" value={`${num(metrics.rules.weeklyThreshold)}h`} />
              <Figure label="Multiplier" value={`${num(metrics.rules.multiplier)}×`} />
            </dl>
          </div>
        </Card>

        <Card title="Run details">
          <dl className="space-y-2.5 text-sm">
            <Figure label="Pay period" value={`${day(job.period_start)} → ${day(job.period_end)}`} />
            <Figure label="Rows" value={num(job.total_rows)} />
            <Figure label="Duration" value={duration(job.duration_ms)} />
            <Figure
              label="Avg per row"
              value={job.avg_row_ms ? `${Number(job.avg_row_ms).toFixed(2)}ms` : '—'}
            />
            <Figure label="Rows retried" value={num(job.retried_rows)} />
            <Figure label="Source" value={(job.source_format ?? 'csv').toUpperCase()} />
          </dl>
        </Card>
      </div>

      <Card title="Error breakdown" subtitle="Validation failures by rule" bodyClass="p-0">
        {metrics.quality.errorBreakdown.length === 0 ? (
          <EmptyState title="No validation errors" description="Every row in this file passed validation." />
        ) : (
          <table className="w-full">
            <caption className="sr-only">Validation failures by rule</caption>
            <thead className="border-b border-surface-line bg-surface-sunken">
              <tr>
                <th className="th">Rule</th>
                <th className="th text-right">Rows affected</th>
                <th className="th text-right">Share of file</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-line">
              {metrics.quality.errorBreakdown.map((entry: { code: string; count: number }) => (
                <tr key={entry.code}>
                  <td className="td font-mono text-xs">{entry.code}</td>
                  <td className="td tnum text-right">{num(entry.count)}</td>
                  <td className="td tnum text-right text-ink-soft">
                    {pct((entry.count / Math.max(1, metrics.quality.totalRows)) * 100)}
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

function Figure({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="tnum font-medium text-ink">{value}</dd>
    </div>
  );
}

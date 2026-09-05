import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { PageHeading } from '../components/PageHeading';
import { Badge, Card, EmptyState, ErrorNote, Spinner, StatTile } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { day, hours, money, num, weekday } from '../lib/format';

interface Detail {
  job: any;
  summary: any | null;
  days: any[];
  weeks: any[];
}

export default function EmployeeDetail() {
  const { code = '' } = useParams();
  const [params] = useSearchParams();
  const jobId = params.get('jobId');
  const { organization } = useAuth();

  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const qs = jobId ? `?jobId=${jobId}` : '';
    api
      .get<Detail>(`/api/employees/${encodeURIComponent(code)}/timesheet${qs}`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [code, jobId]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data)
    return (
      <div className="grid h-64 place-items-center text-ink-soft">
        <Spinner className="h-5 w-5" />
      </div>
    );

  const s = data.summary;
  const parseErrors = (v: any) => (Array.isArray(v) ? v : JSON.parse(v ?? '[]'));

  return (
    <div className="space-y-6">
      <PageHeading
        title={s?.employee_name ?? code}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3">
            <span>{code}</span>
            {s?.department && <span>· {s.department}</span>}
            <span>
              · Pay period {day(data.job.period_start)} → {day(data.job.period_end)}
            </span>
          </span>
        }
        action={
          <div className="no-print flex gap-2">
            <button type="button" className="btn-secondary" onClick={() => window.print()}>
              Print / Save PDF
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() =>
                api.download(
                  `/api/employees/${encodeURIComponent(code)}/payslip.csv?jobId=${data.job.id}`,
                  `payslip-${code}.csv`,
                )
              }
            >
              Download payslip
            </button>
          </div>
        }
      />

      {!s ? (
        <Card>
          <EmptyState
            title="No payroll line for this pay period"
            description="This employee has rows in the file, but none of them passed validation."
          />
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile label="Gross pay" value={money(s.gross_pay)} hint={`${num(s.days_worked)} days worked`} />
            <StatTile label="Regular" value={hours(s.regular_hours)} hint={money(s.regular_pay)} />
            <StatTile label="Overtime" value={hours(s.overtime_hours)} hint={money(s.overtime_pay)} tone="accent" />
            <StatTile label="Hourly rate" value={money(s.hourly_rate)} hint={`avg ${hours(s.avg_daily_hours)} / day`} />
          </div>

          {/* Payslip-style summary — prints cleanly via the browser. */}
          <Card title="Payslip" subtitle={`${organization?.name ?? ''} · source file ${data.job.filename}`}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-line">
                  <th className="th px-0">Earnings</th>
                  <th className="th px-0 text-right">Hours</th>
                  <th className="th px-0 text-right">Rate</th>
                  <th className="th px-0 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-line">
                <tr>
                  <td className="td px-0">Regular</td>
                  <td className="td tnum px-0 text-right">{num(s.regular_hours)}</td>
                  <td className="td tnum px-0 text-right">{money(s.hourly_rate)}</td>
                  <td className="td tnum px-0 text-right">{money(s.regular_pay)}</td>
                </tr>
                <tr>
                  <td className="td px-0">Overtime</td>
                  <td className="td tnum px-0 text-right">{num(s.overtime_hours)}</td>
                  <td className="td tnum px-0 text-right text-ink-soft">
                    {money(s.hourly_rate)} × {num(data.job.rules?.multiplier ?? organization?.ot_multiplier ?? 1.5)}
                  </td>
                  <td className="td tnum px-0 text-right">{money(s.overtime_pay)}</td>
                </tr>
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-ink/10">
                  <td className="td px-0 font-semibold">Gross pay</td>
                  <td className="td tnum px-0 text-right font-semibold">{num(s.total_hours)}</td>
                  <td className="td px-0" />
                  <td className="td tnum px-0 text-right text-base font-semibold">{money(s.gross_pay)}</td>
                </tr>
              </tfoot>
            </table>
          </Card>
        </>
      )}

      {data.weeks.length > 0 && (
        <Card title="Weekly summary" bodyClass="p-0">
          <table className="w-full">
            <thead className="border-b border-surface-line bg-surface-sunken">
              <tr>
                <th className="th">ISO week</th>
                <th className="th text-right">Regular</th>
                <th className="th text-right">Overtime</th>
                <th className="th text-right">Gross pay</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-line">
              {data.weeks.map((w: any) => (
                <tr key={w.iso_week}>
                  <td className="td font-medium">{w.iso_week}</td>
                  <td className="td tnum text-right">{hours(w.regular_hours)}</td>
                  <td className="td tnum text-right text-accent">{hours(w.overtime_hours)}</td>
                  <td className="td tnum text-right font-medium">{money(w.gross_pay)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card title="Day-by-day breakdown" subtitle={`${num(data.days.length)} rows in this pay run`} bodyClass="p-0">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-surface-line bg-surface-sunken">
              <tr>
                <th className="th">Date</th>
                <th className="th">Shift</th>
                <th className="th text-right">Hours</th>
                <th className="th text-right">Regular</th>
                <th className="th text-right">Overtime</th>
                <th className="th text-right">Rate</th>
                <th className="th text-right">Pay</th>
                <th className="th">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-line">
              {data.days.map((row: any) => {
                const errors = parseErrors(row.errors);
                return (
                  <tr key={row.row_number} className="align-top hover:bg-surface-sunken/60">
                    <td className="td">
                      <span className="font-medium">{day(row.work_date)}</span>
                      <span className="ml-2 text-xs text-ink-muted">
                        {row.work_date ? weekday(String(row.work_date).slice(0, 10)) : ''}
                      </span>
                    </td>
                    <td className="td tnum text-ink-soft">
                      {row.clock_in ?? '—'} → {row.clock_out ?? '—'}
                    </td>
                    <td className="td tnum text-right">{row.status === 'valid' ? num(row.hours_worked) : '—'}</td>
                    <td className="td tnum text-right">{row.status === 'valid' ? num(row.regular_hours) : '—'}</td>
                    <td className="td tnum text-right">
                      {row.status === 'valid' && row.overtime_hours > 0 ? (
                        <span className="font-medium text-accent">{num(row.overtime_hours)}</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="td tnum text-right text-ink-soft">{row.hourly_rate ? money(row.hourly_rate) : '—'}</td>
                    <td className="td tnum text-right font-medium">{row.status === 'valid' ? money(row.gross_pay) : '—'}</td>
                    <td className="td">
                      <Badge tone={row.status}>{row.status}</Badge>
                      {errors.length > 0 && (
                        <ul className="mt-1 space-y-0.5">
                          {errors.map((e: any, i: number) => (
                            <li key={i} className="max-w-xs whitespace-normal text-xs text-ink-soft">
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
      </Card>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeading } from '../components/PageHeading';
import { Badge, Card, EmptyState, ErrorNote, ProgressBar, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, day, duration, money, num } from '../lib/format';
import { useJobStream } from '../lib/useJobStream';

export default function Jobs() {
  const { canManage } = useAuth();
  const [jobs, setJobs] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { progress } = useJobStream();

  const load = () =>
    api
      .get<{ jobs: any[] }>('/api/jobs?limit=50')
      .then((d) => setJobs(d.jobs))
      .catch((e) => setError(e.message));

  useEffect(() => {
    void load();
  }, []);

  // Refresh the list when a running job reports completion.
  useEffect(() => {
    const finished = Object.values(progress).some(
      (p: any) => p.status === 'completed' || p.status === 'failed',
    );
    if (finished) void load();
  }, [progress]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!jobs)
    return (
      <div className="grid h-64 place-items-center text-ink-soft">
        <Spinner className="h-5 w-5" />
      </div>
    );

  return (
    <div className="space-y-6">
      <PageHeading
        title="Pay runs"
        subtitle="Every uploaded timesheet file and the payroll computed from it."
        action={
          canManage && (
            <Link to="/upload" className="btn-primary">
              Upload timesheet
            </Link>
          )
        }
      />

      {jobs.length === 0 ? (
        <Card>
          <EmptyState
            title="No pay runs yet"
            description="Uploaded files appear here with their validation summary and payroll totals."
            action={canManage ? <Link to="/upload" className="btn-primary">Upload a timesheet</Link> : undefined}
          />
        </Card>
      ) : (
        <Card bodyClass="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-surface-line bg-surface-sunken">
                <tr>
                  <th className="th">File</th>
                  <th className="th">Status</th>
                  <th className="th">Pay period</th>
                  <th className="th text-right">Rows</th>
                  <th className="th text-right">Valid</th>
                  <th className="th text-right">Invalid</th>
                  <th className="th text-right">Dupes</th>
                  <th className="th text-right">Gross pay</th>
                  <th className="th text-right">Duration</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-line">
                {jobs.map((job) => {
                  const p = progress[job.id];
                  const status = p?.status ?? job.status;
                  const running = ['pending', 'queued', 'processing'].includes(status);
                  const processed = p?.processedRows ?? job.processed_rows;
                  return (
                    <tr key={job.id} className="align-top hover:bg-surface-sunken/60">
                      <td className="td">
                        <Link to={`/jobs/${job.id}`} className="font-medium text-brand-600 hover:text-brand-700">
                          {job.filename}
                        </Link>
                        <p className="mt-0.5 text-xs text-ink-muted">
                          {dateTime(job.created_at)}
                          {job.uploaded_by_name ? ` · ${job.uploaded_by_name}` : ''}
                        </p>
                        <p className="mt-0.5 font-mono text-[11px] text-ink-muted">{job.correlation_id}</p>
                      </td>
                      <td className="td">
                        <Badge tone={status}>{status}</Badge>
                        {running && (
                          <div className="mt-2 w-36">
                            <ProgressBar
                              percent={p?.percent ?? (job.total_rows ? (processed / job.total_rows) * 100 : 0)}
                              sublabel={`${num(processed)} / ${num(job.total_rows)}`}
                              animated
                            />
                          </div>
                        )}
                        {status === 'failed' && job.error && (
                          <p className="mt-1 max-w-xs text-xs text-danger">{job.error}</p>
                        )}
                      </td>
                      <td className="td text-ink-soft">
                        {job.period_start ? `${day(job.period_start)} → ${day(job.period_end)}` : '—'}
                      </td>
                      <td className="td tnum text-right">{num(job.total_rows)}</td>
                      <td className="td tnum text-right text-[#0f7a55]">{num(job.valid_rows)}</td>
                      <td className="td tnum text-right text-[#a92f2e]">{num(job.invalid_rows)}</td>
                      <td className="td tnum text-right text-[#8a5f00]">{num(job.duplicate_rows)}</td>
                      <td className="td tnum text-right font-medium">
                        {job.status === 'completed' ? money(job.gross_pay) : '—'}
                      </td>
                      <td className="td tnum text-right text-ink-soft">{duration(job.duration_ms)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

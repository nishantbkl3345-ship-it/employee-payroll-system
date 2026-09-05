import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { PageHeading } from '../components/PageHeading';
import { Badge, Card, ErrorNote, ProgressBar, Spinner, StatTile } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, duration, money, num, pct } from '../lib/format';
import { useJobStream } from '../lib/useJobStream';
import LogsTab from './job/LogsTab';
import MetricsTab from './job/MetricsTab';
import PayrollTab from './job/PayrollTab';
import RowsTab from './job/RowsTab';

type Tab = 'payroll' | 'rows' | 'metrics' | 'logs';

const TABS: Array<[Tab, string]> = [
  ['payroll', 'Payroll'],
  ['rows', 'Rows & errors'],
  ['metrics', 'Metrics'],
  ['logs', 'Activity log'],
];

const RUNNING = ['pending', 'queued', 'processing'];

export default function JobDetail() {
  const { id = '' } = useParams();
  const { canManage } = useAuth();
  const { progress } = useJobStream(id);

  const [tab, setTab] = useState<Tab>('payroll');
  const [job, setJob] = useState<any>(null);
  const [metrics, setMetrics] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    try {
      const result = await api.get<{ job: any; metrics: any }>(`/api/jobs/${id}`);
      setJob(result.job);
      setMetrics(result.metrics);
      setVersion((count) => count + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load this pay run');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const liveStatus = progress[id]?.status;
  useEffect(() => {
    if (liveStatus === 'completed' || liveStatus === 'failed') void load();
  }, [liveStatus, load]);

  const run = async (label: string, action: () => Promise<unknown>) => {
    setPending(label);
    setError(null);
    try {
      await action();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `${label} failed`);
    } finally {
      setPending(null);
    }
  };

  if (error && !job) return <ErrorNote>{error}</ErrorNote>;
  if (!job) {
    return (
      <div className="grid h-64 place-items-center text-ink-soft">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }

  const live = progress[id];
  const status = live?.status ?? job.status;
  const running = RUNNING.includes(status);
  const departments: string[] = (metrics?.byDepartment ?? []).map((d: any) => d.department);

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
              disabled={status !== 'completed'}
              onClick={() => api.download(`/api/jobs/${id}/export/payroll.csv`, `payroll-${job.filename}`)}
            >
              Payroll CSV
            </button>
            {canManage && (
              <>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={!!pending || status !== 'completed'}
                  onClick={() => run('Re-run aggregation', () => api.post(`/api/jobs/${id}/reaggregate`))}
                >
                  {pending === 'Re-run aggregation' && <Spinner />}
                  Re-run aggregation
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={!!pending || running}
                  onClick={() => run('Reprocess', () => api.post(`/api/jobs/${id}/process`))}
                >
                  {pending === 'Reprocess' && <Spinner />}
                  Reprocess file
                </button>
              </>
            )}
          </div>
        }
      />

      {error && <ErrorNote>{error}</ErrorNote>}
      {status === 'failed' && job.error && <ErrorNote>Processing failed: {job.error}</ErrorNote>}

      {running && (
        <Card title="Processing">
          <ProgressBar
            percent={live?.percent ?? (job.total_rows ? (job.processed_rows / job.total_rows) * 100 : 0)}
            label={live?.stage ?? job.stage}
            sublabel={`${num(live?.processedRows ?? job.processed_rows)} / ${num(
              live?.totalRows ?? job.total_rows,
            )} rows`}
            animated
          />
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatTile label="Total rows" value={num(job.total_rows)} hint={`${duration(job.duration_ms)} to process`} />
        <StatTile
          label="Valid"
          value={num(job.valid_rows)}
          tone="positive"
          hint={metrics ? pct(metrics.quality.validPct) : undefined}
        />
        <StatTile label="Invalid" value={num(job.invalid_rows)} tone="danger" />
        <StatTile label="Duplicates" value={num(job.duplicate_rows)} />
        <StatTile
          label="Gross pay"
          value={metrics ? money(metrics.totals.grossPay) : '—'}
          hint={metrics ? `${num(metrics.totals.employees)} employees` : undefined}
        />
      </div>

      <div className="no-print flex gap-1 overflow-x-auto border-b border-surface-line" role="tablist">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
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

      {tab === 'payroll' && (
        <PayrollTab jobId={id} departments={departments} canManage={canManage} onPayrollChanged={load} />
      )}
      {tab === 'rows' && <RowsTab jobId={id} />}
      {tab === 'metrics' && <MetricsTab metrics={metrics} job={job} />}
      {tab === 'logs' && <LogsTab jobId={id} refreshKey={version} />}
    </div>
  );
}

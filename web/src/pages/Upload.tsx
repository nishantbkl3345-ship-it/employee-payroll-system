import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeading } from '../components/PageHeading';
import { Card, ErrorNote, ProgressBar, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { num } from '../lib/format';
import { useJobStream } from '../lib/useJobStream';

const STAGES = [
  ['uploaded', 'Uploaded'],
  ['parsing', 'Parsing file'],
  ['validating', 'Validating rows'],
  ['resolving', 'Duplicates & overlaps'],
  ['overtime', 'Overtime rules'],
  ['persisting', 'Saving results'],
  ['aggregating', 'Computing payroll'],
  ['completed', 'Done'],
] as const;

export default function Upload() {
  const navigate = useNavigate();
  const { organization } = useAuth();
  const inputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [rules, setRules] = useState({
    dailyThreshold: String(organization?.ot_daily_threshold ?? 8),
    weeklyThreshold: String(organization?.ot_weekly_threshold ?? 40),
    multiplier: String(organization?.ot_multiplier ?? 1.5),
  });

  useEffect(() => {
    if (organization) {
      setRules({
        dailyThreshold: String(organization.ot_daily_threshold),
        weeklyThreshold: String(organization.ot_weekly_threshold),
        multiplier: String(organization.ot_multiplier),
      });
    }
  }, [organization]);

  const { progress, live } = useJobStream(jobId ?? undefined);
  const jobProgress = jobId ? progress[jobId] : undefined;

  useEffect(() => {
    if (jobProgress?.status === 'completed' && jobId) {
      const timer = setTimeout(() => navigate(`/jobs/${jobId}`), 900);
      return () => clearTimeout(timer);
    }
  }, [jobProgress?.status, jobId, navigate]);

  const pick = (f: File | null | undefined) => {
    if (!f) return;
    setFile(f);
    setError(null);
    setJobId(null);
    setUploadPct(0);
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    pick(e.dataTransfer.files?.[0]);
  }, []);

  const submit = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        dailyThreshold: rules.dailyThreshold,
        weeklyThreshold: rules.weeklyThreshold,
        multiplier: rules.multiplier,
      });
      const res = await api.upload(`/api/jobs/upload?${params}`, file, setUploadPct);
      setJobId(res.job.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  const currentStage = jobProgress?.stage ?? (jobId ? 'uploaded' : null);
  const stageIndex = STAGES.findIndex(([key]) => key === currentStage);
  const failed = jobProgress?.status === 'failed';

  return (
    <div className="space-y-6">
      <PageHeading
        title="Upload a timesheet"
        subtitle="CSV or JSON with employee_id, employee_name, department, date, clock_in, clock_out, hourly_rate."
      />

      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title="File">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              onClick={() => inputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
              className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
                dragging ? 'border-brand-400 bg-brand-50' : 'border-surface-line hover:border-brand-200 hover:bg-surface-sunken'
              }`}
            >
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="text-ink-muted" aria-hidden="true">
                <path d="M12 16V4m0 0L8 8m4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" strokeLinecap="round" />
              </svg>
              {file ? (
                <>
                  <p className="text-sm font-medium text-ink">{file.name}</p>
                  <p className="text-xs text-ink-muted">{(file.size / 1024).toFixed(1)} KB — click to replace</p>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium text-ink">Drop a timesheet file here</p>
                  <p className="text-xs text-ink-muted">or click to browse — .csv or .json</p>
                </>
              )}
              <input
                ref={inputRef}
                type="file"
                accept=".csv,.json,text/csv,application/json"
                className="hidden"
                onChange={(e) => pick(e.target.files?.[0])}
              />
            </div>

            {busy && uploadPct > 0 && uploadPct < 100 && (
              <div className="mt-4">
                <ProgressBar percent={uploadPct} label="Uploading" sublabel={`${uploadPct}%`} />
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button type="button" className="btn-primary" onClick={submit} disabled={!file || busy || !!jobId}>
                {busy && <Spinner />}
                Upload &amp; process
              </button>
              {file && !jobId && (
                <button type="button" className="btn-ghost" onClick={() => setFile(null)} disabled={busy}>
                  Clear
                </button>
              )}
            </div>
          </Card>

          {jobId && (
            <Card
              title="Processing"
              subtitle={live ? 'Live updates over WebSocket' : 'Polling for updates'}
              action={
                <button type="button" className="btn-secondary" onClick={() => navigate(`/jobs/${jobId}`)}>
                  Open job
                </button>
              }
            >
              <ProgressBar
                percent={failed ? 100 : (jobProgress?.percent ?? 2)}
                label={failed ? 'Failed' : (STAGES[Math.max(0, stageIndex)]?.[1] ?? 'Queued')}
                sublabel={
                  jobProgress?.totalRows
                    ? `${num(jobProgress.processedRows ?? 0)} / ${num(jobProgress.totalRows)} rows`
                    : 'Waiting for the worker'
                }
                animated={!failed && jobProgress?.status !== 'completed'}
              />

              <ol className="mt-5 grid gap-2 sm:grid-cols-2">
                {STAGES.map(([key, label], i) => {
                  const done = stageIndex > i || jobProgress?.status === 'completed';
                  const current = stageIndex === i && jobProgress?.status !== 'completed';
                  return (
                    <li key={key} className="flex items-center gap-2 text-sm">
                      <span
                        className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-bold ${
                          done
                            ? 'bg-positive/15 text-[#0f7a55]'
                            : current
                              ? 'bg-brand-500 text-white'
                              : 'bg-surface-sunken text-ink-muted ring-1 ring-inset ring-surface-line'
                        }`}
                      >
                        {done ? '✓' : i + 1}
                      </span>
                      <span className={done || current ? 'text-ink' : 'text-ink-muted'}>{label}</span>
                    </li>
                  );
                })}
              </ol>

              {failed && <div className="mt-4"><ErrorNote>{jobProgress?.message ?? 'Processing failed'}</ErrorNote></div>}
            </Card>
          )}
        </div>

        <Card title="Overtime rules" subtitle="Applied to this upload only">
          <div className="space-y-4">
            <div>
              <label className="label" htmlFor="daily">
                Daily threshold (hours)
              </label>
              <input
                id="daily"
                type="number"
                min={0}
                max={24}
                step={0.5}
                className="input tnum"
                value={rules.dailyThreshold}
                onChange={(e) => setRules({ ...rules, dailyThreshold: e.target.value })}
              />
              <p className="mt-1 text-xs text-ink-muted">Hours beyond this in one day become overtime.</p>
            </div>
            <div>
              <label className="label" htmlFor="weekly">
                Weekly threshold (hours)
              </label>
              <input
                id="weekly"
                type="number"
                min={0}
                max={168}
                step={1}
                className="input tnum"
                value={rules.weeklyThreshold}
                onChange={(e) => setRules({ ...rules, weeklyThreshold: e.target.value })}
              />
              <p className="mt-1 text-xs text-ink-muted">Regular hours past this in an ISO week are reclassified.</p>
            </div>
            <div>
              <label className="label" htmlFor="multiplier">
                Overtime multiplier
              </label>
              <input
                id="multiplier"
                type="number"
                min={1}
                max={5}
                step={0.1}
                className="input tnum"
                value={rules.multiplier}
                onChange={(e) => setRules({ ...rules, multiplier: e.target.value })}
              />
            </div>

            <div className="rounded-lg bg-surface-sunken p-3 text-xs leading-relaxed text-ink-soft">
              <p className="font-semibold text-ink">What gets checked</p>
              <ul className="mt-1.5 list-inside list-disc space-y-0.5">
                <li>Required fields present</li>
                <li>Valid, non-future dates</li>
                <li>clock_out after clock_in</li>
                <li>Positive hourly rate</li>
                <li>Duplicate rows flagged</li>
                <li>Overlapping shifts rejected</li>
              </ul>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Card, EmptyState } from '../../components/ui';
import { api } from '../../lib/api';
import { dateTime } from '../../lib/format';

interface LogEntry {
  id: number;
  level: 'info' | 'warn' | 'error';
  event: string;
  message: string;
  created_at: string;
}

const LEVEL_STYLES: Record<string, string> = {
  info: 'text-ink-muted',
  warn: 'text-[#8a5f00]',
  error: 'text-[#a92f2e]',
};

export default function LogsTab({ jobId, refreshKey }: { jobId: string; refreshKey: number }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [correlationId, setCorrelationId] = useState('');

  useEffect(() => {
    api
      .get<{ logs: LogEntry[]; correlationId: string }>(`/api/jobs/${jobId}/logs`)
      .then((result) => {
        setLogs(result.logs);
        setCorrelationId(result.correlationId);
      })
      .catch(() => setLogs([]));
  }, [jobId, refreshKey]);

  return (
    <Card
      title="Activity log"
      subtitle={`Events for correlation id ${correlationId}`}
      bodyClass="p-0"
    >
      {logs.length === 0 ? (
        <EmptyState title="No events yet" />
      ) : (
        <ol className="divide-y divide-surface-line">
          {logs.map((log) => (
            <li key={log.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-3 text-sm">
              <span className="tnum w-40 shrink-0 text-xs text-ink-muted">{dateTime(log.created_at)}</span>
              <span className={`w-12 shrink-0 text-xs font-semibold uppercase ${LEVEL_STYLES[log.level] ?? ''}`}>
                {log.level}
              </span>
              <span className="w-52 shrink-0 font-mono text-xs text-brand-600">{log.event}</span>
              <span className="min-w-0 flex-1 text-ink">{log.message}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

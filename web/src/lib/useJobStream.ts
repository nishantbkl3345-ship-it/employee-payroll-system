import { useEffect, useRef, useState } from 'react';
import { api, getToken } from './api';

export interface JobEvent {
  type: 'job.progress' | 'job.status' | 'job.log' | 'connected';
  jobId?: string;
  status?: string;
  stage?: string;
  processedRows?: number;
  totalRows?: number;
  percent?: number;
  message?: string;
  level?: string;
  event?: string;
  at?: string;
}

export interface JobStream {
  /** Latest progress snapshot per job id. */
  progress: Record<string, JobEvent>;
  /** Rolling log tail for the subscribed job. */
  events: JobEvent[];
  /** True while the WebSocket is open; false means the polling fallback is active. */
  live: boolean;
}

const ACTIVE = new Set(['pending', 'queued', 'processing']);

/**
 * Live job updates over a WebSocket, with an automatic polling fallback so the
 * UI keeps working behind proxies that drop upgrades.
 *
 * Pass a jobId to follow one job, or omit it to receive every job in the
 * organisation (used by the jobs list and the dashboard).
 */
export function useJobStream(jobId?: string): JobStream {
  const [progress, setProgress] = useState<Record<string, JobEvent>>({});
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [live, setLive] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const token = getToken();
    if (!token) return;

    let closed = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const record = (event: JobEvent) => {
      if (event.jobId) {
        setProgress((prev) => ({ ...prev, [event.jobId!]: { ...prev[event.jobId!], ...event } }));
      }
      if (event.type === 'job.log' || event.type === 'job.status') {
        setEvents((prev) => [...prev.slice(-99), event]);
      }
    };

    /** Fallback: poll the REST endpoint while any job is still running. */
    const startPolling = () => {
      if (poll) return;
      poll = setInterval(async () => {
        try {
          if (jobId) {
            const { job } = await api.get<{ job: any }>(`/api/jobs/${jobId}`);
            record({
              type: 'job.progress',
              jobId,
              status: job.status,
              stage: job.stage,
              processedRows: job.processed_rows,
              totalRows: job.total_rows,
              percent:
                job.status === 'completed'
                  ? 100
                  : job.total_rows
                    ? Math.round((job.processed_rows / job.total_rows) * 90)
                    : 0,
            });
            if (!ACTIVE.has(job.status) && poll) {
              clearInterval(poll);
              poll = null;
            }
          } else {
            const { jobs } = await api.get<{ jobs: any[] }>('/api/jobs?limit=10');
            for (const job of jobs) {
              record({
                type: 'job.progress',
                jobId: job.id,
                status: job.status,
                stage: job.stage,
                processedRows: job.processed_rows,
                totalRows: job.total_rows,
                percent: job.status === 'completed' ? 100 : undefined,
              });
            }
          }
        } catch {
          /* transient — the next tick retries */
        }
      }, 1500);
    };

    const connect = () => {
      if (closed) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${window.location.host}/ws?token=${encodeURIComponent(token)}${
        jobId ? `&jobId=${jobId}` : ''
      }`;
      const socket = new WebSocket(url);
      socketRef.current = socket;

      socket.onopen = () => {
        setLive(true);
        if (poll) {
          clearInterval(poll);
          poll = null;
        }
      };
      socket.onmessage = (msg) => {
        try {
          record(JSON.parse(msg.data) as JobEvent);
        } catch {
          /* ignore malformed frames */
        }
      };
      socket.onerror = () => socket.close();
      socket.onclose = () => {
        setLive(false);
        socketRef.current = null;
        if (closed) return;
        startPolling();
        retry = setTimeout(connect, 4000);
      };
    };

    connect();
    // Poll once immediately so the first paint is never empty.
    startPolling();

    return () => {
      closed = true;
      if (poll) clearInterval(poll);
      if (retry) clearTimeout(retry);
      socketRef.current?.close();
    };
  }, [jobId]);

  return { progress, events, live };
}

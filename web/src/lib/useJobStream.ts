import { useEffect, useState } from 'react';
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

const RUNNING = new Set(['pending', 'queued', 'processing']);
const RECONNECT_MS = 4000;
const POLL_MS = 1500;

type Listener = (event: JobEvent) => void;

/**
 * One WebSocket for the whole app.
 *
 * Several screens follow job progress at once (the header, the jobs list, the
 * job page). Opening a socket per hook meant three connections per page, so
 * the connection is shared and hooks subscribe to it.
 */
const connection = {
  socket: null as WebSocket | null,
  listeners: new Set<Listener>(),
  reconnectTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  open: false,

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    this.connect();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.disconnect();
    };
  },

  connect(): void {
    const token = getToken();
    if (this.socket || !token) return;

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws?token=${encodeURIComponent(token)}`);
    this.socket = socket;

    socket.onopen = () => {
      this.open = true;
      this.emit({ type: 'connected' });
    };
    socket.onmessage = (message) => {
      try {
        this.emit(JSON.parse(message.data) as JobEvent);
      } catch {
        // A frame we cannot parse is not worth tearing the connection down for.
      }
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      this.open = false;
      this.socket = null;
      this.emit({ type: 'connected' });
      if (this.listeners.size) {
        this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_MS);
      }
    };
  },

  disconnect(): void {
    clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
    this.open = false;
  },

  emit(event: JobEvent): void {
    for (const listener of this.listeners) listener(event);
  },
};

export interface JobStream {
  /** Latest snapshot per job id. */
  progress: Record<string, JobEvent>;
  /** Rolling log tail for the followed job. */
  events: JobEvent[];
  /** False while the polling fallback is carrying updates. */
  live: boolean;
}

/**
 * Live job updates, with a REST polling fallback for proxies that drop
 * WebSocket upgrades. Pass a jobId to follow one job, or omit it to watch every
 * job in the organisation.
 */
export function useJobStream(jobId?: string): JobStream {
  const [progress, setProgress] = useState<Record<string, JobEvent>>({});
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [live, setLive] = useState(connection.open);

  useEffect(() => {
    if (!getToken()) return;

    const record = (event: JobEvent) => {
      if (event.jobId && (!jobId || event.jobId === jobId)) {
        setProgress((current) => ({
          ...current,
          [event.jobId!]: { ...current[event.jobId!], ...event },
        }));
      }
      if (event.type === 'job.log' || event.type === 'job.status') {
        setEvents((current) => [...current.slice(-99), event]);
      }
    };

    const unsubscribe = connection.subscribe((event) => {
      if (event.type === 'connected') setLive(connection.open);
      else record(event);
    });

    // Polling covers both the fallback case and the first paint.
    const poll = setInterval(async () => {
      if (connection.open) return;
      try {
        if (jobId) {
          const { job } = await api.get<{ job: any }>(`/api/jobs/${jobId}`);
          record(jobProgressFrom(job));
        } else {
          const { jobs } = await api.get<{ jobs: any[] }>('/api/jobs?limit=10');
          jobs.filter((job) => RUNNING.has(job.status)).forEach((job) => record(jobProgressFrom(job)));
        }
      } catch {
        // Transient; the next tick retries.
      }
    }, POLL_MS);

    return () => {
      clearInterval(poll);
      unsubscribe();
    };
  }, [jobId]);

  return { progress, events, live };
}

function jobProgressFrom(job: any): JobEvent {
  return {
    type: 'job.progress',
    jobId: job.id,
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
  };
}

import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { verifyToken } from '../auth/index.js';
import { bus, type JobEvent } from '../lib/bus.js';
import { logger } from '../logger.js';

interface Client {
  socket: WebSocket;
  orgId: string;
  /** Optional filter: only receive events for this job. */
  jobId?: string;
  alive: boolean;
}

/**
 * Live job progress over WebSockets.
 *
 * Auth is via `?token=` because browsers cannot set headers on a WebSocket
 * handshake. Events are filtered by organisation, so a client can never see
 * another tenant's job progress. The UI falls back to polling if the socket
 * cannot be established.
 */
export function attachWebSockets(server: Server): { close: () => Promise<void> } {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const clients = new Set<Client>();

  wss.on('connection', (socket, req) => {
    const url = new URL(req.url ?? '/ws', 'http://localhost');
    const user = verifyToken(url.searchParams.get('token') ?? '');
    if (!user) {
      socket.close(4401, 'unauthorized');
      return;
    }

    const client: Client = {
      socket,
      orgId: user.orgId,
      jobId: url.searchParams.get('jobId') ?? undefined,
      alive: true,
    };
    clients.add(client);
    socket.send(JSON.stringify({ type: 'connected', orgId: user.orgId, jobId: client.jobId }));

    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg?.type === 'subscribe') client.jobId = msg.jobId ?? undefined;
      } catch {
        /* ignore malformed client frames */
      }
    });
    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('close', () => clients.delete(client));
    socket.on('error', () => clients.delete(client));
  });

  const unsubscribe = bus.onJob((event: JobEvent) => {
    const payload = JSON.stringify(event);
    for (const client of clients) {
      if (client.orgId !== event.orgId) continue;
      if (client.jobId && client.jobId !== event.jobId) continue;
      if (client.socket.readyState === client.socket.OPEN) client.socket.send(payload);
    }
  });

  // Drop half-open connections so the client set cannot grow unbounded.
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.socket.terminate();
        clients.delete(client);
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }, 30_000);
  heartbeat.unref?.();

  logger.info('websocket server listening on /ws');

  return {
    close: () =>
      new Promise((resolve) => {
        clearInterval(heartbeat);
        unsubscribe();
        for (const client of clients) client.socket.close();
        wss.close(() => resolve());
      }),
  };
}

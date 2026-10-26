import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from 'pino';
import type { Metrics } from './metrics.js';

export interface HealthServer {
  /** Resolves with the bound ports, so port 0 picks a free one. */
  start(): Promise<{ health: number; metrics: number }>;
  stop(): Promise<void>;
}

export interface HealthDeps {
  port: number;
  metricsPort: number;
  consumer: { isReady(): boolean };
  busySince(): number | undefined;
  db: { ping(): Promise<void> };
  metrics: Metrics;
  logger: Logger;
  now?: () => number;
}

// The client reconnects on its own; a restart only helps once that has failed for a while.
const DISCONNECTED_LIMIT_MS = 60_000;
// Above the longest legitimate handling: a DNS event provisioning every space of a large organization.
const STUCK_LIMIT_MS = 10 * 60_000;

const json = (res: ServerResponse, status: number, body: object) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

type Route = (req: IncomingMessage, res: ServerResponse) => unknown;

export const createHealthServer = ({
  port,
  metricsPort,
  consumer,
  busySince,
  db,
  metrics,
  logger,
  now = Date.now,
}: HealthDeps): HealthServer => {
  const servers: Server[] = [];
  let disconnectedSince: number | undefined;

  const live = (res: ServerResponse) => {
    const at = now();
    if (consumer.isReady()) disconnectedSince = undefined;
    else disconnectedSince ??= at;
    if (disconnectedSince !== undefined && at - disconnectedSince > DISCONNECTED_LIMIT_MS) {
      return json(res, 503, { status: 'not_live', reason: 'consumer_disconnected' });
    }
    const busy = busySince();
    if (busy !== undefined && at - busy > STUCK_LIMIT_MS) {
      return json(res, 503, { status: 'not_live', reason: 'consumer_stuck' });
    }
    return json(res, 200, { status: 'live' });
  };

  const ready = async (res: ServerResponse) => {
    if (!consumer.isReady()) {
      return json(res, 503, { status: 'not_ready', reason: 'consumer_not_connected' });
    }
    try {
      await db.ping();
    } catch (err) {
      return json(res, 503, {
        status: 'not_ready',
        reason: 'db_unreachable',
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return json(res, 200, { status: 'ready' });
  };

  const health: Route = (req, res) => {
    if (req.url === '/health/live') return live(res);
    if (req.url === '/health/ready') return ready(res);
    res.writeHead(404).end();
  };

  const prometheus: Route = async (req, res) => {
    if (req.url !== '/metrics') return res.writeHead(404).end();
    const body = await metrics.registry.metrics();
    res.writeHead(200, { 'Content-Type': metrics.registry.contentType });
    res.end(body);
  };

  const listen = async (route: Route, at: number) => {
    const server = createServer(async (req, res) => {
      try {
        await route(req, res);
      } catch (err) {
        logger.error({ err }, 'health endpoint error');
        res.writeHead(500).end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(at, () => {
        server.off('error', reject);
        resolve();
      });
    });
    servers.push(server);
    return (server.address() as AddressInfo).port;
  };

  return {
    async start() {
      const bound = {
        health: await listen(health, port),
        metrics: await listen(prometheus, metricsPort),
      };
      logger.info(bound, 'health and metrics servers listening');
      return bound;
    },
    async stop() {
      await Promise.all(
        servers.splice(0).map((server) => {
          const closed = new Promise<void>((resolve, reject) =>
            server.close((err) => (err ? reject(err) : resolve())),
          );
          server.closeAllConnections();
          return closed;
        }),
      );
    },
  };
};

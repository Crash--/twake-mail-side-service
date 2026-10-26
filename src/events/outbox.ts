import type { RabbitMQClient } from '@linagora/rabbitmq-client';
import { asc, count, eq, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../infra/db.js';
import { outbox } from './schema.js';

export interface OutboxMessage {
  exchange: string;
  routingKey: string;
  messageId: string;
  body: Record<string, unknown>;
}

export interface OutboxRelay {
  relay(): Promise<void>;
  start(intervalMs: number): void;
  stop(): Promise<void>;
}

interface RelayDeps {
  db: Db;
  client: Pick<RabbitMQClient, 'publish' | 'isConnected'>;
  logger: Logger;
}

const BATCH = 100;

// Pass the handler's transaction, so the message exists only if what it describes was stored.
export const enqueue = async (tx: Pick<Db, 'insert'>, message: OutboxMessage): Promise<void> => {
  await tx.insert(outbox).values(message);
};

export const pendingCount = async (db: Db, routingKey?: string): Promise<number> => {
  const [row] = await db
    .select({ n: count() })
    .from(outbox)
    .where(routingKey ? eq(outbox.routingKey, routingKey) : undefined);
  return row?.n ?? 0;
};

export const createOutboxRelay = ({ db, client, logger }: RelayDeps): OutboxRelay => {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();

  // The transaction-scoped lock keeps a single replica relaying, so messages go out in id order.
  // A failed publish commits the deletes of what went out and ends the run; the next run retries.
  // One attempt per publish, so a broker outage never holds the transaction open through the
  // client's backoff.
  const relayBatch = () =>
    db.transaction(async (tx) => {
      const [lock] = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtext('outbox')) as locked`,
      );
      if (!lock?.locked) return false;
      const pending = await tx.select().from(outbox).orderBy(asc(outbox.id)).limit(BATCH);
      for (const row of pending) {
        try {
          await client.publish(row.exchange, row.routingKey, row.body, {
            messageId: row.messageId,
            maxAttempts: 1,
          });
        } catch (err) {
          logger.error(
            { err, messageId: row.messageId },
            'outbox publish failed, retried next run',
          );
          return false;
        }
        await tx.delete(outbox).where(eq(outbox.id, row.id));
      }
      return pending.length === BATCH;
    });

  const relay = async () => {
    while (client.isConnected() && (await relayBatch()));
  };

  const tick = (intervalMs: number) => {
    running = relay()
      .catch((err) => logger.error({ err }, 'outbox relay failed'))
      .finally(() => {
        if (timer) timer = setTimeout(() => tick(intervalMs), intervalMs);
      });
  };

  return {
    relay,
    start(intervalMs) {
      timer = setTimeout(() => tick(intervalMs), 0);
    },
    async stop() {
      clearTimeout(timer);
      timer = undefined;
      await running;
    },
  };
};

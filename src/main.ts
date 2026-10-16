import { randomUUID } from 'node:crypto';
import * as Sentry from '@sentry/node';
import { loadConfig } from './config.js';
import { createActivity } from './events/activity.js';
import { createInbox } from './events/inbox.js';
import { createOutboxRelay, enqueue, pendingCount } from './events/outbox.js';
import { createParking, parkedCount } from './events/parking.js';
import { createRouter } from './events/router.js';
import { createDbClient } from './infra/db.js';
import { createHealthServer } from './infra/health.js';
import { logger } from './infra/logger.js';
import { createMetrics } from './infra/metrics.js';
import { createConsumer, deadLetters } from './infra/rabbitmq.js';
import { createMailService, messageKey } from './modules/mail/service.js';
import { createSpaceService } from './modules/spaces/service.js';
import { createTmailClient } from './product/api.js';

const PURGE_INTERVAL_MS = 60 * 60 * 1000;

const main = async (): Promise<void> => {
  const config = loadConfig();
  logger.level = config.LOG_LEVEL;

  // An event in flight holds up to two lock connections (its message, its space). Locks waiting
  // for a free connection would never see their holder release, so queries, the relay, the
  // parking and the purge keep connections of their own.
  const db = createDbClient(config.DATABASE_URL, { max: 2 * config.RABBITMQ_PREFETCH + 8 });
  const metrics = createMetrics({
    outboxPending: () => pendingCount(db.db),
    parked: () => parkedCount(db.db),
  });
  // The router is built after the consumer, whose client publishes the activity events.
  const consumer = createConsumer({
    config,
    logger,
    handler: (message, properties) => route(message, properties),
    onSubscriptionLost: () => {
      logger.fatal('a reconnect left the queue unsubscribed');
      void shutdown('subscriptionLost', 1);
    },
  });
  const activity = createActivity(config.RABBITMQ_ACTIVITY_EXCHANGE);
  const outbox = createOutboxRelay({ db: db.db, client: consumer.publisher, logger });
  const spaces = createSpaceService({
    db: db.db,
    lock: db.withLock,
    tmail: createTmailClient({
      baseUrl: config.TMAIL_WEBADMIN_URL,
      password: config.TMAIL_WEBADMIN_PASSWORD,
      onCall: metrics.observeTmail,
    }),
    activity,
    logger,
    addressPrefix: config.TEAM_MAILBOX_PREFIX,
  });
  const mail = createMailService({ db: db.db, activity, logger });
  const inbox = createInbox({ db: db.db, lock: db.withLock });
  const once = inbox.wrap;
  const handlers = {
    'twake.space.created': once(spaces.spaceCreated),
    'twake.space.synced': once(spaces.spaceSynced),
    'twake.space.sync.completed': once(spaces.syncCompleted),
    'twake.space.updated': once(spaces.spaceRenamed),
    'twake.space.deleted': once(spaces.spaceDeleted),
    'twake.space.member.added': once(spaces.memberAdded),
    'twake.space.member.removed': once(spaces.memberRemoved),
    'twake.space.member.role.changed': once(spaces.memberRoleChanged),
    [config.RABBITMQ_DNS_ROUTING_KEY]: once(spaces.dnsValidated),
    [config.RABBITMQ_USER_DELETED_ROUTING_KEY]: once(spaces.userDeleted),
    [config.RABBITMQ_MAIL_RECEIVED_ROUTING_KEY]: once(mail.messageAdded, messageKey),
    [config.RABBITMQ_MAIL_SENT_ROUTING_KEY]: once(mail.messageAdded, messageKey),
  };
  const parking = createParking({
    db: db.db,
    tryLock: db.tryLock,
    client: consumer.publisher,
    handlers,
    deadLetters: deadLetters(config.RABBITMQ_QUEUE),
    maxWaitMs: config.PARKING_MAX_WAIT_MS,
    logger,
  });
  const route = createRouter({
    handlers,
    park: parking.park,
    logger,
    metrics,
    maxRetries: config.RABBITMQ_MAX_RETRIES,
  });
  const health = createHealthServer({
    port: config.HEALTH_PORT,
    metricsPort: config.METRICS_PORT,
    consumer,
    busySince: route.busySince,
    db,
    metrics,
    logger,
  });

  await health.start();

  try {
    await db.migrate();
    await consumer.start();
    // A sync request fans out to every app and every space, so only a first deployment sends one,
    // and a restart while it is still in the outbox does not add another.
    if (!(await spaces.hasSpaces()) && !(await pendingCount(db.db, 'twake.space.sync.requested'))) {
      await enqueue(db.db, {
        exchange: config.RABBITMQ_SPACE_EXCHANGE,
        routingKey: 'twake.space.sync.requested',
        messageId: randomUUID(),
        body: { timestamp: new Date().toISOString() },
      });
      logger.info('no space stored yet, sync of every organization requested');
    }
  } catch (err) {
    await health.stop();
    throw err;
  }

  outbox.start(config.OUTBOX_INTERVAL_MS);
  parking.start(config.PARKING_INTERVAL_MS);

  // Each run deletes only what is due, so replicas running it at the same time are harmless.
  const purge = async () => {
    await spaces
      .purgeDeleted()
      .catch((err) => logger.error({ err }, 'purge of deleted spaces failed'));
    await inbox.purge().catch((err) => logger.error({ err }, 'purge of the inbox failed'));
  };
  void purge();
  const purger = setInterval(() => void purge(), PURGE_INTERVAL_MS);
  purger.unref();

  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown signal received');

    const timer = setTimeout(() => {
      logger.error({ timeoutMs: config.SHUTDOWN_TIMEOUT_MS }, 'shutdown timeout; forcing exit');
      process.exit(1);
    }, config.SHUTDOWN_TIMEOUT_MS);
    timer.unref();

    clearInterval(purger);
    try {
      // Rows a handler writes after this stay in the outbox for the next start.
      await parking.stop();
      await outbox.stop();
      await consumer.stop();
      await db.close();
      await health.stop();
      logger.info('shutdown complete');
      await Sentry.flush(2000);
      process.exit(exitCode);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      Sentry.captureException(err);
      await Sentry.flush(2000);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    void shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'unhandled rejection');
    void shutdown('unhandledRejection', 1);
  });
};

main().catch(async (err) => {
  logger.fatal({ err }, 'fatal error during startup');
  Sentry.captureException(err);
  await Sentry.flush(2000);
  process.exit(1);
});

import { DeadLetterError, type RabbitMQMessageHandler } from '@linagora/rabbitmq-client';
import * as Sentry from '@sentry/node';
import type { Logger } from 'pino';
import type { Metrics, Outcome } from '../infra/metrics.js';
import { MalformedEventError, NotYetKnownError } from './errors.js';
import type { Parking } from './parking.js';

// A handler that skips its message says why, for the metrics.
export type Handler = (
  ...args: Parameters<RabbitMQMessageHandler>
) => Promise<'duplicate' | 'stale' | void>;

export interface RouterDeps {
  handlers: Record<string, Handler>;
  park: Parking['park'];
  logger: Logger;
  metrics: Metrics;
  maxRetries: number;
}

export type Router = RabbitMQMessageHandler & {
  /** When the oldest message still in hand was received. */
  busySince(): number | undefined;
};

// One queue is bound to several exchanges, so the routing key alone picks the handler.
export const createRouter = ({
  handlers,
  park,
  logger,
  metrics,
  maxRetries,
}: RouterDeps): Router => {
  const inHand = new Set<{ started: number }>();
  // The client retries a delivery in process with the same properties object, and logs each
  // failed attempt, so Sentry only hears of the attempt that dead letters it.
  const failedAttempts = new WeakMap<object, number>();

  const route: RabbitMQMessageHandler = async (message, properties) => {
    const event = properties.routingKey;
    const started = Date.now();
    const handler = handlers[event];
    if (!handler) {
      logger.debug({ event, exchange: properties.exchange }, 'no handler for routing key');
      metrics.observe(event, 'unrouted', Date.now() - started);
      return;
    }
    let outcome: Outcome = 'failed';
    const handling = { started };
    inHand.add(handling);
    try {
      outcome = (await handler(message, properties)) ?? 'handled';
    } catch (err) {
      if (err instanceof MalformedEventError) {
        logger.warn({ event, messageId: properties.messageId, err }, 'malformed event dropped');
        outcome = 'dropped';
        return;
      }
      try {
        if (!(err instanceof NotYetKnownError)) throw err;
        await park(message, properties, err);
        outcome = 'parked';
      } catch (failure) {
        if (failure instanceof DeadLetterError) outcome = 'dead_lettered';
        const attempts = (failedAttempts.get(properties) ?? 0) + 1;
        failedAttempts.set(properties, attempts);
        if (failure instanceof DeadLetterError || attempts >= maxRetries) {
          Sentry.captureException(failure, { tags: { event } });
        }
        throw failure;
      }
    } finally {
      inHand.delete(handling);
      metrics.observe(event, outcome, Date.now() - started);
    }
  };

  return Object.assign(route, {
    // A Set iterates in insertion order, so its first entry is the oldest.
    busySince: () => inHand.values().next().value?.started,
  });
};

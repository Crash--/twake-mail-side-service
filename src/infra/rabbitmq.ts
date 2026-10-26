import { RabbitMQClient, type RabbitMQMessageHandler } from '@linagora/rabbitmq-client';
import * as Sentry from '@sentry/node';
import type { Logger } from 'pino';
import type { Config } from '../config.js';

export interface Consumer {
  start(): Promise<void>;
  stop(): Promise<void>;
  isReady(): boolean;
  publisher: Pick<RabbitMQClient, 'publish' | 'isConnected'>;
}

const SPACE_EVENTS = 'twake.space.#';

// The client binds the dead letter queue to `<main binding>.dead`, and RabbitMQ gives every
// message it dead-letters that key, whatever key it came with.
export const deadLetters = (queue: string) => ({
  exchange: `${queue}.dlx`,
  routingKey: `${SPACE_EVENTS}.dead`,
});

export interface ConsumerDeps {
  config: Config;
  logger: Logger;
  handler: RabbitMQMessageHandler;
  onSubscriptionLost?: () => void;
}

export const createConsumer = ({
  config,
  logger,
  handler,
  onSubscriptionLost,
}: ConsumerDeps): Consumer => {
  let subscribed = false;
  // The client logs each failed attempt as an error; the router reports the last one to Sentry.
  const clientLogger = logger.child({});
  Sentry.pinoIntegration.untrackLogger(clientLogger);
  const client = new RabbitMQClient({
    url: config.RABBITMQ_URL,
    retryDelay: config.RABBITMQ_RETRY_DELAY,
    prefetch: config.RABBITMQ_PREFETCH,
    // Half the budget, so closing the connection and the database still fits before the forced exit.
    closeTimeout: Math.floor(config.SHUTDOWN_TIMEOUT_MS / 2),
    logger: clientLogger,
    hooks: {
      // The client never retries a failed resubscribe, so a restart is the way back.
      onReconnect: ({ subscriptionsFailed }) => {
        subscribed = subscriptionsFailed === 0;
        if (!subscribed) onSubscriptionLost?.();
      },
    },
  });

  return {
    async start() {
      logger.info({ queue: config.RABBITMQ_QUEUE }, 'connecting to RabbitMQ');
      await client.init();
      await client.subscribe(
        config.RABBITMQ_SPACE_EXCHANGE,
        SPACE_EVENTS,
        config.RABBITMQ_QUEUE,
        handler,
        {
          bindings: [
            {
              exchange: config.RABBITMQ_DNS_EXCHANGE,
              routingKey: config.RABBITMQ_DNS_ROUTING_KEY,
            },
            {
              exchange: config.RABBITMQ_USER_DELETED_EXCHANGE,
              routingKey: config.RABBITMQ_USER_DELETED_ROUTING_KEY,
            },
            {
              exchange: config.RABBITMQ_MAIL_EXCHANGE,
              routingKey: config.RABBITMQ_MAIL_RECEIVED_ROUTING_KEY,
            },
            {
              exchange: config.RABBITMQ_MAIL_EXCHANGE,
              routingKey: config.RABBITMQ_MAIL_SENT_ROUTING_KEY,
            },
          ],
          deadLetterExchange: deadLetters(config.RABBITMQ_QUEUE).exchange,
          passiveExchanges: true,
          maxRetries: config.RABBITMQ_MAX_RETRIES,
          maxRetryDelay: config.RABBITMQ_MAX_RETRY_DELAY,
          // Fixed: RabbitMQ refuses to redeclare a queue with different arguments.
          queueArguments: { 'x-delivery-limit': 20 },
        },
      );
      subscribed = true;
      logger.info('consumer subscribed');
    },
    async stop() {
      subscribed = false;
      await client.close();
    },
    isReady() {
      return subscribed && client.isConnected();
    },
    publisher: client,
  };
};

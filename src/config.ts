import { z } from 'zod';

const positiveInt = z.coerce.number().int().positive();

const envSchema = z.object({
  RABBITMQ_URL: z.string().min(1),
  RABBITMQ_QUEUE: z.string().default('twake-mail-side-service.v2'),
  RABBITMQ_SPACE_EXCHANGE: z.string().default('space'),
  RABBITMQ_DNS_EXCHANGE: z.string().default('admin-panel'),
  RABBITMQ_DNS_ROUTING_KEY: z.string().default('dns.validated'),
  RABBITMQ_USER_DELETED_EXCHANGE: z.string().default('b2b'),
  RABBITMQ_USER_DELETED_ROUTING_KEY: z.string().default('domain.user.deleted'),
  RABBITMQ_MAIL_EXCHANGE: z.string().default('tmail'),
  RABBITMQ_MAIL_RECEIVED_ROUTING_KEY: z.string().default('team-mailbox.message.received'),
  RABBITMQ_MAIL_SENT_ROUTING_KEY: z.string().default('team-mailbox.message.sent'),
  RABBITMQ_ACTIVITY_EXCHANGE: z.string().default('activity'),
  RABBITMQ_PREFETCH: positiveInt.default(4),
  RABBITMQ_MAX_RETRIES: positiveInt.default(8),
  RABBITMQ_RETRY_DELAY: positiveInt.default(1000),
  RABBITMQ_MAX_RETRY_DELAY: positiveInt.default(30_000),
  OUTBOX_INTERVAL_MS: positiveInt.default(1000),
  PARKING_INTERVAL_MS: positiveInt.default(5000),
  PARKING_MAX_WAIT_MS: positiveInt.default(10 * 60 * 1000),

  DATABASE_URL: z.string().min(1),

  TMAIL_WEBADMIN_URL: z.url(),
  TMAIL_WEBADMIN_PASSWORD: z.string().optional(),
  TEAM_MAILBOX_PREFIX: z
    .string()
    .regex(/^([a-z0-9_]+-)?$/, 'lowercase letters, digits or _, ending with a dash')
    .max(32)
    .default(''),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  HEALTH_PORT: positiveInt.default(8080),
  METRICS_PORT: positiveInt.default(9090),
  SHUTDOWN_TIMEOUT_MS: positiveInt.default(10_000),
});

export type Config = z.infer<typeof envSchema>;

export const loadConfig = (env: Record<string, string | undefined> = process.env): Config => {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  if (result.data.RABBITMQ_MAX_RETRY_DELAY < result.data.RABBITMQ_RETRY_DELAY) {
    throw new Error(
      'Invalid configuration: RABBITMQ_MAX_RETRY_DELAY is below RABBITMQ_RETRY_DELAY',
    );
  }
  return result.data;
};

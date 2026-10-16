import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const baseEnv = {
  RABBITMQ_URL: 'amqp://localhost',
  DATABASE_URL: 'postgres://localhost/mail',
  TMAIL_WEBADMIN_URL: 'http://tmail-admin:8000',
};

describe('loadConfig', () => {
  it('returns defaults for optional fields', () => {
    const cfg = loadConfig(baseEnv);
    expect(cfg.RABBITMQ_QUEUE).toBe('twake-mail-side-service.v2');
    expect(cfg.RABBITMQ_SPACE_EXCHANGE).toBe('space');
    expect(cfg.RABBITMQ_DNS_EXCHANGE).toBe('admin-panel');
    expect(cfg.RABBITMQ_DNS_ROUTING_KEY).toBe('dns.validated');
    expect(cfg.RABBITMQ_USER_DELETED_EXCHANGE).toBe('b2b');
    expect(cfg.RABBITMQ_USER_DELETED_ROUTING_KEY).toBe('domain.user.deleted');
    expect(cfg.RABBITMQ_ACTIVITY_EXCHANGE).toBe('activity');
    expect(cfg.RABBITMQ_MAIL_EXCHANGE).toBe('tmail');
    expect(cfg.RABBITMQ_MAIL_RECEIVED_ROUTING_KEY).toBe('team-mailbox.message.received');
    expect(cfg.RABBITMQ_MAIL_SENT_ROUTING_KEY).toBe('team-mailbox.message.sent');
    expect(cfg.TMAIL_WEBADMIN_PASSWORD).toBeUndefined();
    expect(cfg.LOG_LEVEL).toBe('info');
    expect(cfg.HEALTH_PORT).toBe(8080);
    expect(cfg.METRICS_PORT).toBe(9090);
  });

  it('throws when RABBITMQ_URL is missing', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x' })).toThrow(/RABBITMQ_URL/);
  });

  it('throws when DATABASE_URL is missing', () => {
    expect(() => loadConfig({ RABBITMQ_URL: 'amqp://x' })).toThrow(/DATABASE_URL/);
  });

  it('throws when TMAIL_WEBADMIN_URL is not a URL', () => {
    expect(() => loadConfig({ ...baseEnv, TMAIL_WEBADMIN_URL: 'tmail-admin' })).toThrow(
      /TMAIL_WEBADMIN_URL/,
    );
  });

  it('throws when the retry delay cap is below the first delay', () => {
    expect(() =>
      loadConfig({ ...baseEnv, RABBITMQ_RETRY_DELAY: '5000', RABBITMQ_MAX_RETRY_DELAY: '3000' }),
    ).toThrow(/RABBITMQ_MAX_RETRY_DELAY/);
  });

  it('coerces numeric env vars', () => {
    const cfg = loadConfig({ ...baseEnv, RABBITMQ_PREFETCH: '10', HEALTH_PORT: '9090' });
    expect(cfg.RABBITMQ_PREFETCH).toBe(10);
    expect(cfg.HEALTH_PORT).toBe(9090);
  });

  it('takes a team mailbox prefix ending with a dash, none by default', () => {
    expect(loadConfig(baseEnv).TEAM_MAILBOX_PREFIX).toBe('');
    expect(loadConfig({ ...baseEnv, TEAM_MAILBOX_PREFIX: 'space-' }).TEAM_MAILBOX_PREFIX).toBe(
      'space-',
    );
    expect(() => loadConfig({ ...baseEnv, TEAM_MAILBOX_PREFIX: 'space' })).toThrow(
      /TEAM_MAILBOX_PREFIX/,
    );
    expect(() => loadConfig({ ...baseEnv, TEAM_MAILBOX_PREFIX: 'Space-' })).toThrow(
      /TEAM_MAILBOX_PREFIX/,
    );
  });

  it('rejects an unknown log level', () => {
    expect(() => loadConfig({ ...baseEnv, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });
});

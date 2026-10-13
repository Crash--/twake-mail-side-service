import * as Sentry from '@sentry/node';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMetrics } from '../infra/metrics.js';
import { silentLogger } from '../testing/helpers.js';
import { MalformedEventError, NotYetKnownError, RejectedEventError } from './errors.js';
import { createRouter } from './router.js';

vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));

const props = (routingKey: string) => ({ exchange: 'space', routingKey, headers: {} });

describe('createRouter', () => {
  beforeEach(() => vi.mocked(Sentry.captureException).mockClear());

  it('reports a failing message to Sentry on its last attempt only', async () => {
    const route = createRouter({
      handlers: { 'dns.validated': vi.fn().mockRejectedValue(new Error('tmail down')) },
      park: vi.fn(),
      logger: silentLogger,
      metrics: createMetrics(),
      maxRetries: 3,
    });
    const delivery = props('dns.validated');

    await expect(route({}, delivery)).rejects.toThrow('tmail down');
    await expect(route({}, delivery)).rejects.toThrow('tmail down');
    expect(Sentry.captureException).not.toHaveBeenCalled();

    await expect(route({}, delivery)).rejects.toThrow('tmail down');
    expect(Sentry.captureException).toHaveBeenCalledOnce();
  });

  it('reports a message refused for good to Sentry on its first attempt', async () => {
    const route = createRouter({
      handlers: { 'twake.space.created': vi.fn().mockRejectedValue(new RejectedEventError('no')) },
      park: vi.fn(),
      logger: silentLogger,
      metrics: createMetrics(),
      maxRetries: 3,
    });

    await expect(route({}, props('twake.space.created'))).rejects.toThrow('no');

    expect(Sentry.captureException).toHaveBeenCalledOnce();
  });

  it('drops a malformed event', async () => {
    const metrics = createMetrics();
    const route = createRouter({
      handlers: {
        'dns.validated': vi.fn().mockRejectedValue(new MalformedEventError('no domain')),
      },
      park: vi.fn(),
      logger: silentLogger,
      metrics,
      maxRetries: 3,
    });

    await expect(route({}, props('dns.validated'))).resolves.toBeUndefined();

    const dropped = await metrics.messagesProcessed.get();
    expect(dropped.values).toContainEqual(
      expect.objectContaining({ labels: { event: 'dns.validated', outcome: 'dropped' } }),
    );
  });

  it('hands a message to the handler of its routing key', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const route = createRouter({
      handlers: { 'twake.space.created': handler },
      park: vi.fn(),
      logger: silentLogger,
      metrics: createMetrics(),
      maxRetries: 3,
    });

    await route({ id: 's1' }, props('twake.space.created'));

    expect(handler).toHaveBeenCalledWith({ id: 's1' }, props('twake.space.created'));
  });

  it('acks a routing key it has no handler for', async () => {
    const metrics = createMetrics();
    const route = createRouter({
      handlers: {},
      park: vi.fn(),
      logger: silentLogger,
      metrics,
      maxRetries: 3,
    });

    await expect(route({}, props('twake.space.group.linked'))).resolves.toBeUndefined();

    const unrouted = await metrics.messagesProcessed.get();
    expect(unrouted.values).toContainEqual(
      expect.objectContaining({
        labels: { event: 'twake.space.group.linked', outcome: 'unrouted' },
        value: 1,
      }),
    );
  });

  it.each(['duplicate', 'stale'] as const)(
    'records a message its handler skipped as %s',
    async (outcome) => {
      const metrics = createMetrics();
      const route = createRouter({
        handlers: { 'twake.space.updated': vi.fn().mockResolvedValue(outcome) },
        park: vi.fn(),
        logger: silentLogger,
        metrics,
        maxRetries: 3,
      });

      await route({}, props('twake.space.updated'));

      const recorded = await metrics.messagesProcessed.get();
      expect(recorded.values).toContainEqual(
        expect.objectContaining({ labels: { event: 'twake.space.updated', outcome } }),
      );
    },
  );

  it('records a message refused for good as dead lettered', async () => {
    const metrics = createMetrics();
    const route = createRouter({
      handlers: { 'twake.space.created': vi.fn().mockRejectedValue(new RejectedEventError('no')) },
      park: vi.fn(),
      logger: silentLogger,
      metrics,
      maxRetries: 3,
    });

    await expect(route({}, props('twake.space.created'))).rejects.toThrow('no');

    const recorded = await metrics.messagesProcessed.get();
    expect(recorded.values).toContainEqual(
      expect.objectContaining({
        labels: { event: 'twake.space.created', outcome: 'dead_lettered' },
      }),
    );
  });

  it('parks a message that needs an object a later event may bring', async () => {
    const metrics = createMetrics();
    const park = vi.fn().mockResolvedValue(undefined);
    const error = new NotYetKnownError('sales@acme.com has no mailbox yet');
    const route = createRouter({
      handlers: { 'team-mailbox.message.received': vi.fn().mockRejectedValue(error) },
      park,
      logger: silentLogger,
      metrics,
      maxRetries: 3,
    });

    await expect(
      route({ messageId: 'm1' }, props('team-mailbox.message.received')),
    ).resolves.toBeUndefined();

    expect(park).toHaveBeenCalledWith(
      { messageId: 'm1' },
      props('team-mailbox.message.received'),
      error,
    );
    const parked = await metrics.messagesProcessed.get();
    expect(parked.values).toContainEqual(
      expect.objectContaining({
        labels: { event: 'team-mailbox.message.received', outcome: 'parked' },
      }),
    );
  });

  it('counts a message it could not park as failed', async () => {
    const metrics = createMetrics();
    const route = createRouter({
      handlers: {
        'team-mailbox.message.received': vi.fn().mockRejectedValue(new NotYetKnownError('x')),
      },
      park: vi.fn().mockRejectedValue(new Error('database down')),
      logger: silentLogger,
      metrics,
      maxRetries: 3,
    });

    await expect(route({}, props('team-mailbox.message.received'))).rejects.toThrow(
      'database down',
    );

    const failed = await metrics.messagesProcessed.get();
    expect(failed.values).toContainEqual(
      expect.objectContaining({
        labels: { event: 'team-mailbox.message.received', outcome: 'failed' },
      }),
    );
  });

  it('counts a failed parking as an attempt toward the Sentry report', async () => {
    const route = createRouter({
      handlers: {
        'team-mailbox.message.received': vi
          .fn()
          .mockRejectedValueOnce(new NotYetKnownError('x'))
          .mockRejectedValue(new Error('tmail down')),
      },
      park: vi.fn().mockRejectedValue(new Error('database down')),
      logger: silentLogger,
      metrics: createMetrics(),
      maxRetries: 2,
    });
    const delivery = props('team-mailbox.message.received');

    await expect(route({}, delivery)).rejects.toThrow('database down');
    await expect(route({}, delivery)).rejects.toThrow('tmail down');

    expect(Sentry.captureException).toHaveBeenCalledOnce();
  });

  it('knows since when the oldest message in hand was received', async () => {
    let finish = () => {};
    const route = createRouter({
      handlers: {
        'dns.validated': () => new Promise<void>((resolve) => (finish = resolve)),
        'twake.space.created': vi.fn().mockResolvedValue(undefined),
      },
      park: vi.fn(),
      logger: silentLogger,
      metrics: createMetrics(),
      maxRetries: 3,
    });

    expect(route.busySince()).toBeUndefined();
    const before = Date.now();
    const slow = route({}, props('dns.validated'));
    await route({}, props('twake.space.created'));

    expect(route.busySince()).toBeGreaterThanOrEqual(before);
    finish();
    await slow;
    expect(route.busySince()).toBeUndefined();
  });

  it('rethrows a handler error so the client retries the message', async () => {
    const metrics = createMetrics();
    const route = createRouter({
      handlers: { 'dns.validated': vi.fn().mockRejectedValue(new Error('tmail down')) },
      park: vi.fn(),
      logger: silentLogger,
      metrics,
      maxRetries: 3,
    });

    await expect(route({}, props('dns.validated'))).rejects.toThrow('tmail down');

    const failed = await metrics.messagesProcessed.get();
    expect(failed.values).toContainEqual(
      expect.objectContaining({ labels: { event: 'dns.validated', outcome: 'failed' } }),
    );
  });
});

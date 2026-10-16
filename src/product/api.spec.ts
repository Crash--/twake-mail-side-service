import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTmailClient } from './api.js';
import { NotYetKnownError, RejectedEventError } from '../events/errors.js';
import { AddressTakenError, TmailError } from './port.js';

interface Recorded {
  method?: string;
  url?: string;
  password?: string | string[];
}

let server: http.Server;
let baseUrl: string;
let requests: Recorded[];
let reply: { status: number; body?: string };
let listReply: { status: number; body?: string };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, password: req.headers.password });
    const answer = req.url?.startsWith('/mailingLists/') ? listReply : reply;
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(answer.body);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  requests = [];
  reply = { status: 204 };
  listReply = { status: 404, body: '{"message":"not found"}' };
});

const client = () => createTmailClient({ baseUrl, password: 'secret' });

describe('createTmailClient', () => {
  it('creates a team mailbox with the webadmin password', async () => {
    await client().createTeamMailbox('acme.com', 'sales');

    expect(requests).toEqual([
      { method: 'PUT', url: '/domains/acme.com/team-mailboxes/sales', password: 'secret' },
    ]);
  });

  it('reports an address already held by a user or alias', async () => {
    reply = { status: 409, body: '{"message":"taken"}' };

    await expect(client().createTeamMailbox('acme.com', 'sales')).rejects.toBeInstanceOf(
      AddressTakenError,
    );
  });

  it('finds an address held by a mailing list', async () => {
    listReply = { status: 200, body: '{"mailingList":"sales@acme.com"}' };

    await expect(client().isMailingList('sales@acme.com')).resolves.toBe(true);
    expect(requests).toEqual([
      { method: 'GET', url: '/mailingLists/sales%40acme.com', password: 'secret' },
    ]);
  });

  it.each([
    [404, 'no such list'],
    [409, 'a TMail that reads no lists'],
  ])('reads a %i as no mailing list (%s)', async (status) => {
    listReply = { status, body: '{"message":"no"}' };

    await expect(client().isMailingList('sales@acme.com')).resolves.toBe(false);
  });

  it('leaves a failing mailing list lookup to be retried', async () => {
    listReply = { status: 503, body: 'down' };

    await expect(client().isMailingList('sales@acme.com')).rejects.toBeInstanceOf(TmailError);
  });

  it("lists a domain's team mailbox names", async () => {
    reply = {
      status: 200,
      body: '[{"name":"sales","emailAddress":"sales@acme.com"},{"name":"hr","emailAddress":"hr@acme.com"}]',
    };

    await expect(client().listTeamMailboxes('acme.com')).resolves.toEqual(['sales', 'hr']);
    expect(requests[0]).toMatchObject({ method: 'GET', url: '/domains/acme.com/team-mailboxes' });
  });

  it("finds the id of a team mailbox's root, not of its folders", async () => {
    reply = {
      status: 200,
      body: '[{"mailboxName":"INBOX","mailboxId":"inbox-id"},{"mailboxName":"sales","mailboxId":"root-id"},{"mailboxName":"sales-eu","mailboxId":"other-id"}]',
    };

    await expect(client().rootMailboxId('acme.com', 'sales')).resolves.toBe('root-id');
    expect(requests[0]).toMatchObject({
      method: 'GET',
      url: '/domains/acme.com/team-mailboxes/sales/mailboxes',
    });
  });

  it('fails when the root is not listed', async () => {
    reply = { status: 200, body: '[{"mailboxName":"INBOX","mailboxId":"inbox-id"}]' };

    await expect(client().rootMailboxId('acme.com', 'sales')).rejects.toThrow('sales@acme.com');
  });

  it('fails when the root is listed without an id', async () => {
    reply = { status: 200, body: '[{"mailboxName":"sales"}]' };

    await expect(client().rootMailboxId('acme.com', 'sales')).rejects.toThrow('sales@acme.com');
  });

  it('adds a member with a role', async () => {
    await client().addMember('acme.com', 'sales', 'jane@acme.com', 'manager');

    expect(requests[0]).toMatchObject({
      method: 'PUT',
      url: '/domains/acme.com/team-mailboxes/sales/members/jane%40acme.com?role=manager',
    });
  });

  it('removes a member', async () => {
    await client().removeMember('acme.com', 'sales', 'jane@acme.com');

    expect(requests[0]).toMatchObject({
      method: 'DELETE',
      url: '/domains/acme.com/team-mailboxes/sales/members/jane%40acme.com',
    });
  });

  it("lists a team mailbox's members", async () => {
    reply = {
      status: 200,
      body: '[{"username":"jane@acme.com","role":"manager"},{"username":"bob@acme.com","role":"member"}]',
    };

    await expect(client().listMembers('acme.com', 'sales')).resolves.toEqual([
      { username: 'jane@acme.com', role: 'manager' },
      { username: 'bob@acme.com', role: 'member' },
    ]);
    expect(requests[0]).toMatchObject({
      method: 'GET',
      url: '/domains/acme.com/team-mailboxes/sales/members',
    });
  });

  it('lists no members for a team mailbox TMail does not have', async () => {
    reply = { status: 404, body: '{"message":"not found"}' };

    await expect(client().listMembers('acme.com', 'sales')).resolves.toEqual([]);
  });

  it('deletes a team mailbox, already gone with its domain or not', async () => {
    await client().deleteTeamMailbox('acme.com', 'sales');
    reply = { status: 404, body: '{"message":"domain not found"}' };
    await client().deleteTeamMailbox('acme.com', 'sales');

    expect(requests[0]).toMatchObject({
      method: 'DELETE',
      url: '/domains/acme.com/team-mailboxes/sales',
    });
  });

  it('removes no one from a team mailbox TMail does not have', async () => {
    reply = { status: 404, body: '{"message":"The requested team mailbox does not exists"}' };

    await expect(client().removeMember('acme.com', 'sales', 'jane@acme.com')).resolves.toBe(
      undefined,
    );
  });

  it.each([500, 503, 429, 408, 401, 403])('leaves a %i answer to be retried', async (status) => {
    reply = { status, body: 'boom' };

    const err = await client()
      .addMember('acme.com', 'sales', 'jane@acme.com', 'member')
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TmailError);
    expect(err).not.toBeInstanceOf(RejectedEventError);
    expect(err).toMatchObject({ status, body: 'boom' });
  });

  it('reports each call with its operation, result and duration', async () => {
    const calls: [string, string, number][] = [];
    const report = (...call: [string, string, number]) => void calls.push(call);

    reply = { status: 401, body: 'no' };
    await createTmailClient({ baseUrl, password: 'wrong', onCall: report })
      .addMember('acme.com', 'sales', 'jane@acme.com', 'member')
      .catch(() => {});
    reply = { status: 204 };
    await createTmailClient({ baseUrl, onCall: report }).removeMember('acme.com', 'sales', 'jane');
    await createTmailClient({ baseUrl: 'http://127.0.0.1:1', onCall: report })
      .createTeamMailbox('acme.com', 'sales')
      .catch(() => {});

    expect(calls).toEqual([
      ['addMember', '401', expect.any(Number)],
      ['removeMember', '204', expect.any(Number)],
      ['createTeamMailbox', 'error', expect.any(Number)],
    ]);
  });

  it('waits for a domain TMail does not have yet', async () => {
    reply = { status: 404, body: '{"message":"The domain do not exist: acme.com"}' };

    await expect(client().createTeamMailbox('acme.com', 'sales')).rejects.toBeInstanceOf(
      NotYetKnownError,
    );
  });

  it('waits for a team mailbox TMail does not have yet', async () => {
    reply = { status: 404, body: '{"message":"The requested team mailbox does not exists"}' };

    await expect(
      client().addMember('acme.com', 'sales', 'jane@acme.com', 'member'),
    ).rejects.toBeInstanceOf(NotYetKnownError);
  });

  it.each([400, 422])('refuses for good a %i answer', async (status) => {
    reply = { status, body: 'no' };

    const err = await client()
      .addMember('acme.com', 'sales', 'jane@acme.com', 'member')
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RejectedEventError);
    expect(err).toMatchObject({ status, body: 'no' });
  });
});

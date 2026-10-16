import type { RabbitMQClient } from '@linagora/rabbitmq-client';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
  type Mocked,
} from 'vitest';
import { createActivity } from '../../events/activity.js';
import { NotYetKnownError, RejectedEventError } from '../../events/errors.js';
import { createOutboxRelay } from '../../events/outbox.js';
import { createDbClient, type DbClient } from '../../infra/db.js';
import { AddressTakenError, type TeamMailboxRole, type TmailClient } from '../../product/port.js';
import { broker, silentLogger } from '../../testing/helpers.js';
import { spaceMembers, spaces } from './schema.js';
import { createSpaceService } from './service.js';

const SPACE = '6f1c1f3e-1b7a-4f0e-9a51-0c9f2b7d1a10';
const OTHER_SPACE = '0b8a6c2e-3d41-4f6a-8e7b-2c5d9f1a4b33';
const JANE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const VIC = '33333333-3333-4333-8333-333333333333';

const member = (uuid: string, email: string, role: string) => ({
  uuid,
  username: email.split('@')[0],
  email,
  firstName: 'F',
  lastName: 'L',
  role,
});

const created = (id = SPACE, name = 'Sales EU') => ({
  organizationId: 'acme',
  id,
  name,
  members: [
    member(JANE, 'jane@acme.com', 'admin'),
    member(BOB, 'bob@acme.com', 'editor'),
    member(VIC, 'vic@acme.com', 'viewer'),
  ],
  groups: [],
  timestamp: '2026-10-06T10:00:00Z',
});

const validated = (mail = true) => ({
  organizationId: 'acme',
  domain: 'acme.com',
  dnsOwnershipValidated: true,
  mailDnsConfigurationValidated: mail,
  chatDnsConfigurationValidated: false,
});

const memberEvent = (
  uuid: string,
  email: string,
  role: string,
  timestamp = '2026-10-06T11:00:00Z',
) => ({
  organizationId: 'acme',
  id: SPACE,
  members: [member(uuid, email, role)],
  timestamp,
});

const synced = (timestamp: string, members: ReturnType<typeof member>[], name = 'Sales EU') => ({
  organizationId: 'acme',
  id: SPACE,
  name,
  members,
  groups: [],
  timestamp,
});

const renamed = (name: string, timestamp = '2026-10-06T11:00:00Z') => ({
  organizationId: 'acme',
  id: SPACE,
  name,
  timestamp,
});

let container: StartedPostgreSqlContainer;
let client: DbClient;
let tmail: Mocked<TmailClient>;
let publish: Mock<RabbitMQClient['publish']>;

const service = () =>
  createSpaceService({
    db: client.db,
    lock: client.withLock,
    tmail,
    activity: createActivity('activity'),
    logger: silentLogger,
    addressPrefix: '',
  });

const provisioned = async () => {
  await createOutboxRelay({ db: client.db, client: broker(publish), logger: silentLogger }).relay();
  return publish.mock.calls
    .map(([, , event]) => event as ProvisionedEvent)
    .filter((event) => event.type === 'com.twake.mail.space.provisioned.v1')
    .map(({ id, twakeorg, data }) => ({
      id,
      organizationId: twakeorg,
      spaceId: data.space_id,
      mailboxId: data.resource.id,
    }));
};

type ProvisionedEvent = {
  id: string;
  type: string;
  twakeorg: string;
  data: { space_id: string; resource: { id: string } };
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  client = createDbClient(container.getConnectionUri());
  await client.migrate();
}, 120_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
});

beforeEach(async () => {
  await client.db.execute(sql`TRUNCATE organizations, spaces, space_members, outbox CASCADE`);
  const mailboxes = new Map<string, Map<string, TeamMailboxRole>>();
  const members = (domain: string, name: string) => {
    const key = `${name}@${domain}`;
    if (!mailboxes.has(key)) mailboxes.set(key, new Map());
    return mailboxes.get(key)!;
  };
  tmail = {
    listTeamMailboxes: vi.fn().mockResolvedValue([]),
    createTeamMailbox: vi.fn().mockResolvedValue(undefined),
    isMailingList: vi.fn().mockResolvedValue(false),
    deleteTeamMailbox: vi.fn().mockResolvedValue(undefined),
    rootMailboxId: vi.fn(async (_domain: string, name: string) => `id-${name}`),
    listMembers: vi.fn(async (domain: string, name: string) =>
      [...members(domain, name)].map(([username, role]) => ({ username, role })),
    ),
    addMember: vi.fn(async (domain: string, name: string, user: string, role: TeamMailboxRole) => {
      members(domain, name).set(user, role);
    }),
    removeMember: vi.fn(async (domain: string, name: string, user: string) => {
      members(domain, name).delete(user);
    }),
  };
  publish = vi.fn().mockResolvedValue(undefined);
});

describe('space service', () => {
  it('provisions a space of an organization whose mail domain is validated', async () => {
    await service().dnsValidated(validated());
    await service().spaceCreated(created());

    expect(tmail.createTeamMailbox).toHaveBeenCalledWith('acme.com', 'sales-eu');
    expect(tmail.addMember.mock.calls).toEqual(
      expect.arrayContaining([
        ['acme.com', 'sales-eu', 'jane@acme.com', 'manager'],
        ['acme.com', 'sales-eu', 'bob@acme.com', 'member'],
      ]),
    );
    expect(tmail.addMember).toHaveBeenCalledTimes(2);
    expect(await provisioned()).toEqual([
      {
        id: `${SPACE}:id-sales-eu:provisioned`,
        organizationId: 'acme',
        spaceId: SPACE,
        mailboxId: 'id-sales-eu',
      },
    ]);
    const [stored] = await client.db.select().from(spaces).where(eq(spaces.spaceId, SPACE));
    expect(stored).toMatchObject({ address: 'sales-eu@acme.com', mailboxId: 'id-sales-eu' });
  });

  it("names the team mailbox with the deployment's prefix", async () => {
    const prefixed = createSpaceService({
      db: client.db,
      lock: client.withLock,
      tmail,
      activity: createActivity('activity'),
      logger: silentLogger,
      addressPrefix: 'space-',
    });
    await prefixed.dnsValidated(validated());
    await prefixed.spaceCreated(created());

    expect(tmail.createTeamMailbox).toHaveBeenCalledWith('acme.com', 'space-sales-eu');
    const [stored] = await client.db.select().from(spaces).where(eq(spaces.spaceId, SPACE));
    expect(stored).toMatchObject({ address: 'space-sales-eu@acme.com' });
  });

  it("skips a mailing list's address, but not when resuming with the stored one", async () => {
    tmail.isMailingList.mockImplementation(async (address) => address === 'sales-eu@acme.com');
    tmail.rootMailboxId.mockRejectedValueOnce(new Error('TMail down'));
    await service().dnsValidated(validated());
    await expect(service().spaceCreated(created())).rejects.toThrow('TMail down');

    expect(tmail.createTeamMailbox).toHaveBeenCalledWith('acme.com', 'sales-eu-2');
    expect(tmail.createTeamMailbox).not.toHaveBeenCalledWith('acme.com', 'sales-eu');

    tmail.isMailingList.mockResolvedValue(true);
    await service().spaceCreated(created());

    const [stored] = await client.db.select().from(spaces).where(eq(spaces.spaceId, SPACE));
    expect(stored).toMatchObject({ address: 'sales-eu-2@acme.com', mailboxId: 'id-sales-eu-2' });
  });

  it('provisions a space once when two events about it are handled at the same time', async () => {
    tmail.createTeamMailbox.mockImplementation(() => new Promise((r) => setTimeout(r, 50)));
    await service().dnsValidated(validated());

    await Promise.all([
      service().spaceCreated(created()),
      service().spaceSynced(synced('2026-10-06T10:00:01Z', created().members)),
    ]);

    expect(tmail.createTeamMailbox).toHaveBeenCalledTimes(1);
    expect(await provisioned()).toHaveLength(1);
  });

  it('keeps a space waiting until its mail domain is validated', async () => {
    await service().spaceCreated(created());
    expect(tmail.createTeamMailbox).not.toHaveBeenCalled();

    await service().memberAdded(
      memberEvent('44444444-4444-4444-8444-444444444444', 'al@acme.com', 'editor'),
    );
    await service().dnsValidated(validated(false));
    expect(tmail.createTeamMailbox).not.toHaveBeenCalled();

    await service().dnsValidated(validated());
    expect(tmail.createTeamMailbox).toHaveBeenCalledWith('acme.com', 'sales-eu');
    expect(tmail.addMember).toHaveBeenCalledWith('acme.com', 'sales-eu', 'al@acme.com', 'member');
    expect(await provisioned()).toHaveLength(1);
  });

  it('provisions a space once, whatever the number of dns.validated events', async () => {
    await service().dnsValidated(validated());
    await service().spaceCreated(created());
    await service().dnsValidated(validated());

    expect(tmail.createTeamMailbox).toHaveBeenCalledOnce();
    expect(await provisioned()).toHaveLength(1);
  });

  it('adds a number when another space or a TMail user holds the address', async () => {
    await service().dnsValidated(validated());
    await service().spaceCreated(created(OTHER_SPACE));
    tmail.listTeamMailboxes.mockResolvedValue(['sales-eu']);
    tmail.createTeamMailbox.mockImplementation(async (_d: string, name: string) => {
      if (name === 'sales-eu-2') throw new AddressTakenError(409, 'held by a user');
    });

    await service().spaceCreated(created());

    expect((await provisioned()).at(-1)).toEqual(
      expect.objectContaining({ spaceId: SPACE, mailboxId: 'id-sales-eu-3' }),
    );
  });

  it('resumes with the same address after a failure', async () => {
    await service().dnsValidated(validated());
    tmail.addMember.mockRejectedValueOnce(new Error('tmail down'));

    await expect(service().spaceCreated(created())).rejects.toThrow('tmail down');
    await service().spaceCreated(created());

    expect(tmail.createTeamMailbox.mock.calls).toEqual([
      ['acme.com', 'sales-eu'],
      ['acme.com', 'sales-eu'],
    ]);
    expect(await provisioned()).toHaveLength(1);
  });

  it('picks another address when the stored one was taken in TMail meanwhile', async () => {
    await service().dnsValidated(validated());
    tmail.addMember.mockRejectedValueOnce(new Error('tmail down'));
    await expect(service().spaceCreated(created())).rejects.toThrow('tmail down');

    tmail.createTeamMailbox.mockImplementation(async (_d: string, name: string) => {
      if (name === 'sales-eu') throw new AddressTakenError(409, 'held by a user');
    });
    await service().spaceCreated(created());

    expect(await provisioned()).toContainEqual(
      expect.objectContaining({ mailboxId: 'id-sales-eu-2' }),
    );
  });

  it('dead letters a space whose address is a team mailbox no space holds', async () => {
    await service().dnsValidated(validated());
    tmail.listTeamMailboxes.mockResolvedValue(['sales-eu']);

    await expect(service().spaceCreated(created())).rejects.toBeInstanceOf(RejectedEventError);

    expect(tmail.createTeamMailbox).not.toHaveBeenCalled();
    expect(await provisioned()).toEqual([]);
    const [stored] = await client.db.select().from(spaces).where(eq(spaces.spaceId, SPACE));
    expect(stored).toMatchObject({ address: null, provisionedAt: null });
  });

  it('does not take its own stored team mailbox for another space', async () => {
    await service().dnsValidated(validated());
    tmail.addMember.mockRejectedValueOnce(new Error('tmail down'));
    await expect(service().spaceCreated(created())).rejects.toThrow('tmail down');

    tmail.listTeamMailboxes.mockResolvedValue(['sales-eu']);
    tmail.createTeamMailbox.mockRejectedValue(new AddressTakenError(409, 'held by a user'));
    await expect(service().spaceCreated(created())).rejects.toBeInstanceOf(RejectedEventError);

    expect(tmail.createTeamMailbox).not.toHaveBeenCalledWith('acme.com', 'sales-eu-2');
  });

  it('provisions a space linked by hand to an existing team mailbox', async () => {
    await service().dnsValidated(validated());
    tmail.listTeamMailboxes.mockResolvedValue(['sales-eu']);
    await expect(service().spaceCreated(created())).rejects.toBeInstanceOf(RejectedEventError);

    await tmail.addMember('acme.com', 'sales-eu', 'gone@acme.com', 'manager');
    await client.db
      .update(spaces)
      .set({ address: 'sales-eu@acme.com' })
      .where(eq(spaces.spaceId, SPACE));
    await service().spaceSynced(synced('2026-10-06T12:00:00Z', created().members));

    expect(tmail.createTeamMailbox.mock.calls).toEqual([['acme.com', 'sales-eu']]);
    expect(await tmail.listMembers('acme.com', 'sales-eu')).toEqual([
      { username: 'jane@acme.com', role: 'manager' },
      { username: 'bob@acme.com', role: 'member' },
    ]);
    expect(await provisioned()).toContainEqual(
      expect.objectContaining({ spaceId: SPACE, mailboxId: 'id-sales-eu' }),
    );
  });

  it('provisions the other waiting spaces when one fails', async () => {
    await service().spaceCreated(created());
    await service().spaceCreated(created(OTHER_SPACE, 'Support'));
    tmail.createTeamMailbox.mockImplementation(async (_d: string, name: string) => {
      if (name === 'sales-eu') throw new Error('tmail down');
    });

    await expect(service().dnsValidated(validated())).rejects.toThrow('tmail down');

    expect(await provisioned()).toHaveLength(1);
    expect(await provisioned()).toContainEqual(
      expect.objectContaining({ spaceId: OTHER_SPACE, mailboxId: 'id-support' }),
    );
  });

  it('retries a DNS event when one space failed and another was dead lettered', async () => {
    await service().spaceCreated(created());
    await service().spaceCreated(created(OTHER_SPACE, 'Support'));
    tmail.listTeamMailboxes.mockResolvedValue(['sales-eu']);
    tmail.createTeamMailbox.mockRejectedValue(new Error('tmail down'));

    await expect(service().dnsValidated(validated())).rejects.toThrow('tmail down');
  });

  it('follows member changes once provisioned', async () => {
    await service().dnsValidated(validated());
    await service().spaceCreated(created());
    tmail.addMember.mockClear();

    await service().memberRoleChanged(memberEvent(BOB, 'bob@acme.com', 'admin'));
    await service().memberRoleChanged(memberEvent(JANE, 'jane@acme.com', 'viewer'));
    await service().memberRoleChanged(memberEvent(VIC, 'vic@acme.com', 'editor'));
    await service().memberRemoved(memberEvent(BOB, 'bob@acme.com', 'admin'));

    expect(tmail.addMember.mock.calls).toEqual([
      ['acme.com', 'sales-eu', 'bob@acme.com', 'manager'],
      ['acme.com', 'sales-eu', 'vic@acme.com', 'member'],
    ]);
    expect(tmail.removeMember.mock.calls).toEqual([
      ['acme.com', 'sales-eu', 'jane@acme.com'],
      ['acme.com', 'sales-eu', 'bob@acme.com'],
    ]);
  });

  it('removes a deleted user from every team mailbox', async () => {
    await service().dnsValidated(validated());
    await service().spaceCreated(created());
    await service().spaceCreated(created(OTHER_SPACE, 'Support'));

    await service().userDeleted({
      uuid: BOB,
      internalEmail: 'bob@acme.com',
      organizationId: 'acme',
    });

    expect(tmail.removeMember.mock.calls).toEqual(
      expect.arrayContaining([
        ['acme.com', 'sales-eu', 'bob@acme.com'],
        ['acme.com', 'support', 'bob@acme.com'],
      ]),
    );
    await service().memberAdded(memberEvent(BOB, 'bob@acme.com', 'editor'));
    expect(tmail.addMember).toHaveBeenLastCalledWith(
      'acme.com',
      'sales-eu',
      'bob@acme.com',
      'member',
    );
  });

  it('retries a user deletion that TMail failed', async () => {
    await service().dnsValidated(validated());
    await service().spaceCreated(created());
    tmail.removeMember.mockRejectedValueOnce(new Error('tmail down'));
    const deleted = { uuid: BOB, internalEmail: 'bob@acme.com', organizationId: 'acme' };

    await expect(service().userDeleted(deleted)).rejects.toThrow('tmail down');
    await service().userDeleted(deleted);

    expect(tmail.removeMember).toHaveBeenCalledTimes(2);
  });

  it('gives a waiting space the address of its new name', async () => {
    await service().spaceCreated(created());
    await service().spaceRenamed(renamed('Sales World'));
    await expect(
      service().spaceRenamed(renamed('Sales Old', '2026-10-06T10:30:00Z')),
    ).resolves.toBe('stale');
    await service().dnsValidated(validated());

    expect(tmail.createTeamMailbox).toHaveBeenCalledWith('acme.com', 'sales-world');
  });

  it('keeps the address of a provisioned space it renames', async () => {
    await service().dnsValidated(validated());
    await service().spaceCreated(created());
    await service().spaceRenamed(renamed('Sales World'));

    const [stored] = await client.db.select().from(spaces).where(eq(spaces.spaceId, SPACE));
    expect(stored).toMatchObject({ name: 'Sales World', address: 'sales-eu@acme.com' });
  });

  it('removes every member of a deleted space, then deletes its mailbox 30 days later', async () => {
    await service().dnsValidated(validated());
    await service().spaceCreated(created());
    const deleted = { organizationId: 'acme', id: SPACE };

    await service().spaceDeleted(deleted);
    await service().spaceDeleted(deleted);
    await service().memberAdded(memberEvent(BOB, 'bob@acme.com', 'editor'));

    expect(tmail.removeMember.mock.calls).toEqual([
      ['acme.com', 'sales-eu', 'jane@acme.com'],
      ['acme.com', 'sales-eu', 'bob@acme.com'],
    ]);
    expect(tmail.addMember).toHaveBeenCalledTimes(2);

    const day = 24 * 60 * 60 * 1000;
    await service().purgeDeleted(new Date(Date.now() + 29 * day));
    expect(tmail.deleteTeamMailbox).not.toHaveBeenCalled();

    await service().purgeDeleted(new Date(Date.now() + 31 * day));
    expect(tmail.deleteTeamMailbox).toHaveBeenCalledWith('acme.com', 'sales-eu');
    expect(await client.db.select().from(spaces)).toEqual([
      expect.objectContaining({ spaceId: SPACE, address: null }),
    ]);
  });

  it('does not bring back a deleted space a replayed event names', async () => {
    await service().dnsValidated(validated());
    await service().spaceCreated(created());
    await service().spaceDeleted({ organizationId: 'acme', id: SPACE });
    await service().purgeDeleted(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000));
    tmail.createTeamMailbox.mockClear();
    tmail.removeMember.mockClear();

    await service().spaceCreated(created());
    await service().spaceSynced(
      synced('2026-10-06T10:00:00Z', [member(JANE, 'jane@acme.com', 'admin')]),
    );
    await service().userDeleted({ uuid: JANE });

    expect(tmail.createTeamMailbox).not.toHaveBeenCalled();
    expect(tmail.removeMember).not.toHaveBeenCalled();
    expect(await client.db.select().from(spaceMembers)).toEqual([]);
  });

  it('records when a space was deleted', async () => {
    await service().spaceCreated(created());

    await service().spaceDeleted({
      organizationId: 'acme',
      id: SPACE,
      timestamp: '2026-10-06T12:00:00Z',
    });

    const [stored] = await client.db.select().from(spaces);
    expect(stored?.lastEventAt).toEqual(new Date('2026-10-06T12:00:00Z'));
  });

  it('holds the address of a deleted space until its mailbox is deleted', async () => {
    await service().dnsValidated(validated());
    await service().spaceCreated(created());
    await service().spaceDeleted({ organizationId: 'acme', id: SPACE });

    await service().spaceCreated(created(OTHER_SPACE));

    expect((await provisioned()).at(-1)).toEqual(
      expect.objectContaining({ spaceId: OTHER_SPACE, mailboxId: 'id-sales-eu-2' }),
    );
  });

  it('retries a space deletion that TMail failed', async () => {
    await service().dnsValidated(validated());
    await service().spaceCreated(created());
    tmail.removeMember.mockRejectedValueOnce(new Error('tmail down'));
    const deleted = { organizationId: 'acme', id: SPACE };

    await expect(service().spaceDeleted(deleted)).rejects.toThrow('tmail down');
    await service().spaceDeleted(deleted);

    expect(tmail.removeMember).toHaveBeenCalledTimes(3);
  });

  it('keeps a mailbox TMail failed to delete for the next purge', async () => {
    await service().dnsValidated(validated());
    await service().spaceCreated(created());
    await service().spaceDeleted({ organizationId: 'acme', id: SPACE });
    tmail.deleteTeamMailbox.mockRejectedValueOnce(new Error('tmail down'));
    const later = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);

    await service().purgeDeleted(later);
    expect(await client.db.select().from(spaces)).toHaveLength(1);

    await service().purgeDeleted(later);
    expect(await client.db.select().from(spaces)).toEqual([
      expect.objectContaining({ address: null }),
    ]);
  });

  it('never provisions a deleted space that had no mailbox yet', async () => {
    await service().spaceCreated(created());
    await service().spaceDeleted({ organizationId: 'acme', id: SPACE });
    await service().spaceCreated(created());
    await service().dnsValidated(validated());

    expect(tmail.listMembers).not.toHaveBeenCalled();
    expect(tmail.createTeamMailbox).not.toHaveBeenCalled();
  });

  it('ignores a member event older than the last one applied', async () => {
    await service().dnsValidated(validated());
    await service().spaceCreated(created());
    await service().memberRoleChanged(memberEvent(BOB, 'bob@acme.com', 'admin'));
    tmail.addMember.mockClear();

    await service().memberRemoved(
      memberEvent(BOB, 'bob@acme.com', 'admin', '2026-10-06T10:30:00Z'),
    );
    await service().memberRoleChanged(memberEvent(BOB, 'bob@acme.com', 'viewer'));

    expect(tmail.removeMember.mock.calls).toEqual([['acme.com', 'sales-eu', 'bob@acme.com']]);
  });

  it('makes the team mailbox match a synced space', async () => {
    await service().dnsValidated(validated());
    await service().spaceCreated(created());
    tmail.addMember.mockClear();
    tmail.listMembers.mockResolvedValue([
      { username: 'jane@acme.com', role: 'manager' },
      { username: 'bob@acme.com', role: 'member' },
      { username: 'eve@acme.com', role: 'member' },
    ]);

    await service().spaceSynced(
      synced('2026-10-07T02:00:00Z', [
        member(JANE, 'jane@acme.com', 'admin'),
        member(BOB, 'bob@acme.com', 'admin'),
        member(VIC, 'vic@acme.com', 'editor'),
      ]),
    );

    expect(tmail.addMember.mock.calls).toEqual([
      ['acme.com', 'sales-eu', 'bob@acme.com', 'manager'],
      ['acme.com', 'sales-eu', 'vic@acme.com', 'member'],
    ]);
    expect(tmail.removeMember.mock.calls).toEqual([['acme.com', 'sales-eu', 'eve@acme.com']]);
    expect(tmail.createTeamMailbox).toHaveBeenCalledOnce();
  });

  it('provisions a synced space it never heard of', async () => {
    await service().dnsValidated(validated());

    await service().spaceSynced(
      synced('2026-10-07T02:00:00Z', [member(JANE, 'jane@acme.com', 'admin')], 'Old Space'),
    );

    expect(tmail.createTeamMailbox).toHaveBeenCalledWith('acme.com', 'old-space');
    expect(tmail.addMember).toHaveBeenCalledWith(
      'acme.com',
      'old-space',
      'jane@acme.com',
      'manager',
    );
    expect(await provisioned()).toHaveLength(1);
  });

  it('ignores a synced space older than the last event applied', async () => {
    await service().dnsValidated(validated());
    await service().spaceCreated(created());
    tmail.listMembers.mockClear();

    await service().spaceSynced(synced('2026-10-06T09:00:00Z', []));

    expect(tmail.listMembers).not.toHaveBeenCalled();
    expect(tmail.removeMember).not.toHaveBeenCalled();
  });

  it('keeps the spaces a DNS event provisioned when another one fails in the database', async () => {
    await service().spaceCreated(created());
    await service().spaceCreated(created(OTHER_SPACE, 'Support'));
    tmail.rootMailboxId.mockResolvedValue('same-id');

    await expect(service().dnsValidated(validated())).rejects.toThrow();

    expect((await provisioned()).map((p) => p.spaceId)).toHaveLength(1);
  });

  it('does not create a space whose deletion came first', async () => {
    await service().spaceDeleted({
      organizationId: 'acme',
      id: SPACE,
      timestamp: '2026-10-06T12:00:00Z',
    });
    await service().dnsValidated(validated());

    await service().spaceCreated(created());
    await service().spaceSynced(synced('2026-10-06T13:00:00Z', []));

    expect(tmail.createTeamMailbox).not.toHaveBeenCalled();
  });

  it('leaves a deleted space out of the spaces a DNS event provisions or renames', async () => {
    await service().spaceCreated(created());
    await service().spaceDeleted({ organizationId: 'acme', id: SPACE });
    await service().spaceRenamed(renamed('Other', '2026-10-06T12:00:00Z'));
    const findSpace = vi.spyOn(tmail, 'listTeamMailboxes');

    await service().dnsValidated(validated());

    expect(findSpace).not.toHaveBeenCalled();
    const [stored] = await client.db.select().from(spaces);
    expect(stored?.name).toBe('Sales EU');
  });

  it('closes the spaces a completed sync no longer lists, not the newer ones', async () => {
    await service().dnsValidated(validated());
    await service().spaceCreated(created());
    await service().spaceCreated({
      ...created(OTHER_SPACE, 'Support'),
      timestamp: '2026-10-07T03:00:00Z',
    });

    await service().syncCompleted({
      organizationId: 'acme',
      spaceIds: [],
      timestamp: '2026-10-07T02:00:00Z',
    });

    const stored = await client.db.select().from(spaces);
    expect(stored.find((s) => s.spaceId === SPACE)?.deletedAt).toBeInstanceOf(Date);
    expect(stored.find((s) => s.spaceId === OTHER_SPACE)?.deletedAt).toBeNull();
  });

  it('keeps a space newer than the sync while its provisioning waits for a retry', async () => {
    await service().dnsValidated(validated());
    tmail.createTeamMailbox.mockRejectedValueOnce(new Error('tmail down'));
    await expect(
      service().spaceCreated({ ...created(), timestamp: '2026-10-07T03:00:00Z' }),
    ).rejects.toThrow('tmail down');

    await service().syncCompleted({
      organizationId: 'acme',
      spaceIds: [],
      timestamp: '2026-10-07T02:00:00Z',
    });

    const [stored] = await client.db.select().from(spaces);
    expect(stored?.deletedAt).toBeNull();
  });

  it('keeps the spaces a completed sync lists', async () => {
    await service().dnsValidated(validated());
    await service().spaceCreated(created());

    await service().syncCompleted({
      organizationId: 'acme',
      spaceIds: [SPACE],
      timestamp: '2026-10-07T02:00:00Z',
    });

    expect(tmail.removeMember).not.toHaveBeenCalled();
  });

  it('tells whether it stores any space', async () => {
    expect(await service().hasSpaces()).toBe(false);
    await service().spaceCreated(created());
    expect(await service().hasSpaces()).toBe(true);
  });

  it('parks the member and rename events of a space it does not know yet', async () => {
    await expect(
      service().memberAdded(memberEvent(BOB, 'bob@acme.com', 'editor')),
    ).rejects.toBeInstanceOf(NotYetKnownError);
    await expect(service().spaceRenamed(renamed('Sales'))).rejects.toBeInstanceOf(NotYetKnownError);
    expect(tmail.addMember).not.toHaveBeenCalled();
  });

  it('applies a member event that arrives after a newer one about another member', async () => {
    await service().dnsValidated(validated());
    await service().spaceCreated(created());

    await service().memberAdded(
      memberEvent('44444444-4444-4444-8444-444444444444', 'al@acme.com', 'editor'),
    );
    await service().memberAdded(
      memberEvent(
        '55555555-5555-4555-8555-555555555555',
        'cat@acme.com',
        'editor',
        '2026-10-06T10:30:00Z',
      ),
    );

    expect(tmail.addMember).toHaveBeenCalledWith('acme.com', 'sales-eu', 'cat@acme.com', 'member');
  });

  it('does not add back a member whose newer removal came first', async () => {
    await service().dnsValidated(validated());
    await service().spaceCreated(created());

    await service().memberRemoved(memberEvent(BOB, 'bob@acme.com', 'editor'));
    await expect(
      service().memberAdded(memberEvent(BOB, 'bob@acme.com', 'editor', '2026-10-06T10:30:00Z')),
    ).resolves.toBe('stale');
    await service().spaceSynced(synced('2026-10-06T10:45:00Z', created().members));

    expect(await tmail.listMembers('acme.com', 'sales-eu')).not.toContainEqual(
      expect.objectContaining({ username: 'bob@acme.com' }),
    );
  });
});

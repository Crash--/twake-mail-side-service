import { DeadLetterError } from '@linagora/rabbitmq-client';
import { and, eq, inArray, isNotNull, isNull, lt, lte, ne, notInArray, or, sql } from 'drizzle-orm';
import type { Activity } from '../../events/activity.js';
import { NotYetKnownError, RejectedEventError } from '../../events/errors.js';
import { enqueue } from '../../events/outbox.js';
import type { Db, Lock } from '../../infra/db.js';
import type { Logger } from '../../infra/logger.js';
import { AddressTakenError, type TeamMailboxRole, type TmailClient } from '../../product/port.js';
import { candidateNames, mailboxName } from './address.js';
import {
  dnsValidated,
  memberChanged,
  parseEvent,
  spaceCreated,
  spaceDeleted,
  spaceRenamed,
  syncCompleted,
  userDeleted,
  type SpaceRole,
} from './events.js';
import { organizations, spaceMembers, spaces } from './schema.js';

export interface SpaceService {
  hasSpaces(): Promise<boolean>;
  spaceCreated(body: unknown): Promise<'stale' | void>;
  spaceSynced(body: unknown): Promise<'stale' | void>;
  syncCompleted(body: unknown): Promise<void>;
  spaceRenamed(body: unknown): Promise<'stale' | void>;
  spaceDeleted(body: unknown): Promise<void>;
  purgeDeleted(now?: Date): Promise<void>;
  memberAdded(body: unknown): Promise<'stale' | void>;
  memberRoleChanged(body: unknown): Promise<'stale' | void>;
  memberRemoved(body: unknown): Promise<'stale' | void>;
  dnsValidated(body: unknown): Promise<void>;
  userDeleted(body: unknown): Promise<void>;
}

interface SpaceServiceDeps {
  db: Db;
  lock: Lock;
  tmail: TmailClient;
  activity: Activity;
  logger: Logger;
  addressPrefix: string;
}

// TMail team mailboxes have no read-only access, so viewers get none.
const TMAIL_ROLES: Record<SpaceRole, TeamMailboxRole | undefined> = {
  admin: 'manager',
  editor: 'member',
  viewer: undefined,
};

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const UNIQUE_VIOLATION = '23505';

const isUniqueViolation = (err: unknown): boolean => {
  for (let e = err; e instanceof Error; e = e.cause) {
    if ('code' in e && e.code === UNIQUE_VIOLATION) return true;
  }
  return false;
};

const splitAddress = (address: string) => {
  const at = address.lastIndexOf('@');
  return { name: address.slice(0, at), domain: address.slice(at + 1) };
};

// A late or redelivered event must not undo a newer one; equal timestamps apply in arrival order.
const isStale = (space: { lastEventAt: Date | null } | undefined, timestamp: string) =>
  Boolean(space?.lastEventAt && new Date(timestamp) < space.lastEventAt);

type Member = { email: string; role: SpaceRole };

export const createSpaceService = ({
  db,
  lock,
  tmail,
  activity,
  logger,
  addressPrefix,
}: SpaceServiceDeps): SpaceService => {
  // Events about one space run one at a time, across replicas, from reading it to the last
  // TMail call; each reads the space again once it holds the lock.
  const locked = <T>(spaceId: string, fn: () => Promise<T>) => lock(`space:${spaceId}`, fn);

  const findSpace = async (spaceId: string) => {
    const [space] = await db.select().from(spaces).where(eq(spaces.spaceId, spaceId));
    return space;
  };

  const pickAddress = async (spaceId: string, name: string, domain: string): Promise<string> => {
    const candidates = candidateNames(name);
    const toAddress = (candidate: string) => `${candidate}@${domain}`;
    // Spaces before TMail: the purge deletes the mailbox before it clears the address, so a
    // purged mailbox is never seen in TMail without its space.
    const held = await db
      .select({ address: spaces.address })
      .from(spaces)
      .where(and(inArray(spaces.address, candidates.map(toAddress)), ne(spaces.spaceId, spaceId)));
    const heldBySpace = new Set(held.map((s) => s.address));
    const inTmail = new Set(await tmail.listTeamMailboxes(domain));
    for (const candidate of candidates) {
      const address = toAddress(candidate);
      if (inTmail.has(candidate)) {
        if (heldBySpace.has(address)) continue;
        // Another space may have stored it and created the mailbox after the read above.
        const [holder] = await db
          .select({ spaceId: spaces.spaceId })
          .from(spaces)
          .where(and(eq(spaces.address, address), ne(spaces.spaceId, spaceId)));
        if (holder) continue;
        // It may be this space's mailbox from a lost row: only a person can tell.
        throw new RejectedEventError(
          `${address} is a team mailbox no space holds, store it as space ${spaceId}'s address to use it`,
        );
      }
      // Only for a new address: a stored one may already be this space's mailbox.
      if (await tmail.isMailingList(address)) {
        logger.info({ spaceId, address }, 'address held by a mailing list, trying the next one');
        continue;
      }
      try {
        // Stored before TMail is called, so a retry resumes with the same address.
        await db.update(spaces).set({ address }).where(eq(spaces.spaceId, spaceId));
      } catch (err) {
        if (isUniqueViolation(err)) continue;
        throw err;
      }
      try {
        await tmail.createTeamMailbox(domain, candidate);
        return address;
      } catch (err) {
        if (!(err instanceof AddressTakenError)) throw err;
        logger.info(
          { spaceId, address },
          'address held by a user, alias or group, trying the next one',
        );
      }
    }
    throw new Error(`no free team mailbox address for ${name}@${domain}`);
  };

  const provision = async (spaceId: string): Promise<void> => {
    const space = await findSpace(spaceId);
    if (!space || space.provisionedAt || space.deletedAt) return;
    const [organization] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.organizationId, space.organizationId));
    if (!organization?.mailValidated) {
      logger.info({ spaceId }, 'mail domain not validated yet, the space waits');
      return;
    }

    let address = space.address;
    if (address) {
      const { name, domain } = splitAddress(address);
      try {
        await tmail.createTeamMailbox(domain, name);
      } catch (err) {
        if (!(err instanceof AddressTakenError)) throw err;
        address = null;
      }
    }
    address ??= await pickAddress(
      spaceId,
      mailboxName(space.name, addressPrefix),
      organization.domain,
    );

    const { name, domain } = splitAddress(address);
    // The mailbox may predate the space's row, linked by hand, with members it no longer has.
    await matchMembers(address, await liveMembers(spaceId));

    const mailboxId = await tmail.rootMailboxId(domain, name);
    await db.transaction(async (tx) => {
      // A lock connection lost mid-run frees the space to another replica, which provisions it too.
      const updated = await tx
        .update(spaces)
        .set({ mailboxId, provisionedAt: sql`now()` })
        .where(and(eq(spaces.spaceId, spaceId), isNull(spaces.provisionedAt)))
        .returning({ spaceId: spaces.spaceId });
      if (!updated.length) return;
      await enqueue(
        tx,
        activity.provisioned({ organizationId: space.organizationId, spaceId, mailboxId }),
      );
    });
    logger.info({ spaceId, address, mailboxId }, 'team mailbox provisioned');
  };

  const syncMember = async (address: string | null, email: string, role: SpaceRole | undefined) => {
    if (!address) return;
    const { name, domain } = splitAddress(address);
    const tmailRole = role && TMAIL_ROLES[role];
    if (tmailRole) await tmail.addMember(domain, name, email, tmailRole);
    else await tmail.removeMember(domain, name, email);
  };

  const applied = (spaceId: string, timestamp: string) =>
    db
      .update(spaces)
      .set({ lastEventAt: sql`greatest(${spaces.lastEventAt}, ${timestamp}::timestamptz)` })
      .where(eq(spaces.spaceId, spaceId));

  // TMail is read rather than the stored members, so a member added there by hand is removed too.
  const matchMembers = async (address: string, members: Member[]) => {
    const { name, domain } = splitAddress(address);
    const wanted = new Map<string, { email: string; role: TeamMailboxRole }>();
    for (const m of members) {
      const role = TMAIL_ROLES[m.role];
      if (role) wanted.set(m.email.toLowerCase(), { email: m.email, role });
    }
    for (const { username, role } of await tmail.listMembers(domain, name)) {
      const want = wanted.get(username.toLowerCase());
      if (!want) await tmail.removeMember(domain, name, username);
      else if (want.role === role) wanted.delete(username.toLowerCase());
    }
    for (const { email, role } of wanted.values()) await tmail.addMember(domain, name, email, role);
  };

  const closeSpace = async (spaceId: string) => {
    const space = await findSpace(spaceId);
    if (!space || space.deletedAt) return;
    // TMail first: a failed call retries the event with the space still live.
    if (space.address) await matchMembers(space.address, []);
    // The row outlives the space, so a replayed creation cannot bring it back.
    await db.transaction(async (tx) => {
      await tx.delete(spaceMembers).where(eq(spaceMembers.spaceId, space.spaceId));
      await tx
        .update(spaces)
        .set({ deletedAt: sql`now()` })
        .where(eq(spaces.spaceId, space.spaceId));
    });
    logger.info({ spaceId: space.spaceId, address: space.address }, 'team mailbox closed');
  };

  // One failing space must not hold back the others; the retry only redoes the failed ones.
  // A retryable failure wins over a dead letter, or the event would be dropped with it.
  const eachSpace = async (spaceIds: string[], apply: (spaceId: string) => Promise<void>) => {
    const failures: unknown[] = [];
    for (const spaceId of spaceIds) {
      try {
        await apply(spaceId);
      } catch (err) {
        logger.error({ err, spaceId }, 'space update failed');
        failures.push(err);
      }
    }
    if (failures.length) {
      throw failures.find((err) => !(err instanceof DeadLetterError)) ?? failures[0];
    }
  };

  // Freshness is kept per member: an event about one member must not be dropped because a newer
  // one about another member was handled first.
  const storeMember = async (
    db: Db,
    spaceId: string,
    member: Member & { uuid: string },
    removed: boolean,
    timestamp: string,
  ) => {
    const values = {
      email: member.email,
      role: member.role,
      removedAt: removed ? sql`now()` : null,
      lastEventAt: new Date(timestamp),
    };
    const changed = await db
      .insert(spaceMembers)
      .values({ spaceId, userId: member.uuid, ...values })
      .onConflictDoUpdate({
        target: [spaceMembers.spaceId, spaceMembers.userId],
        set: values,
        setWhere: notNewerThan(timestamp),
      })
      .returning({ userId: spaceMembers.userId });
    return changed.length > 0;
  };

  const notNewerThan = (timestamp: string) =>
    or(isNull(spaceMembers.lastEventAt), lte(spaceMembers.lastEventAt, new Date(timestamp)));

  const liveMembers = (spaceId: string) =>
    db
      .select()
      .from(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, spaceId), isNull(spaceMembers.removedAt)));

  const onMember = (removed: boolean) => async (body: unknown) => {
    const event = parseEvent(memberChanged, body);
    return locked(event.id, async () => {
      const space = await findSpace(event.id);
      if (!space) throw new NotYetKnownError(`space ${event.id} is not known yet`);
      if (space.deletedAt) return 'stale';
      let stale = event.members.length > 0;
      for (const member of event.members) {
        if (!(await storeMember(db, event.id, member, removed, event.timestamp))) continue;
        stale = false;
        if (space.provisionedAt) {
          await syncMember(space.address, member.email, removed ? undefined : member.role);
        }
      }
      if (stale) return 'stale';
    });
  };

  return {
    async hasSpaces() {
      const [space] = await db.select({ spaceId: spaces.spaceId }).from(spaces).limit(1);
      return Boolean(space);
    },

    async spaceCreated(body) {
      const event = parseEvent(spaceCreated, body);
      return locked(event.id, async () => {
        const space = await findSpace(event.id);
        if (space?.deletedAt || isStale(space, event.timestamp)) return 'stale';
        await db.transaction(async (tx) => {
          await tx
            .insert(spaces)
            .values({ spaceId: event.id, organizationId: event.organizationId, name: event.name })
            .onConflictDoNothing();
          if (event.members.length) {
            await tx
              .insert(spaceMembers)
              .values(
                event.members.map((m) => ({
                  spaceId: event.id,
                  userId: m.uuid,
                  email: m.email,
                  role: m.role,
                  lastEventAt: new Date(event.timestamp),
                })),
              )
              .onConflictDoNothing();
          }
        });
        // Before TMail: a sync completed while a failed provisioning waits for its retry must
        // find the space newer than its snapshot.
        await applied(event.id, event.timestamp);
        await provision(event.id);
      });
    },

    async spaceSynced(body) {
      const event = parseEvent(spaceCreated, body);
      return locked(event.id, async () => {
        const space = await findSpace(event.id);
        if (space?.deletedAt || isStale(space, event.timestamp)) return 'stale';
        await db.transaction(async (tx) => {
          await tx
            .insert(spaces)
            .values({ spaceId: event.id, organizationId: event.organizationId, name: event.name })
            .onConflictDoUpdate({ target: spaces.spaceId, set: { name: event.name } });
          for (const member of event.members) {
            await storeMember(tx, event.id, member, false, event.timestamp);
          }
          // Members the snapshot leaves out are removed, unless a newer event added them.
          await tx
            .update(spaceMembers)
            .set({ removedAt: sql`now()`, lastEventAt: new Date(event.timestamp) })
            .where(
              and(
                eq(spaceMembers.spaceId, event.id),
                isNull(spaceMembers.removedAt),
                notNewerThan(event.timestamp),
                notInArray(
                  spaceMembers.userId,
                  event.members.map((m) => m.uuid),
                ),
              ),
            );
        });
        await applied(event.id, event.timestamp);
        if (space?.provisionedAt && space.address) {
          await matchMembers(space.address, await liveMembers(event.id));
        } else await provision(event.id);
      });
    },

    async syncCompleted(body) {
      const event = parseEvent(syncCompleted, body);
      const gone = await db
        .select({ spaceId: spaces.spaceId })
        .from(spaces)
        .where(
          and(
            eq(spaces.organizationId, event.organizationId),
            isNull(spaces.deletedAt),
            event.spaceIds.length ? notInArray(spaces.spaceId, event.spaceIds) : undefined,
          ),
        );
      await eachSpace(
        gone.map((s) => s.spaceId),
        (spaceId) =>
          locked(spaceId, async () => {
            // A space created after the snapshot is not listed yet, and stays.
            if (isStale(await findSpace(spaceId), event.timestamp)) return;
            await closeSpace(spaceId);
          }),
      );
    },

    // The address is picked at provisioning, so a rename only matters to a space still waiting.
    async spaceRenamed(body) {
      const event = parseEvent(spaceRenamed, body);
      return locked(event.id, async () => {
        const space = await findSpace(event.id);
        if (!space) throw new NotYetKnownError(`space ${event.id} is not known yet`);
        if (space.deletedAt || isStale(space, event.timestamp)) return 'stale';
        await db.update(spaces).set({ name: event.name }).where(eq(spaces.spaceId, event.id));
        await applied(event.id, event.timestamp);
      });
    },

    async spaceDeleted(body) {
      const event = parseEvent(spaceDeleted, body);
      await locked(event.id, async () => {
        // A deletion that overtook the creation leaves a row, so the creation finds it deleted.
        if (event.organizationId) {
          await db
            .insert(spaces)
            .values({
              spaceId: event.id,
              organizationId: event.organizationId,
              name: '',
              deletedAt: sql`now()`,
            })
            .onConflictDoNothing();
        }
        await closeSpace(event.id);
        if (event.timestamp) await applied(event.id, event.timestamp);
      });
    },

    async purgeDeleted(now = new Date()) {
      const due = await db
        .select({ spaceId: spaces.spaceId, address: spaces.address })
        .from(spaces)
        .where(
          and(
            lt(spaces.deletedAt, new Date(now.getTime() - RETENTION_MS)),
            isNotNull(spaces.address),
          ),
        );
      for (const { spaceId, address } of due) {
        try {
          const { name, domain } = splitAddress(address!);
          await tmail.deleteTeamMailbox(domain, name);
          await db.update(spaces).set({ address: null }).where(eq(spaces.spaceId, spaceId));
          logger.info({ spaceId, address }, 'team mailbox deleted');
        } catch (err) {
          logger.error({ err, spaceId }, 'team mailbox deletion failed, retried at the next purge');
        }
      }
    },

    memberAdded: onMember(false),
    memberRoleChanged: onMember(false),
    memberRemoved: onMember(true),

    async dnsValidated(body) {
      const event = parseEvent(dnsValidated, body);
      const values = {
        domain: event.domain.toLowerCase(),
        mailValidated: event.mailDnsConfigurationValidated,
      };
      await db
        .insert(organizations)
        .values({ organizationId: event.organizationId, ...values })
        .onConflictDoUpdate({
          target: organizations.organizationId,
          set: { ...values, updatedAt: sql`now()` },
        });
      if (!values.mailValidated) return;

      const waiting = await db
        .select({ spaceId: spaces.spaceId })
        .from(spaces)
        .where(
          and(
            eq(spaces.organizationId, event.organizationId),
            isNull(spaces.provisionedAt),
            isNull(spaces.deletedAt),
          ),
        );
      await eachSpace(
        waiting.map((s) => s.spaceId),
        (spaceId) => locked(spaceId, () => provision(spaceId)),
      );
    },

    async userDeleted(body) {
      const event = parseEvent(userDeleted, body);
      const memberships = await db
        .select({ spaceId: spaceMembers.spaceId })
        .from(spaceMembers)
        .where(eq(spaceMembers.userId, event.uuid));
      await eachSpace(
        memberships.map((m) => m.spaceId),
        (spaceId) =>
          locked(spaceId, async () => {
            const membership = and(
              eq(spaceMembers.spaceId, spaceId),
              eq(spaceMembers.userId, event.uuid),
            );
            const [mailbox] = await db
              .select({ address: spaces.address, email: spaceMembers.email })
              .from(spaceMembers)
              .innerJoin(spaces, eq(spaces.spaceId, spaceMembers.spaceId))
              .where(
                and(
                  membership,
                  isNull(spaceMembers.removedAt),
                  isNotNull(spaces.provisionedAt),
                  isNull(spaces.deletedAt),
                ),
              );
            // TMail first: a failed call retries the event with the membership still stored.
            if (mailbox) await syncMember(mailbox.address, mailbox.email, undefined);
            await db.delete(spaceMembers).where(membership);
          }),
      );
    },
  };
};

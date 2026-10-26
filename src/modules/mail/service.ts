import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Activity } from '../../events/activity.js';
import { enqueue } from '../../events/outbox.js';
import { NotYetKnownError } from '../../events/errors.js';
import type { InboxKey } from '../../events/inbox.js';
import type { Db } from '../../infra/db.js';
import { parseEvent } from '../spaces/events.js';
import { spaces } from '../spaces/schema.js';

export interface MailService {
  messageAdded(body: unknown): Promise<void>;
}

interface MailServiceDeps {
  db: Db;
  activity: Activity;
  logger: Logger;
}

const teamMessage = z.looseObject({
  teamMailbox: z.string().min(1),
  direction: z.enum(['received', 'sent']),
  messageId: z.string().min(1),
  subject: z
    .string()
    .nullish()
    .transform((s) => s ?? ''),
  timestamp: z.iso.datetime({ offset: true }),
});

// TMail's message id leaves out the team mailbox, and a copy into a second one keeps it.
export const messageKey: InboxKey = (message) => {
  const event = teamMessage.safeParse(message);
  if (!event.success) return undefined;
  const { teamMailbox, messageId, direction } = event.data;
  return { source: 'tmail', id: `${teamMailbox.toLowerCase()}:${messageId}:${direction}` };
};

export const createMailService = ({ db, activity, logger }: MailServiceDeps): MailService => ({
  async messageAdded(body) {
    const event = parseEvent(teamMessage, body);
    const [space] = await db
      .select({
        organizationId: spaces.organizationId,
        mailboxId: spaces.mailboxId,
        deletedAt: spaces.deletedAt,
      })
      .from(spaces)
      .where(eq(spaces.address, event.teamMailbox.toLowerCase()));
    if (!space || space.deletedAt) {
      logger.info({ teamMailbox: event.teamMailbox }, 'mail of a team mailbox no space owns');
      return;
    }
    // Mail can land before the provisioned event is published, and the feed needs that event first.
    if (!space.mailboxId) {
      throw new NotYetKnownError(`${event.teamMailbox} is still being provisioned`);
    }
    await enqueue(
      db,
      activity.message({
        organizationId: space.organizationId,
        mailboxId: space.mailboxId,
        direction: event.direction,
        messageId: event.messageId,
        subject: event.subject,
        time: event.timestamp,
      }),
    );
  },
});

import { NotYetKnownError } from '../events/errors.js';
import {
  AddressTakenError,
  type TeamMailboxRole,
  type TmailClient,
  TmailError,
  TmailRejectedError,
} from './port.js';

export interface TmailOptions {
  baseUrl: string;
  password?: string;
  /** Each call's result: the HTTP status, `timeout` or `error`. */
  onCall?: (operation: string, result: string, durationMs: number) => void;
}

type Operation = keyof TmailClient | 'findMailingList';

// One attempt per call: the broker client retries the handler, then dead-letters.
const TIMEOUT_MS = 10_000;
const MAX_ERROR_BODY = 500;

const isNotFound = (err: unknown) => err instanceof NotYetKnownError;

// 401 and 403 mean the service's own credentials are wrong, never the event.
const RETRIED = new Set([401, 403, 408, 429]);

// TMail answers 404 for a domain or a team mailbox it does not have, which a later event may bring.
const failure = (status: number, body: string) => {
  if (status === 404) return new NotYetKnownError(`TMail webadmin answered 404: ${body}`);
  return status >= 400 && status < 500 && !RETRIED.has(status)
    ? new TmailRejectedError(status, body)
    : new TmailError(status, body);
};

export const createTmailClient = ({
  baseUrl,
  password,
  onCall = () => {},
}: TmailOptions): TmailClient => {
  const root = baseUrl.replace(/\/+$/, '');

  const call = async (
    operation: Operation,
    method: 'GET' | 'PUT' | 'DELETE',
    path: string,
  ): Promise<Response> => {
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(root + path, {
        method,
        headers: password ? { password } : {},
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      onCall(operation, timedOut ? 'timeout' : 'error', Date.now() - started);
      throw err;
    }
    onCall(operation, String(res.status), Date.now() - started);
    if (!res.ok) throw failure(res.status, (await res.text()).slice(0, MAX_ERROR_BODY));
    return res;
  };

  const teamMailbox = (domain: string, name: string) =>
    `/domains/${encodeURIComponent(domain)}/team-mailboxes/${encodeURIComponent(name)}`;
  const member = (domain: string, name: string, user: string) =>
    `${teamMailbox(domain, name)}/members/${encodeURIComponent(user)}`;

  // TMail creates a team mailbox over an LDAP mailing list's address, whose mail then goes to the
  // list. It answers 404 for no such list, 409 when it reads no lists at all.
  const isMailingList = async (address: string) => {
    try {
      await call('findMailingList', 'GET', `/mailingLists/${encodeURIComponent(address)}`);
      return true;
    } catch (err) {
      if (isNotFound(err) || (err instanceof TmailRejectedError && err.status === 409)) {
        return false;
      }
      throw err;
    }
  };

  return {
    async listTeamMailboxes(domain) {
      const res = await call(
        'listTeamMailboxes',
        'GET',
        `/domains/${encodeURIComponent(domain)}/team-mailboxes`,
      );
      return ((await res.json()) as { name: string }[]).map((m) => m.name);
    },
    async createTeamMailbox(domain, name) {
      if (await isMailingList(`${name}@${domain}`)) {
        throw new AddressTakenError(409, `${name}@${domain} is a mailing list`);
      }
      try {
        await call('createTeamMailbox', 'PUT', teamMailbox(domain, name));
      } catch (err) {
        if (err instanceof TmailRejectedError && err.status === 409) {
          throw new AddressTakenError(err.status, err.body);
        }
        throw err;
      }
    },
    // 404 means the domain is gone, and its team mailboxes with it.
    async deleteTeamMailbox(domain, name) {
      try {
        await call('deleteTeamMailbox', 'DELETE', teamMailbox(domain, name));
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    },
    // The root is listed under the team name itself, its folders (INBOX, Sent...) under theirs.
    async rootMailboxId(domain, name) {
      const res = await call('rootMailboxId', 'GET', `${teamMailbox(domain, name)}/mailboxes`);
      const folders = (await res.json()) as { mailboxName?: unknown; mailboxId?: unknown }[];
      const root = folders.find((f) => f.mailboxName === name);
      if (typeof root?.mailboxId !== 'string' || !root.mailboxId) {
        throw new Error(`no root mailbox listed for ${name}@${domain}`);
      }
      return root.mailboxId;
    },
    async listMembers(domain, name) {
      try {
        const res = await call('listMembers', 'GET', `${teamMailbox(domain, name)}/members`);
        return (await res.json()) as { username: string; role: TeamMailboxRole }[];
      } catch (err) {
        if (isNotFound(err)) return [];
        throw err;
      }
    },
    async addMember(domain, name, user, role) {
      await call('addMember', 'PUT', `${member(domain, name, user)}?role=${role}`);
    },
    // A missing team mailbox has no members to remove.
    async removeMember(domain, name, user) {
      try {
        await call('removeMember', 'DELETE', member(domain, name, user));
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    },
  };
};

import { RejectedEventError } from '../events/errors.js';

export type TeamMailboxRole = 'manager' | 'member';

export interface TmailClient {
  listTeamMailboxes(domain: string): Promise<string[]>;
  createTeamMailbox(domain: string, name: string): Promise<void>;
  isMailingList(address: string): Promise<boolean>;
  deleteTeamMailbox(domain: string, name: string): Promise<void>;
  rootMailboxId(domain: string, name: string): Promise<string>;
  listMembers(domain: string, name: string): Promise<{ username: string; role: TeamMailboxRole }[]>;
  addMember(domain: string, name: string, user: string, role: TeamMailboxRole): Promise<void>;
  removeMember(domain: string, name: string, user: string): Promise<void>;
}

// A 401, 403, 408, 429 or 5xx answer: the handler is retried.
export class TmailError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`TMail webadmin answered ${status}: ${body}`);
  }
}

// Any other 4xx answer but 404: the same call would fail again.
export class TmailRejectedError extends RejectedEventError {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`TMail webadmin answered ${status}: ${body}`);
  }
}

export class AddressTakenError extends TmailRejectedError {}

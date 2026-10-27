/**
 * Routing context: addressing (who is being talked to).
 *
 * Priority follows FR-10: mention > thread continuation nomination > name
 * (alias in the body) > role > broadcast. The first level that produces at
 * least one recipient decides; lower levels are not evaluated. Silence is the
 * default: when nothing matches, the decision is empty and no agent is woken.
 * The sender is never their own recipient.
 */

export interface Participant {
  id: string;
  displayName: string;
  aliases: string[];
  roles: string[];
  kind: 'human' | 'agent';
}

export interface AddressingInput {
  /** Participant ids resolved from platform mentions. */
  mentionedIds: string[];
  /** Participant id nominated by thread continuation, if any. */
  threadNominationId: string | null;
  bodyText: string;
  /** Roles addressed by the message, parsed upstream. */
  roleMentions: string[];
  broadcast: boolean;
  senderId: string;
}

export type AddressingBasis =
  | 'mention'
  | 'thread'
  | 'name'
  | 'role'
  | 'broadcast'
  | 'none';

export interface AddressingDecision {
  recipients: string[];
  basis: AddressingBasis;
}

export function decideAddressing(
  input: AddressingInput,
  participants: Participant[],
): AddressingDecision {
  const known = new Map(participants.map((p) => [p.id, p]));
  const usable = (ids: string[]): string[] =>
    [...new Set(ids)].filter((id) => id !== input.senderId && known.has(id));

  const mentioned = usable(input.mentionedIds);
  if (mentioned.length > 0) {
    return { recipients: mentioned, basis: 'mention' };
  }

  if (input.threadNominationId !== null) {
    const nominated = usable([input.threadNominationId]);
    if (nominated.length > 0) {
      return { recipients: nominated, basis: 'thread' };
    }
  }

  const byName = participants
    .filter((p) => p.id !== input.senderId)
    .filter((p) =>
      [p.displayName, ...p.aliases].some(
        (alias) => alias.length > 0 && input.bodyText.includes(alias),
      ),
    )
    .map((p) => p.id);
  if (byName.length > 0) {
    return { recipients: byName, basis: 'name' };
  }

  if (input.roleMentions.length > 0) {
    const byRole = participants
      .filter((p) => p.id !== input.senderId)
      .filter((p) => p.roles.some((r) => input.roleMentions.includes(r)))
      .map((p) => p.id);
    if (byRole.length > 0) {
      return { recipients: byRole, basis: 'role' };
    }
  }

  if (input.broadcast) {
    const agents = participants
      .filter((p) => p.kind === 'agent' && p.id !== input.senderId)
      .map((p) => p.id);
    if (agents.length > 0) {
      return { recipients: agents, basis: 'broadcast' };
    }
  }

  return { recipients: [], basis: 'none' };
}

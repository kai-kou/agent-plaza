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
  /**
   * Additional platform sender ids that attribute to this participant —
   * e.g. the same agent posting through its own bot user while its
   * canonical id names another sending account. Attribution and mention
   * resolution map every listed id to `id` (see resolveParticipantId).
   */
  senderIds?: string[];
}

/**
 * Resolve a platform sender id to the canonical participant id: the id
 * itself when it names a participant, the owning participant's id when
 * it is one of their `senderIds`, and the id unchanged when no
 * participant claims it (unknown senders stay unknown).
 */
export function resolveParticipantId(
  id: string,
  participants: Participant[],
): string {
  for (const p of participants) {
    if (p.id === id || (p.senderIds?.includes(id) ?? false)) {
      return p.id;
    }
  }
  return id;
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

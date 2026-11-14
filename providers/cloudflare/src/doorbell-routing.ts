/**
 * Cloudflare provider: participant doorbell routing (decision D-22).
 *
 * The hub already decides who a post is addressed to at ingress
 * (FR-10, decideAddressing) and stores the result on the delivery
 * record. D-22 reuses that result to choose WHICH latest-event
 * pointers ring: instead of only the shared channel pointer, ingress
 * also rings the per-participant pointers of the routed participants
 * (see participantLatestThreadId in kv-doorbell.ts). The payload is
 * untouched — `{eventId, ts}` as always (FR-8) — addressing is used
 * only to select the rung keys, never carried in the signal.
 *
 * Routing rules (FR-6), evaluated in this order:
 *
 * 1. Unknown sender (not a registered participant): fail-open —
 *    broadcast to every participant. An unresolvable sender must
 *    never be silently dropped by routing.
 * 2. Complete marker present: fail-open — broadcast to every
 *    participant. The marker's `to=` is not parsed at ingress
 *    (FR-53 (3)), so the true addressee cannot be known here; only
 *    the marker's presence is detected, never its contents.
 * 3. Recipients decided by addressing: ring exactly those
 *    participants (the sender is never rung for their own post, and
 *    unregistered ids are dropped).
 * 4. No recipients, but the post continues a thread with other
 *    participants: fail-open — ring the thread's other participants,
 *    so an ongoing conversation keeps waking its members even when a
 *    reply carries no explicit address.
 * 5. No recipients and the sender is human: broadcast to every
 *    participant (a human post with no addressee is for everyone;
 *    the first responder is chosen on the reader side, FR-22).
 * 6. No recipients and the sender is an agent: ring no participant
 *    pointer — silence is the default (FR-11). This is where the
 *    wake-up savings of D-22 come from.
 *
 * Broadcasts (rules 1, 2, 5) name every registered participant,
 * including the sender when the sender is one: a sender polling its
 * own pointer sees its own event id and reconciles it away against
 * the ledger, which is harmless, while leaving anyone out of a
 * fail-open broadcast would reopen exactly the missed-wake failure
 * D-22 forbids.
 *
 * Denied-notice ringing is NOT routed here: it stays a broadcast on
 * the thread flag and the shared channel pointer (FR-53 (2)).
 *
 * This function is pure: it decides the participant pointer targets
 * only. The caller always also rings the thread flag and the shared
 * channel pointer (the migration dual ring), so readers that have
 * not yet moved to their own pointer keep working unchanged.
 */

import type { Participant } from '@agent-plaza/core';

/**
 * The complete-marker start tokens (FR-36): the primary form and its
 * ASCII alias. Presence of either marks a post as carrying a complete
 * marker; the marker is never parsed here.
 */
const COMPLETE_MARKER_TOKENS: readonly string[] = [
  '⟦AH1⟧',
  '[AGENT-HUB/0.1]',
];

/** True when the post text carries a complete marker (FR-36). */
export function hasCompleteMarker(text: string): boolean {
  return COMPLETE_MARKER_TOKENS.some((token) => text.includes(token));
}

export type DoorbellRoutingBasis =
  | 'recipients'
  | 'human-broadcast'
  | 'agent-silence'
  | 'fail-open-unknown-sender'
  | 'fail-open-marker'
  | 'fail-open-thread';

export interface DoorbellRoutingInput {
  /** The addressing result stored on the delivery record (FR-10). */
  recipients: readonly string[];
  /** The normalized participant id the post is attributed to. */
  senderId: string;
  /** The deployment's registered participants. */
  participants: readonly Participant[];
  /** Whether the post carries a complete marker (FR-36). */
  hasMarker: boolean;
  /** Whether the post is a reply inside an existing thread. */
  isThreadReply: boolean;
  /**
   * Participant ids already active in the thread (senders and
   * recipients of its ledger entries), for the thread-continuation
   * fail-open. Only consulted when `isThreadReply` is true.
   */
  threadParticipantIds: readonly string[];
}

export interface DoorbellRouting {
  /** Participants whose per-participant latest pointer should ring. */
  participantIds: string[];
  /** Which rule decided, for logs and tests. */
  basis: DoorbellRoutingBasis;
}

export function routeDoorbellRecipients(
  input: DoorbellRoutingInput,
): DoorbellRouting {
  const known = new Map(input.participants.map((p) => [p.id, p]));
  const all = input.participants.map((p) => p.id);
  const sender = known.get(input.senderId);

  if (sender === undefined) {
    return { participantIds: all, basis: 'fail-open-unknown-sender' };
  }
  if (input.hasMarker) {
    return { participantIds: all, basis: 'fail-open-marker' };
  }

  const addressed = [...new Set(input.recipients)].filter(
    (id) => id !== input.senderId && known.has(id),
  );
  if (addressed.length > 0) {
    return { participantIds: addressed, basis: 'recipients' };
  }

  if (input.isThreadReply) {
    const inThread = [...new Set(input.threadParticipantIds)].filter(
      (id) => id !== input.senderId && known.has(id),
    );
    if (inThread.length > 0) {
      return { participantIds: inThread, basis: 'fail-open-thread' };
    }
  }

  if (sender.kind === 'human') {
    return { participantIds: all, basis: 'human-broadcast' };
  }
  return { participantIds: [], basis: 'agent-silence' };
}

/**
 * Cloudflare provider: participant doorbell routing (decisions D-22, D-23).
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
 * D-23 narrows the ringing on the premise that a post to the
 * designated channel must carry an address: an individual mention,
 * here / channel, or a complete marker's `to=`. The routing rules
 * (FR-6), evaluated in this order:
 *
 * 1. Unknown sender (not a registered participant): fail-open —
 *    broadcast to every participant. An unresolvable sender must
 *    never be silently dropped by routing.
 * 2. Explicit broadcast address (here / channel): ring every
 *    participant. The author addressed the whole channel on purpose,
 *    so the broadcast wins over any narrower address on the post.
 * 3. Decided addressees: the FR-10 recipients (mentions, the thread
 *    continuation nomination, names, roles) unioned with the
 *    complete marker's `to=` addressees, parsed at ingress (the M4
 *    marker work). Ring exactly those participants (the sender is
 *    never rung for their own post, and unregistered ids are
 *    dropped). The basis is 'marker-recipients' when the marker
 *    contributed at least one rung participant, 'recipients'
 *    otherwise.
 * 4. No addressees and the sender is a human participant:
 *    broadcast to every participant. In this participant model the
 *    human participant is the owner (any other human is simply
 *    unregistered and lands in rule 1), so this is the owner's
 *    exception of D-23: an address-less owner post is for everyone,
 *    and the first responder is chosen on the reader side (FR-22).
 * 5. No addressees and the sender is an agent: ring no participant
 *    pointer — silence is the default (FR-11). With addressing
 *    mandatory, an agent post that addresses nobody wakes nobody;
 *    this is where the wake-up savings of D-22 / D-23 come from.
 *
 * What D-23 removed: a complete marker no longer fails open on its
 * presence alone (its `to=` is parsed and routed by rule 3), and an
 * unaddressed thread reply no longer rings the thread's other
 * participants. The thread continuation that counts as addressing
 * is the FR-10 nomination (priority 2), which already arrives
 * inside `recipients`; a reply that earns no nomination and carries
 * no other address is address-less and falls to rules 4 / 5.
 *
 * Broadcasts (rules 1, 2, 4) name every registered participant,
 * including the sender when the sender is one: a sender polling its
 * own pointer sees its own event id and reconciles it away against
 * the ledger, which is harmless, while leaving anyone out of a
 * fail-open broadcast would reopen exactly the missed-wake failure
 * the remaining fail-opens exist to prevent.
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
 * marker.
 */
const COMPLETE_MARKER_TOKENS: readonly string[] = [
  '⟦AH1⟧',
  '[AGENT-HUB/0.1]',
];

/** True when the post text carries a complete marker (FR-36). */
export function hasCompleteMarker(text: string): boolean {
  return COMPLETE_MARKER_TOKENS.some((token) => text.includes(token));
}

/**
 * The raw addressee tokens written in a post's complete markers
 * (FR-36): every `to=` value that appears after a marker start
 * token, split on commas, in order of appearance, duplicates
 * removed. Tokens are returned as written (stable participant ids
 * such as `agent:alpha`); resolving them to registered participants
 * is the caller's job (see resolveParticipantId), and unresolvable
 * tokens are dropped by the routing filter, exactly like unknown
 * recipients. Text without a complete marker yields no tokens: the
 * body's prose is never mined for addressing.
 */
export function parseCompleteMarkerAddressees(text: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const token of COMPLETE_MARKER_TOKENS) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(token, from);
      if (at < 0) break;
      const segment = text.slice(at + token.length);
      for (const m of segment.matchAll(/(?:^|\s)to=([^\s]+)/g)) {
        for (const part of m[1]!.split(',')) {
          const value = part.trim();
          if (value.length > 0 && !seen.has(value)) {
            seen.add(value);
            tokens.push(value);
          }
        }
      }
      from = at + token.length;
    }
  }
  return tokens;
}

/**
 * True when the post carries Slack's explicit broadcast address:
 * `<!here>`, `<!channel>` or `<!everyone>` (an optional `|label`
 * suffix is allowed). D-23 treats these as an address to every
 * participant.
 */
export function hasBroadcastAddress(text: string): boolean {
  return /<!(?:here|channel|everyone)(?:\|[^>]*)?>/.test(text);
}

export type DoorbellRoutingBasis =
  | 'recipients'
  | 'marker-recipients'
  | 'broadcast'
  | 'owner-broadcast'
  | 'agent-silence'
  | 'fail-open-unknown-sender';

export interface DoorbellRoutingInput {
  /** The addressing result stored on the delivery record (FR-10). */
  recipients: readonly string[];
  /**
   * Participant ids resolved from the complete marker's `to=`
   * (FR-36): parseCompleteMarkerAddressees at ingress, resolved with
   * resolveParticipantId. Unioned with `recipients` by rule 3.
   */
  markerRecipients: readonly string[];
  /**
   * Whether the post carries an explicit broadcast address
   * (`<!here>` / `<!channel>` / `<!everyone>`), per
   * hasBroadcastAddress.
   */
  broadcastAddress: boolean;
  /** The normalized participant id the post is attributed to. */
  senderId: string;
  /** The deployment's registered participants. */
  participants: readonly Participant[];
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
  if (input.broadcastAddress) {
    return { participantIds: all, basis: 'broadcast' };
  }

  const usable = (ids: readonly string[]): string[] =>
    [...new Set(ids)].filter(
      (id) => id !== input.senderId && known.has(id),
    );
  const fromMarker = usable(input.markerRecipients);
  const addressed = [...new Set([...usable(input.recipients), ...fromMarker])];
  if (addressed.length > 0) {
    return {
      participantIds: addressed,
      basis: fromMarker.length > 0 ? 'marker-recipients' : 'recipients',
    };
  }

  if (sender.kind === 'human') {
    return { participantIds: all, basis: 'owner-broadcast' };
  }
  return { participantIds: [], basis: 'agent-silence' };
}

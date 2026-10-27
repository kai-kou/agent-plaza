/**
 * Conversation context: the thread ledger.
 *
 * The ledger is the hub's source of truth for one thread. It accepts
 * envelopes (validating them, assigning turn numbers idempotently), tracks
 * each accepted message through the delivery state machine, and folds agent
 * activity into the loop guard (Governance) so the D-5 caps — including the
 * correction-round cap, which needs ledger-side revision information — are
 * enforced at acceptance time, not after the fact.
 *
 * The canonical definition of the delivery state machine is
 * spec/ledger-state-machine.json; the conformance tests pin the exported
 * LEDGER_TRANSITIONS table and the observable transition behavior to that
 * file. States follow docs/development-policy.md section 2.2:
 * received -> durably_accepted -> queued -> delivery_accepted -> started ->
 * replied -> verified/completed, with blocked / unknown / failed / cancelled.
 * "received" is transient (pre-validation) and is never stored; an entry is
 * created at durably_accepted. blocked and unknown are terminal here by
 * design: a blocked or unresolved delivery is superseded by new messages,
 * never revived by a state transition.
 *
 * One ledger instance serves exactly one thread; matching an envelope's
 * tenantId / channelId / threadTs to that thread is the caller's routing
 * responsibility. Idempotent retries resend the pre-acceptance candidate
 * (turnNumber null); a retry that replays an already-numbered envelope is
 * rejected, not resolved to the original entry. Correction rounds are
 * counted per directly corrected message: a correction of a correction
 * counts toward its own target, not toward the root of the chain.
 */

import {
  validateEnvelope,
  type MessageEnvelope,
} from './envelope.js';
import {
  evaluateLoopGuard,
  recordAgentPost,
  resetForHumanPost,
  DEFAULT_LOOP_CAPS,
  type LoopCaps,
  type LoopDenyReason,
  type ThreadActivity,
} from '../governance/loop-guard.js';

export type LedgerEntryState =
  | 'durably_accepted'
  | 'queued'
  | 'delivery_accepted'
  | 'started'
  | 'replied'
  | 'verified'
  | 'completed'
  | 'blocked'
  | 'unknown'
  | 'failed'
  | 'cancelled';

export const LEDGER_TRANSITIONS: Readonly<Record<LedgerEntryState, readonly LedgerEntryState[]>> = {
  durably_accepted: ['queued', 'blocked', 'failed', 'cancelled'],
  queued: ['delivery_accepted', 'blocked', 'unknown', 'failed', 'cancelled'],
  delivery_accepted: ['started', 'unknown', 'failed', 'cancelled'],
  started: ['replied', 'unknown', 'failed', 'cancelled'],
  replied: ['verified', 'completed', 'failed'],
  verified: ['completed', 'failed'],
  completed: [],
  blocked: [],
  unknown: [],
  failed: [],
  cancelled: [],
};

export interface LedgerEntry {
  envelope: MessageEnvelope;
  state: LedgerEntryState;
  /** Message this entry corrects, when accepted as a correction. */
  correctsMessageId: string | null;
}

export interface LedgerConfig {
  /** Registered participants and their kind. Unregistered senders are rejected. */
  participants: ReadonlyMap<string, 'human' | 'agent'>;
  caps?: LoopCaps;
}

export type AcceptResult =
  | { accepted: true; duplicate: boolean; entry: LedgerEntry }
  | {
      accepted: false;
      errors?: string[];
      reason?: LoopDenyReason | 'correction_round_cap';
    };

export type TransitionResult =
  | { ok: true; entry: LedgerEntry }
  | { ok: false; error: string };

export interface ThreadLedgerSnapshot {
  version: 1;
  nextTurn: number;
  entries: LedgerEntry[];
  activity: ThreadActivity;
  /** Key: corrected messageId. Value: accepted correction count. */
  correctionRounds: Record<string, number>;
  /** Key: idempotencyKey. Value: messageId it was accepted as. */
  idempotencyIndex: Record<string, string>;
}

export class ThreadLedger {
  readonly #participants: ReadonlyMap<string, 'human' | 'agent'>;
  readonly #caps: LoopCaps;
  #entries = new Map<string, LedgerEntry>();
  #idempotencyIndex = new Map<string, string>();
  #correctionRounds = new Map<string, number>();
  #activity: ThreadActivity = resetForHumanPost();
  #nextTurn = 1;

  constructor(config: LedgerConfig) {
    this.#participants = config.participants;
    this.#caps = config.caps ?? DEFAULT_LOOP_CAPS;
  }

  static restore(snapshot: unknown, config: LedgerConfig): ThreadLedger {
    const s = snapshot as ThreadLedgerSnapshot;
    if (
      typeof s !== 'object' ||
      s === null ||
      s.version !== 1 ||
      !Array.isArray(s.entries) ||
      typeof s.nextTurn !== 'number' ||
      typeof s.activity !== 'object' ||
      s.activity === null ||
      typeof s.correctionRounds !== 'object' ||
      s.correctionRounds === null ||
      typeof s.idempotencyIndex !== 'object' ||
      s.idempotencyIndex === null
    ) {
      throw new TypeError('invalid thread ledger snapshot');
    }
    const ledger = new ThreadLedger(config);
    let maxTurn = 0;
    for (const entry of s.entries) {
      const v = validateEnvelope(entry.envelope);
      if (!v.ok) {
        throw new TypeError(
          `snapshot entry fails envelope validation: ${v.errors.join('; ')}`,
        );
      }
      if (!Object.hasOwn(LEDGER_TRANSITIONS, entry.state)) {
        throw new TypeError(`snapshot entry has unknown state: ${String(entry.state)}`);
      }
      if (ledger.#entries.has(entry.envelope.messageId)) {
        throw new TypeError(
          `snapshot contains duplicate messageId ${entry.envelope.messageId}`,
        );
      }
      const turn = entry.envelope.turnNumber;
      if (turn === null || turn < 1) {
        throw new TypeError('snapshot entry has no assigned turnNumber');
      }
      maxTurn = Math.max(maxTurn, turn);
      ledger.#entries.set(entry.envelope.messageId, copyEntry(entry));
    }
    if (s.nextTurn <= maxTurn) {
      throw new TypeError('snapshot nextTurn would reuse an assigned turn number');
    }
    for (const messageId of Object.values(s.idempotencyIndex)) {
      if (!ledger.#entries.has(messageId)) {
        throw new TypeError('snapshot idempotencyIndex points at a missing entry');
      }
    }
    ledger.#nextTurn = s.nextTurn;
    ledger.#activity = {
      ...s.activity,
      perAgentCounts: { ...s.activity.perAgentCounts },
      pairExchanges: { ...s.activity.pairExchanges },
      contentOccurrences: { ...s.activity.contentOccurrences },
    };
    ledger.#correctionRounds = new Map(Object.entries(s.correctionRounds));
    ledger.#idempotencyIndex = new Map(Object.entries(s.idempotencyIndex));
    return ledger;
  }

  snapshot(): ThreadLedgerSnapshot {
    return {
      version: 1,
      nextTurn: this.#nextTurn,
      entries: [...this.#entries.values()].map(copyEntry),
      activity: {
        ...this.#activity,
        perAgentCounts: { ...this.#activity.perAgentCounts },
        pairExchanges: { ...this.#activity.pairExchanges },
        contentOccurrences: { ...this.#activity.contentOccurrences },
      },
      correctionRounds: Object.fromEntries(this.#correctionRounds),
      idempotencyIndex: Object.fromEntries(this.#idempotencyIndex),
    };
  }

  accept(
    candidate: unknown,
    opts: { correctsMessageId?: string } = {},
  ): AcceptResult {
    const validation = validateEnvelope(candidate);
    if (!validation.ok) {
      return { accepted: false, errors: validation.errors };
    }
    const envelope = validation.value;

    if (envelope.turnNumber !== null) {
      return {
        accepted: false,
        errors: ['turnNumber must be null before acceptance; it is ledger-assigned'],
      };
    }
    const kind = this.#participants.get(envelope.senderId);
    if (kind === undefined) {
      return {
        accepted: false,
        errors: [`sender ${envelope.senderId} is not a registered participant`],
      };
    }

    const seenAs = this.#idempotencyIndex.get(envelope.idempotencyKey);
    if (seenAs !== undefined) {
      const original = this.#entries.get(seenAs);
      if (original !== undefined) {
        return { accepted: true, duplicate: true, entry: copyEntry(original) };
      }
    }
    if (this.#entries.has(envelope.messageId)) {
      return {
        accepted: false,
        errors: [`messageId ${envelope.messageId} is already accepted`],
      };
    }

    const corrects = opts.correctsMessageId ?? null;
    if (corrects !== null) {
      if (!this.#entries.has(corrects)) {
        return {
          accepted: false,
          errors: [`correctsMessageId ${corrects} does not match an accepted message`],
        };
      }
      const rounds = this.#correctionRounds.get(corrects) ?? 0;
      if (rounds + 1 > this.#caps.maxCorrectionRounds) {
        return { accepted: false, reason: 'correction_round_cap' };
      }
    }

    if (kind === 'agent') {
      const verdict = evaluateLoopGuard(
        this.#activity,
        {
          senderId: envelope.senderId,
          recipientId:
            envelope.recipientIds.length === 1
              ? envelope.recipientIds[0]
              : undefined,
          contentHash: envelope.bodySha256,
        },
        this.#caps,
      );
      if (!verdict.allowed) {
        return { accepted: false, reason: verdict.reason };
      }
    }

    const entry: LedgerEntry = {
      envelope: { ...envelope, turnNumber: this.#nextTurn },
      state: 'durably_accepted',
      correctsMessageId: corrects,
    };
    this.#nextTurn += 1;
    this.#entries.set(entry.envelope.messageId, entry);
    this.#idempotencyIndex.set(envelope.idempotencyKey, entry.envelope.messageId);
    if (corrects !== null) {
      this.#correctionRounds.set(corrects, (this.#correctionRounds.get(corrects) ?? 0) + 1);
    }
    if (kind === 'human') {
      this.#activity = resetForHumanPost();
    } else {
      this.#activity = recordAgentPost(this.#activity, {
        senderId: envelope.senderId,
        recipientId:
          envelope.recipientIds.length === 1
            ? envelope.recipientIds[0]
            : undefined,
        contentHash: envelope.bodySha256,
      });
    }
    return { accepted: true, duplicate: false, entry: copyEntry(entry) };
  }

  transition(messageId: string, to: LedgerEntryState): TransitionResult {
    const entry = this.#entries.get(messageId);
    if (entry === undefined) {
      return { ok: false, error: `unknown messageId ${messageId}` };
    }
    if (!LEDGER_TRANSITIONS[entry.state].includes(to)) {
      return {
        ok: false,
        error: `transition ${entry.state} -> ${to} is not allowed`,
      };
    }
    entry.state = to;
    return { ok: true, entry: copyEntry(entry) };
  }

  getEntry(messageId: string): LedgerEntry | undefined {
    const entry = this.#entries.get(messageId);
    return entry === undefined ? undefined : copyEntry(entry);
  }

  entries(): LedgerEntry[] {
    return [...this.#entries.values()].map(copyEntry);
  }
}

function copyEntry(entry: LedgerEntry): LedgerEntry {
  return {
    envelope: { ...entry.envelope, recipientIds: [...entry.envelope.recipientIds] },
    state: entry.state,
    correctsMessageId: entry.correctsMessageId,
  };
}

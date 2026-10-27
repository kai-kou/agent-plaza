/**
 * Local provider: the local hub.
 *
 * Wires the core together the way the production hub will: an incoming post
 * is addressed (Routing), accepted by the ledger (Conversation, with the
 * Governance caps enforced), persisted through the LedgerStore port, and
 * delivered into the fake Slack workspace. Agent recipients with a
 * registered handler are started and their replies flow back through the
 * same path, so a conversation runs to quiescence without manual
 * forwarding. Delivery states are advanced on the ledger entries as the
 * work happens (queued -> delivery_accepted -> started -> replied).
 *
 * Simplifications of the local reference implementation: every envelope in
 * the thread carries threadTs = threadId, timestamps are deterministic
 * counters, and delivery to several agents shares one entry state.
 */

import { createHash } from 'node:crypto';
import {
  ThreadLedger,
  decideAddressing,
  type AcceptResult,
  type AddressingDecision,
  type AddressingInput,
  type LedgerEntry,
  type LedgerStore,
  type MessageEnvelope,
  type Participant,
} from '@agent-plaza/core';
import { FakeSlack } from './fake-slack.js';

export interface PostDraft {
  senderId: string;
  addressing?: Partial<AddressingInput>;
  bodyText: string;
  correctsMessageId?: string;
}

export type AgentHandler = (
  delivered: MessageEnvelope,
) => Promise<PostDraft | null>;

export type HubPostResult =
  | {
      accepted: true;
      entry: LedgerEntry;
      decision: AddressingDecision;
    }
  | { accepted: false; accept: AcceptResult };

export interface LocalHubOptions {
  store: LedgerStore;
  threadId: string;
  channelId: string;
  tenantId?: string;
  participants: Participant[];
  slack?: FakeSlack;
}

export class LocalHub {
  readonly slack: FakeSlack;
  readonly #store: LedgerStore;
  readonly #threadId: string;
  readonly #channelId: string;
  readonly #tenantId: string;
  readonly #participants: Participant[];
  readonly #ledger: ThreadLedger;
  readonly #handlers = new Map<string, AgentHandler>();
  #seq = 0;

  private constructor(
    opts: LocalHubOptions,
    ledger: ThreadLedger,
    restoredSeq: number,
  ) {
    this.slack = opts.slack ?? new FakeSlack();
    this.#store = opts.store;
    this.#threadId = opts.threadId;
    this.#channelId = opts.channelId;
    this.#tenantId = opts.tenantId ?? 'tenant-synthetic';
    this.#participants = opts.participants;
    this.#ledger = ledger;
    this.#seq = restoredSeq;
  }

  static async open(opts: LocalHubOptions): Promise<LocalHub> {
    const participantsById = new Map(
      opts.participants.map((p) => [p.id, p.kind] as const),
    );
    const snapshot = await opts.store.load(opts.threadId);
    const ledger =
      snapshot === null
        ? new ThreadLedger({ participants: participantsById })
        : ThreadLedger.restore(snapshot, {
            participants: participantsById,
          });
    const entries = ledger.entries();
    const first = entries[0];
    if (first !== undefined) {
      // The store key selects the thread; a snapshot whose envelopes belong
      // to a different tenant or channel means the store or the options are
      // misconfigured, and mixing the two must not pass silently.
      const e = first.envelope;
      if (
        e.tenantId !== (opts.tenantId ?? 'tenant-synthetic') ||
        e.channelId !== opts.channelId ||
        e.threadTs !== opts.threadId
      ) {
        throw new Error(
          'local hub: stored thread identity does not match the given options',
        );
      }
    }
    // The hub's sequence is not part of the ledger snapshot. It is restored
    // from the largest sequence suffix among accepted message ids, so ids
    // of accepted posts are never reused even when denied posts consumed
    // sequence numbers before the reopen (denied posts leave no entry, so
    // only accepted ids can collide).
    const prefix = `msg-${opts.threadId}-`;
    let seq = 0;
    for (const entry of entries) {
      const id = entry.envelope.messageId;
      if (id.startsWith(prefix)) {
        const n = Number(id.slice(prefix.length));
        if (Number.isInteger(n) && n > seq) seq = n;
      }
    }
    return new LocalHub(opts, ledger, seq);
  }

  registerAgent(agentId: string, handler: AgentHandler): void {
    this.#handlers.set(agentId, handler);
  }

  entries(): LedgerEntry[] {
    return this.#ledger.entries();
  }

  async post(draft: PostDraft): Promise<HubPostResult> {
    const decision = decideAddressing(
      {
        mentionedIds: [],
        threadNominationId: null,
        bodyText: draft.bodyText,
        roleMentions: [],
        broadcast: false,
        senderId: draft.senderId,
        ...draft.addressing,
      },
      this.#participants,
    );

    this.#seq += 1;
    const n = this.#seq;
    // The body is written to Slack only after the ledger accepts the post,
    // so a denied post (e.g. at a loop cap) never becomes visible. The
    // bodyRef is formed from the ts the delivery will receive.
    const reservedTs = this.slack.peekTs();
    const candidate: MessageEnvelope = {
      messageId: `msg-${this.#threadId}-${n}`,
      idempotencyKey: `idem-${this.#threadId}-${n}`,
      tenantId: this.#tenantId,
      channelId: this.#channelId,
      threadTs: this.#threadId,
      senderId: draft.senderId,
      recipientIds: decision.recipients,
      kind: 'discussion',
      hopCount: this.#hopCountFor(draft.senderId),
      turnNumber: null,
      issuedAt: new Date(Date.UTC(2026, 9, 27, 0, n)).toISOString(),
      expiresAt: new Date(Date.UTC(2026, 9, 27, 1, n)).toISOString(),
      bodyRef: `fake-slack://${this.#channelId}/${reservedTs}`,
      bodySha256: createHash('sha256').update(draft.bodyText).digest('hex'),
    };

    const accept = this.#ledger.accept(
      candidate,
      draft.correctsMessageId === undefined
        ? {}
        : { correctsMessageId: draft.correctsMessageId },
    );
    if (!accept.accepted) {
      return { accepted: false, accept };
    }
    if (accept.duplicate) {
      // Idempotent replay of an already-delivered post: the original entry
      // and its Slack message stand; nothing is posted or advanced again.
      return { accepted: true, entry: accept.entry, decision };
    }
    const entry = accept.entry;
    // Persist the durable acceptance before the body becomes visible in
    // Slack: the ledger is canonical, so a delivery must never exist
    // without its accepted record already stored.
    await this.#persist();
    const delivered = this.slack.postMessage({
      channelId: this.#channelId,
      senderId: draft.senderId,
      bodyText: draft.bodyText,
    });
    if (delivered.ts !== reservedTs) {
      throw new Error('local hub delivery error: reserved ts mismatch');
    }
    await this.#advance(entry.envelope.messageId, 'queued');
    await this.#advance(entry.envelope.messageId, 'delivery_accepted');

    const agentRecipients = decision.recipients.filter((id) =>
      this.#handlers.has(id),
    );
    if (agentRecipients.length > 0) {
      await this.#advance(entry.envelope.messageId, 'started');
      let replied = false;
      for (const agentId of agentRecipients) {
        const handler = this.#handlers.get(agentId);
        if (handler === undefined) continue;
        let replyDraft: PostDraft | null;
        try {
          replyDraft = await handler(entry.envelope);
        } catch (err) {
          // A failed agent run is recorded as such on the delivered entry
          // (started -> failed) and the error still propagates to the
          // caller; it is never mistaken for silence or success.
          await this.#advance(entry.envelope.messageId, 'failed');
          throw err;
        }
        if (replyDraft === null) continue;
        const reply = await this.post(replyDraft);
        if (reply.accepted) replied = true;
      }
      if (replied) {
        await this.#advance(entry.envelope.messageId, 'replied');
      }
    }

    const finalEntry = this.#ledger.getEntry(entry.envelope.messageId);
    return {
      accepted: true,
      entry: finalEntry ?? entry,
      decision,
    };
  }

  /**
   * hopCount semantics (envelope spec): agent-to-agent hops since the most
   * recent human post. A post by a human starts a new run at 0; an agent
   * post counts the agent entries at the tail of the thread.
   */
  #hopCountFor(senderId: string): number {
    const kindOf = new Map(this.#participants.map((p) => [p.id, p.kind]));
    if (kindOf.get(senderId) !== 'agent') return 0;
    const entries = this.#ledger.entries();
    let hops = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e === undefined || kindOf.get(e.envelope.senderId) !== 'agent') {
        break;
      }
      hops += 1;
    }
    return hops;
  }

  async #advance(messageId: string, to: 'queued' | 'delivery_accepted' | 'started' | 'replied' | 'failed'): Promise<void> {
    const r = this.#ledger.transition(messageId, to);
    if (!r.ok) {
      throw new Error(`local hub state error: ${r.error}`);
    }
    await this.#persist();
  }

  async #persist(): Promise<void> {
    await this.#store.save(this.#threadId, this.#ledger.snapshot());
  }
}

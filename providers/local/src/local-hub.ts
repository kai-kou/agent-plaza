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
    restoredEntries: number,
  ) {
    this.slack = opts.slack ?? new FakeSlack();
    this.#store = opts.store;
    this.#threadId = opts.threadId;
    this.#channelId = opts.channelId;
    this.#tenantId = opts.tenantId ?? 'tenant-synthetic';
    this.#participants = opts.participants;
    this.#ledger = ledger;
    this.#seq = restoredEntries;
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
    return new LocalHub(opts, ledger, ledger.entries().length);
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
      hopCount: 0,
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
    const delivered = this.slack.postMessage({
      channelId: this.#channelId,
      senderId: draft.senderId,
      bodyText: draft.bodyText,
    });
    if (delivered.ts !== reservedTs) {
      throw new Error('local hub delivery error: reserved ts mismatch');
    }
    const entry = accept.entry;
    await this.#persist();
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
        const replyDraft = await handler(entry.envelope);
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

  async #advance(messageId: string, to: 'queued' | 'delivery_accepted' | 'started' | 'replied'): Promise<void> {
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

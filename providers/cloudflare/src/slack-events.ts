/**
 * Cloudflare provider: the Slack Events ingress core.
 *
 * Framework-free on purpose: the Worker entry (worker.ts) verifies the
 * Slack signature and hands the raw event payload here; everything from
 * that point is testable without a Workers runtime. The caller MUST have
 * verified the request signature before calling — this module trusts its
 * input the way a controller trusts an authenticated request.
 *
 * Processing order per event, mirroring the local hub's lessons:
 * addressing -> ledger acceptance -> persist -> enqueue delivery ->
 * mark queued + persist -> ring the doorbell (the thread flag and the
 * channel's latest-event pointer). A Slack retry (same
 * event_id) resolves through the ledger's idempotency: the original
 * entry is returned, and if its delivery was never enqueued (state still
 * durably_accepted) the enqueue is completed then — the retry heals the
 * interrupted first attempt instead of duplicating the message.
 *
 * Message subtypes are classified, never blanket-ignored (FR-2/FR-14):
 * new posts (no subtype, bot_message, file_share, thread broadcasts) are
 * ingested; edits and deletions (message_changed / message_deleted) are
 * ignored — they are not propagated to the ledger in this version, the
 * accepted original stands; the remaining subtypes are system
 * notifications, not posts. Bot-origin posts are attributed to a
 * participant (the event's user id, or the bot_id map when the event
 * carries no user id) and are addressed strictly (FR-14): only an
 * explicit mention in the message itself counts — thread continuation,
 * name, role and broadcast never apply to them. The only bot posts
 * ignored as such are this deployment's own bot echoes (ownBotId):
 * those deliveries were already recorded at acceptance time.
 *
 * Concurrency: callers that process events for one thread concurrently
 * MUST pass one shared ThreadSequencer in deps (the Worker entry and the
 * Durable Object both do). Without one, each call falls back to a fresh
 * sequencer and per-thread serialization does not hold.
 */

import {
  ThreadLedger,
  decideAddressing,
  resolveParticipantId,
  type LedgerEntry,
  type LedgerStore,
  type LoopCaps,
  type MessageEnvelope,
  type Participant,
} from '@agent-plaza/core';
import {
  channelLatestThreadId,
  type KvDoorbell,
} from './kv-doorbell.js';
import type { QueueDelivery } from './queue.js';
import { ThreadSequencer } from './thread-sequencer.js';

export interface SlackEventsDeps {
  store: LedgerStore;
  doorbell: KvDoorbell;
  delivery: QueueDelivery;
  participants: Participant[];
  caps?: LoopCaps;
  sequencer?: ThreadSequencer;
  /**
   * Channel allowlist (FR-1, D-9). When set, events from any other
   * channel are ignored before the ledger is touched; an empty list
   * therefore denies every channel (fail-closed). Unset means no
   * channel restriction and is for local/test wiring only — deployed
   * configuration always sets it.
   */
  allowedChannelIds?: string[];
  /**
   * Attribution for bot_message events that carry no user id: Slack
   * bot_id -> participant id.
   */
  botParticipants?: Record<string, string>;
  /**
   * This deployment's own Slack bot_id. Its posts are echoes of
   * deliveries already recorded at acceptance time and are the only
   * bot posts ignored as own posts (FR-14).
   */
  ownBotId?: string;
}

export type SlackEventResult =
  | { kind: 'challenge'; challenge: string }
  | { kind: 'accepted'; entry: LedgerEntry }
  | { kind: 'duplicate'; entry: LedgerEntry }
  | { kind: 'denied'; reason: string }
  | { kind: 'ignored'; reason: string }
  | { kind: 'bad_request'; reason: string };

interface SlackEventPayload {
  type?: string;
  challenge?: string;
  team_id?: string;
  event_id?: string;
  event?: {
    type?: string;
    subtype?: string;
    user?: string;
    bot_id?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
    text?: string;
  };
}

/** New-post subtypes: the event is a message entering the channel. */
const NEW_POST_SUBTYPES: ReadonlySet<string> = new Set([
  'bot_message',
  'file_share',
  'thread_broadcast',
  'reply_broadcast',
]);

type MessageClass = 'new_post' | 'edit_or_delete' | 'system';

function classifyMessage(subtype: string | undefined): MessageClass {
  if (subtype === undefined || NEW_POST_SUBTYPES.has(subtype)) {
    return 'new_post';
  }
  if (subtype === 'message_changed' || subtype === 'message_deleted') {
    return 'edit_or_delete';
  }
  return 'system';
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function slackParticipantId(slackUserId: string): string {
  return `slack:${slackUserId}`;
}

export async function handleSlackEvent(
  deps: SlackEventsDeps,
  rawBody: string,
): Promise<SlackEventResult> {
  let payload: SlackEventPayload;
  try {
    payload = JSON.parse(rawBody) as SlackEventPayload;
  } catch {
    return { kind: 'bad_request', reason: 'body is not valid JSON' };
  }

  if (payload.type === 'url_verification') {
    return typeof payload.challenge === 'string'
      ? { kind: 'challenge', challenge: payload.challenge }
      : { kind: 'bad_request', reason: 'url_verification without challenge' };
  }
  if (payload.type !== 'event_callback') {
    return { kind: 'ignored', reason: `payload type ${payload.type ?? '?'}` };
  }

  const event = payload.event;
  if (event === undefined || event.type !== 'message') {
    return { kind: 'ignored', reason: 'not a message event' };
  }
  const messageClass = classifyMessage(event.subtype);
  if (messageClass === 'edit_or_delete') {
    return {
      kind: 'ignored',
      reason: `message subtype ${event.subtype ?? '?'}: edits and deletions are not propagated to the ledger`,
    };
  }
  if (messageClass === 'system') {
    return { kind: 'ignored', reason: `message subtype ${event.subtype ?? '?'}` };
  }
  const botOrigin = event.subtype === 'bot_message';

  // The channel allowlist is enforced before anything touches the
  // ledger (FR-1): an unlisted channel is not a delivery target even
  // when the app is invited to it.
  if (
    deps.allowedChannelIds !== undefined &&
    event.channel !== undefined &&
    !deps.allowedChannelIds.includes(event.channel)
  ) {
    return { kind: 'ignored', reason: 'channel not in allowlist' };
  }
  // Own-bot echoes are the only bot posts ignored as such (FR-14): the
  // delivery they echo was already recorded at acceptance time.
  if (
    botOrigin &&
    deps.ownBotId !== undefined &&
    event.bot_id === deps.ownBotId
  ) {
    return { kind: 'ignored', reason: 'own bot post' };
  }
  if (
    event.channel === undefined ||
    event.ts === undefined ||
    event.text === undefined ||
    payload.event_id === undefined
  ) {
    return { kind: 'bad_request', reason: 'message event is missing fields' };
  }

  // Attribute the post to a participant: the event's user id, or — for
  // bot posts that carry none — the deployment's bot_id map. A bot post
  // attributable to nobody is ignored (it could never be accepted by
  // the ledger, and bot_id alone is not a discard reason, FR-14).
  let senderId: string | null = null;
  if (event.user !== undefined) {
    senderId = slackParticipantId(event.user);
  } else if (botOrigin && event.bot_id !== undefined) {
    senderId = deps.botParticipants?.[event.bot_id] ?? null;
  }
  if (senderId !== null) {
    // Normalize alias sender ids (a participant's own bot user, etc.)
    // to the canonical participant id, so attribution, addressing, and
    // the loop guard all see one identity per participant.
    senderId = resolveParticipantId(senderId, deps.participants);
  }
  if (senderId === null) {
    return botOrigin
      ? { kind: 'ignored', reason: 'bot_message without an attributable sender' }
      : { kind: 'bad_request', reason: 'message event is missing fields' };
  }

  const channel = event.channel;
  const ts = event.ts;
  const text = event.text;
  const eventId = payload.event_id;
  const slackThreadTs = event.thread_ts ?? ts;
  const threadId = `${channel}:${slackThreadTs}`;
  const sequencer = deps.sequencer ?? new ThreadSequencer();
  return sequencer.run(threadId, () =>
    processMessage(deps, {
      channel,
      slackThreadTs,
      threadId,
      senderId,
      botOrigin,
      ts,
      text,
      eventId,
      teamId: payload.team_id ?? 'slack',
    }),
  );
}

interface MessageContext {
  channel: string;
  slackThreadTs: string;
  threadId: string;
  /** Participant id the post is attributed to. */
  senderId: string;
  /** True when the post arrived as a bot_message (FR-14 applies). */
  botOrigin: boolean;
  ts: string;
  text: string;
  eventId: string;
  teamId: string;
}

async function processMessage(
  deps: SlackEventsDeps,
  ctx: MessageContext,
): Promise<SlackEventResult> {
  const participantsById = new Map(
    deps.participants.map((p) => [p.id, p.kind] as const),
  );
  const snapshot = await deps.store.load(ctx.threadId);
  const ledger =
    snapshot === null
      ? new ThreadLedger({
          participants: participantsById,
          ...(deps.caps === undefined ? {} : { caps: deps.caps }),
        })
      : ThreadLedger.restore(snapshot, {
          participants: participantsById,
          ...(deps.caps === undefined ? {} : { caps: deps.caps }),
        });

  const senderId = ctx.senderId;
  const mentionedIds = [
    ...ctx.text.matchAll(/<@([A-Z0-9]+)>/g),
  ].map((m) =>
    resolveParticipantId(slackParticipantId(m[1]!), deps.participants),
  );

  // Thread continuation nominates the author of the thread root, when the
  // root is in the ledger (its bodyRef ends with the root's Slack ts).
  // Bot-origin posts never get this nomination (FR-14, below).
  let threadNominationId: string | null = null;
  if (!ctx.botOrigin && ctx.slackThreadTs !== ctx.ts) {
    const root = ledger
      .entries()
      .find((e) => e.envelope.bodyRef.endsWith(`/${ctx.slackThreadTs}`));
    threadNominationId = root?.envelope.senderId ?? null;
  }

  // Addressing inputs this ingress can supply today: Slack mentions and
  // thread continuation. Role and broadcast addressing are not parsed
  // here — structured marker parsing (M4) owns them; until then they are
  // unreachable from ingress rather than guessed from the body.
  //
  // FR-14 strict addressing for bot-origin posts: only the mention
  // level is evaluated, so the input is reduced to mentions alone (an
  // empty bodyText cannot name-match, no nomination, no role, no
  // broadcast). Structured in-message addressing, once parsed by the M4
  // marker work, will feed the same mention level.
  const decision = ctx.botOrigin
    ? decideAddressing(
        {
          mentionedIds,
          threadNominationId: null,
          bodyText: '',
          roleMentions: [],
          broadcast: false,
          senderId,
        },
        deps.participants,
      )
    : decideAddressing(
        {
          mentionedIds,
          threadNominationId,
          bodyText: ctx.text,
          roleMentions: [],
          broadcast: false,
          senderId,
        },
        deps.participants,
      );

  const eventSeconds = Number(ctx.ts);
  const issued = new Date(
    (Number.isFinite(eventSeconds) ? eventSeconds : 0) * 1000,
  );
  const candidate: MessageEnvelope = {
    messageId: `evt-${ctx.eventId}`,
    idempotencyKey: ctx.eventId,
    tenantId: ctx.teamId,
    channelId: ctx.channel,
    threadTs: ctx.slackThreadTs,
    senderId,
    recipientIds: decision.recipients,
    kind: 'discussion',
    hopCount: hopCountFor(ledger, deps.participants, senderId),
    turnNumber: null,
    issuedAt: issued.toISOString(),
    expiresAt: new Date(issued.getTime() + 3_600_000).toISOString(),
    bodyRef: `slack://${ctx.channel}/${ctx.ts}`,
    bodySha256: await sha256Hex(ctx.text),
  };

  const accept = ledger.accept(candidate);
  if (!accept.accepted) {
    const reason =
      accept.reason ?? accept.errors?.join('; ') ?? 'not accepted';
    return { kind: 'denied', reason };
  }

  const entry = accept.entry;
  if (accept.duplicate && entry.state !== 'durably_accepted') {
    return { kind: 'duplicate', entry };
  }

  // Persist the durable acceptance before any signal leaves the process,
  // then enqueue delivery and record that transition too.
  await deps.store.save(ctx.threadId, ledger.snapshot());
  await deps.delivery.enqueue({
    threadId: ctx.threadId,
    messageId: entry.envelope.messageId,
  });
  const advanced = ledger.transition(entry.envelope.messageId, 'queued');
  if (!advanced.ok) {
    throw new Error(`ingress state error: ${advanced.error}`);
  }
  await deps.store.save(ctx.threadId, ledger.snapshot());
  await deps.doorbell.ring(ctx.threadId, ctx.eventId);
  // Move the channel's latest-event pointer too, so Tier-C readers
  // polling one key per channel also notice brand-new threads.
  await deps.doorbell.ring(channelLatestThreadId(ctx.channel), ctx.eventId);

  return { kind: accept.duplicate ? 'duplicate' : 'accepted', entry: advanced.entry };
}

function hopCountFor(
  ledger: ThreadLedger,
  participants: Participant[],
  senderId: string,
): number {
  const kindOf = new Map(participants.map((p) => [p.id, p.kind]));
  if (kindOf.get(senderId) !== 'agent') return 0;
  const entries = ledger.entries();
  let hops = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e === undefined || kindOf.get(e.envelope.senderId) !== 'agent') break;
    hops += 1;
  }
  return hops;
}

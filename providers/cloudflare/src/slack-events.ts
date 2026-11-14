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
 * mark queued + persist -> ring the doorbell (the thread flag, the
 * channel's latest-event pointer, and — participant doorbell, D-22 —
 * the per-participant latest pointers the addressing result routes
 * the post to; see doorbell-routing.ts). A Slack retry (same
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
 *
 * Denied posts (FR-53) never reach the ledger, the queue, or the
 * ordinary doorbell — but they are no longer silent. A denial is
 * written to the structured console log immediately and, when a denied
 * log store is wired, to D1 (best-effort: a write failure is logged
 * and the Slack response stays `{ ok: true, kind: 'denied' }`). When
 * the denial is a caps (or correction-round) denial addressed by an
 * explicit mention, and denied-notice ringing is enabled, the doorbell
 * rings once per accepted -> denied transition for the thread: the
 * thread flag's history kind, not a counter, decides, so a repeated
 * denial does not re-ring and an accepted post resets the transition.
 * `ignored` outcomes (allowlist, own-bot echoes, edits, system
 * subtypes) are not denials and are never logged here.
 */

import {
  ThreadLedger,
  decideAddressing,
  resolveParticipantId,
  DEFAULT_LOOP_CAPS,
  pairKey,
  type AcceptResult,
  type AddressingDecision,
  type LedgerEntry,
  type LedgerStore,
  type LoopCaps,
  type MessageEnvelope,
  type Participant,
  type ThreadLedgerSnapshot,
} from '@agent-plaza/core';
import {
  channelLatestThreadId,
  participantLatestThreadId,
  type KvDoorbell,
} from './kv-doorbell.js';
import {
  hasCompleteMarker,
  routeDoorbellRecipients,
} from './doorbell-routing.js';
import type {
  DeniedLogRecord,
  DeniedLogStore,
  DeniedReasonCode,
} from './denied-log.js';
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
   * Denied-log store (FR-53). When absent, denials are still written
   * to the structured console log but have no durable record; the
   * Worker entry always wires the D1 store.
   */
  deniedLog?: DeniedLogStore;
  /**
   * Stage gate for the denied-notice doorbell (FR-53). Defaults to
   * false (stage 1: log only) so a deployment can verify denied
   * logging against real threads before any denied-notice rings.
   * Set true (stage 2) only once that logging checks out. The Worker
   * entry reads this from the DENIED_NOTICE_ENABLED var ("true").
   */
  deniedNoticeEnabled?: boolean;
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
    const responseReason =
      accept.reason ?? accept.errors?.join('; ') ?? 'not accepted';
    await recordDenial(deps, {
      threadId: ctx.threadId,
      channel: ctx.channel,
      eventId: ctx.eventId,
      slackTs: ctx.ts,
      senderId,
      accept,
      decision,
      ledger,
      bodySha256: candidate.bodySha256,
    });
    return { kind: 'denied', reason: responseReason };
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
  // Participant doorbell (D-22, FR-6): also ring the per-participant
  // latest pointers the addressing result routes this post to, so a
  // reader polling only its own pointer wakes for posts addressed to
  // it (plus the fail-open broadcasts) and sleeps through the rest.
  // The thread flag and the shared pointer above always ring as well
  // (the migration dual ring): readers that have not yet moved to
  // their own pointer observe exactly what they observed before, and
  // the routing can only add targeted wakes, never remove an existing
  // one. The payload is the same {eventId, ts} on every key.
  const routing = routeDoorbellRecipients({
    recipients: decision.recipients,
    senderId,
    participants: deps.participants,
    hasMarker: hasCompleteMarker(ctx.text),
    isThreadReply: ctx.slackThreadTs !== ctx.ts,
    threadParticipantIds: ledger
      .entries()
      .flatMap((e) => [e.envelope.senderId, ...e.envelope.recipientIds]),
  });
  for (const participantId of routing.participantIds) {
    await deps.doorbell.ring(
      participantLatestThreadId(ctx.channel, participantId),
      ctx.eventId,
    );
  }

  return { kind: accept.duplicate ? 'duplicate' : 'accepted', entry: advanced.entry };
}

/**
 * Denied reasons that may ring a denied-notice (FR-53): the loop caps
 * and the correction-round cap. Every other denial (validation,
 * unregistered sender, duplicate, unknown correction target) is
 * logged only — its addressing is either untrustworthy or its remedy
 * is not a wake-up.
 */
const NOTICE_ELIGIBLE_REASONS: ReadonlySet<string> = new Set([
  'thread_cap',
  'per_agent_cap',
  'consecutive_cap',
  'pair_roundtrip_cap',
  'same_content_cap',
  'correction_round_cap',
]);

/**
 * Summarize a ledger rejection into a stable denied reason code. A
 * loop/correction reason passes through unchanged; the variable-length
 * validation error strings are classified so the log stays countable
 * (the full error text is never stored).
 */
function summarizeDeniedReason(
  accept: Extract<AcceptResult, { accepted: false }>,
): DeniedReasonCode {
  if (accept.reason !== undefined) return accept.reason;
  const errors = accept.errors ?? [];
  if (errors.some((e) => e.includes('is not a registered participant'))) {
    return 'unregistered_sender';
  }
  if (errors.some((e) => e.includes('is already accepted'))) {
    return 'duplicate_message';
  }
  if (errors.some((e) => e.includes('does not match an accepted message'))) {
    return 'invalid_correction_target';
  }
  return 'validation_error';
}

/**
 * The cap value actually reached and its limit for a denied reason,
 * read from the ledger snapshot (which a denial leaves untouched).
 * Only the numeric value is returned — for same_content_cap the body
 * hash itself is never carried into the log, only its occurrence
 * count. For correction_round_cap the ingress carries no correction
 * target (accept is called without correctsMessageId, so this reason
 * cannot occur via Slack ingress today); only the limit is known, and
 * the actual value is null rather than guessed.
 *
 * Exported for unit tests: the mapping is pure, and the
 * correction-round case in particular cannot be driven through Slack
 * ingress, so its { actual: null, limit } shape is pinned directly.
 */
export function capsForDeniedReason(
  reason: DeniedReasonCode,
  snapshot: ThreadLedgerSnapshot,
  senderId: string,
  decision: AddressingDecision,
  bodySha256: string,
  caps: LoopCaps,
): { actual: number | null; limit: number | null } {
  const activity = snapshot.activity;
  switch (reason) {
    case 'thread_cap':
      return { actual: activity.totalAgentMessages, limit: caps.maxThreadMessages };
    case 'per_agent_cap':
      return {
        actual: activity.perAgentCounts[senderId] ?? 0,
        limit: caps.maxPerAgent,
      };
    case 'consecutive_cap':
      return {
        actual: activity.consecutiveByLastSender,
        limit: caps.maxConsecutiveByAgent,
      };
    case 'pair_roundtrip_cap':
      return {
        actual:
          decision.recipients.length === 1
            ? (activity.pairExchanges[pairKey(senderId, decision.recipients[0]!)] ?? 0)
            : null,
        limit: caps.maxPairRoundTrips,
      };
    case 'same_content_cap':
      return {
        actual: activity.contentOccurrences[bodySha256] ?? 0,
        limit: caps.maxSameContent,
      };
    case 'correction_round_cap':
      return { actual: null, limit: caps.maxCorrectionRounds };
    default:
      return { actual: null, limit: null };
  }
}

interface DenialInput {
  threadId: string;
  channel: string;
  eventId: string;
  slackTs: string;
  senderId: string;
  accept: Extract<AcceptResult, { accepted: false }>;
  decision: AddressingDecision;
  ledger: ThreadLedger;
  bodySha256: string;
}

/**
 * Record one denial (FR-53) and, when eligible and enabled, ring its
 * denied-notice. Order matters: the notice decision is made first so
 * the log row can record whether a notice rang. A denial advances no
 * ledger counter, so a denied-notice can never chain: while the thread
 * stays denied the history's latest entry stays a denied-notice and no
 * further ring happens, and only an accepted post resets it.
 *
 * The console log and the D1 row carry the same fields and neither
 * carries the post body, the body hash, a secret, or a raw Slack user
 * id — the sender is the normalized participant id.
 *
 * Ring order matters for partial failure (see the ring block below):
 * the channel pointer rings first and the thread flag second, so a
 * failure of either ring leaves the transition latch unconsumed and
 * the next denial retries the notice. `noticeRung` means both rings
 * succeeded.
 */
async function recordDenial(
  deps: SlackEventsDeps,
  input: DenialInput,
): Promise<void> {
  const reason = summarizeDeniedReason(input.accept);
  const caps = deps.caps ?? DEFAULT_LOOP_CAPS;
  const { actual, limit } = capsForDeniedReason(
    reason,
    input.ledger.snapshot(),
    input.senderId,
    input.decision,
    input.bodySha256,
    caps,
  );
  let noticeRung = false;
  if (
    deps.deniedNoticeEnabled === true &&
    NOTICE_ELIGIBLE_REASONS.has(reason) &&
    input.decision.basis === 'mention' &&
    input.decision.recipients.length > 0
  ) {
    try {
      const lastKind = await deps.doorbell.lastKind(input.threadId);
      if (lastKind !== 'denied-notice') {
        // Ring the channel pointer FIRST, then the thread flag. The
        // thread flag's history is the transition latch: it is only
        // consumed once the thread-flag ring succeeds. If the channel
        // ring fails, the exception aborts before the latch moves, so
        // the next denial retries the whole notice. If the thread-flag
        // ring fails after the channel ring, the latch is likewise
        // untouched, and the retry's duplicate channel ring is a
        // harmless extra wake (design §5.3). The previous order
        // (thread flag first) lost the wake in exactly this partial
        // failure: the latch was consumed while the channel pointer
        // — the key Tier-C hooks poll — never moved.
        // Move the channel pointer too: Tier-C hooks poll one key per
        // channel, so a thread-flag-only ring would not wake them.
        await deps.doorbell.ring(
          channelLatestThreadId(input.channel),
          input.eventId,
          'denied-notice',
        );
        await deps.doorbell.ring(input.threadId, input.eventId, 'denied-notice');
        // noticeRung means both rings succeeded: a partial failure
        // leaves it false even when the channel pointer already moved,
        // so the log never claims a notice the latch did not record.
        noticeRung = true;
      }
    } catch {
      // Best-effort like the D1 write below: a doorbell failure must
      // not turn a denial into a Slack error. The log row records
      // noticeRung false, and this line marks the missed notice.
      console.error(
        'denied-notice ring failed',
        input.threadId,
        input.eventId,
      );
    }
  }
  const record: DeniedLogRecord = {
    threadId: input.threadId,
    eventId: input.eventId,
    slackTs: input.slackTs,
    recordedAt: new Date().toISOString(),
    senderId: input.senderId,
    reason,
    capsActual: actual,
    capsLimit: limit,
    addressingBasis: input.decision.basis,
    recipients: [...input.decision.recipients],
    noticeRung,
  };
  console.log(JSON.stringify({ type: 'denied', ...record }));
  if (deps.deniedLog !== undefined) {
    try {
      await deps.deniedLog.record(record);
    } catch {
      // Best-effort: a denied-log failure must not break the Slack
      // response. The console log above already holds the record, and
      // this error line marks the durable copy as missing.
      console.error(
        'denied_log write failed',
        input.threadId,
        input.eventId,
      );
    }
  }
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

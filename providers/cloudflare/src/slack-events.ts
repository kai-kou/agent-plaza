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
 * mark queued + persist -> ring the doorbell. A Slack retry (same
 * event_id) resolves through the ledger's idempotency: the original
 * entry is returned, and if its delivery was never enqueued (state still
 * durably_accepted) the enqueue is completed then — the retry heals the
 * interrupted first attempt instead of duplicating the message.
 */

import {
  ThreadLedger,
  decideAddressing,
  type LedgerEntry,
  type LedgerStore,
  type LoopCaps,
  type MessageEnvelope,
  type Participant,
} from '@agent-plaza/core';
import type { KvDoorbell } from './kv-doorbell.js';
import type { QueueDelivery } from './queue.js';
import { ThreadSequencer } from './thread-sequencer.js';

export interface SlackEventsDeps {
  store: LedgerStore;
  doorbell: KvDoorbell;
  delivery: QueueDelivery;
  participants: Participant[];
  caps?: LoopCaps;
  sequencer?: ThreadSequencer;
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
    channel?: string;
    ts?: string;
    thread_ts?: string;
    text?: string;
  };
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
  if (event.subtype !== undefined) {
    return { kind: 'ignored', reason: `message subtype ${event.subtype}` };
  }
  if (
    event.user === undefined ||
    event.channel === undefined ||
    event.ts === undefined ||
    event.text === undefined ||
    payload.event_id === undefined
  ) {
    return { kind: 'bad_request', reason: 'message event is missing fields' };
  }

  const channel = event.channel;
  const user = event.user;
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
      user,
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
  user: string;
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

  const senderId = slackParticipantId(ctx.user);
  const mentionedIds = [
    ...ctx.text.matchAll(/<@([A-Z0-9]+)>/g),
  ].map((m) => slackParticipantId(m[1]!));

  // Thread continuation nominates the author of the thread root, when the
  // root is in the ledger (its bodyRef ends with the root's Slack ts).
  let threadNominationId: string | null = null;
  if (ctx.slackThreadTs !== ctx.ts) {
    const root = ledger
      .entries()
      .find((e) => e.envelope.bodyRef.endsWith(`/${ctx.slackThreadTs}`));
    threadNominationId = root?.envelope.senderId ?? null;
  }

  const decision = decideAddressing(
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

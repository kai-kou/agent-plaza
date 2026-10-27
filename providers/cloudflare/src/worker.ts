/**
 * Cloudflare provider: the Worker entry.
 *
 * Routes:
 * - GET  /healthz       liveness, no dependencies touched.
 * - GET  /doorbell/:capability/:threadId
 *                       the doorbell read route for Tier-C readers. The
 *                       capability is an unguessable path segment set as
 *                       a secret (DOORBELL_CAPABILITY); the route is
 *                       disabled when it is not configured or is shorter
 *                       than MIN_DOORBELL_CAPABILITY_LENGTH. It returns
 *                       only the flag ({eventId, ts}) or {flag: null} —
 *                       never content — and a wrong capability is
 *                       indistinguishable from an unknown route (404).
 * - POST /slack/events  Slack Events API ingress. The signature is
 *   verified first; url_verification challenges are answered inline.
 *   Message events are processed by the ingress core (slack-events.ts),
 *   either directly in this isolate or — when the THREAD_LEDGER Durable
 *   Object namespace is bound — inside the Durable Object that owns the
 *   thread, which is what makes per-thread serialization hold across
 *   isolates. The Durable Object runs the same ingress core.
 *
 * Bindings and secrets are described in providers/cloudflare/README.md.
 * The D1 schema is owned by the setup procedure (schema.sql), not by
 * request-time code.
 */

import { Hono } from 'hono';
import type { Participant } from '@agent-plaza/core';
import { D1LedgerStore, type D1DatabaseLike } from './d1-ledger-store.js';
import { KvDoorbell, type KVNamespaceLike } from './kv-doorbell.js';
import { QueueDelivery, type QueueProducerLike } from './queue.js';
import { verifySlackSignature } from './slack-signature.js';
import {
  handleSlackEvent,
  type SlackEventResult,
  type SlackEventsDeps,
} from './slack-events.js';
import { ThreadSequencer } from './thread-sequencer.js';

export interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

export interface EnvBindings {
  DB: D1DatabaseLike;
  KV: KVNamespaceLike;
  QUEUE: QueueProducerLike;
  SLACK_SIGNING_SECRET: string;
  /** JSON array of core Participant objects for this deployment. */
  PARTICIPANTS_JSON: string;
  /**
   * JSON array of Slack channel ids the hub serves (FR-1, D-9).
   * Optional in the type for local/test wiring; the shipped
   * wrangler.toml sets it to "[]", which denies every channel until
   * the operator configures the designated channel.
   */
  ALLOWED_CHANNEL_IDS_JSON?: string;
  /** JSON object mapping Slack bot_id -> participant id, for
   * bot_message events that carry no user id. */
  BOT_PARTICIPANTS_JSON?: string;
  /** This deployment's own Slack bot_id (its echoes are ignored). */
  OWN_BOT_ID?: string;
  /**
   * Unguessable capability segment for the doorbell read route. Set it
   * with `wrangler secret put DOORBELL_CAPABILITY`; the route is
   * disabled when it is unset or empty.
   */
  DOORBELL_CAPABILITY?: string;
  THREAD_LEDGER?: DurableObjectNamespaceLike;
}

function parseParticipantArray(raw: string): Participant[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('PARTICIPANTS_JSON must be a JSON array');
  }
  return parsed as Participant[];
}

function parseStringArray(raw: string, name: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (
    !Array.isArray(parsed) ||
    parsed.some((v) => typeof v !== 'string')
  ) {
    throw new Error(`${name} must be a JSON array of strings`);
  }
  return parsed as string[];
}

function parseBotParticipants(raw: string): Record<string, string> {
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((v) => typeof v !== 'string')
  ) {
    throw new Error(
      'BOT_PARTICIPANTS_JSON must be a JSON object of string values',
    );
  }
  return parsed as Record<string, string>;
}

function depsFromEnv(env: EnvBindings): SlackEventsDeps {
  return {
    store: new D1LedgerStore(env.DB),
    doorbell: new KvDoorbell(env.KV),
    delivery: new QueueDelivery(env.QUEUE),
    participants: parseParticipantArray(env.PARTICIPANTS_JSON),
    ...(env.ALLOWED_CHANNEL_IDS_JSON === undefined
      ? {}
      : {
          allowedChannelIds: parseStringArray(
            env.ALLOWED_CHANNEL_IDS_JSON,
            'ALLOWED_CHANNEL_IDS_JSON',
          ),
        }),
    ...(env.BOT_PARTICIPANTS_JSON === undefined
      ? {}
      : { botParticipants: parseBotParticipants(env.BOT_PARTICIPANTS_JSON) }),
    ...(env.OWN_BOT_ID === undefined || env.OWN_BOT_ID === ''
      ? {}
      : { ownBotId: env.OWN_BOT_ID }),
  };
}

function resultToResponse(result: SlackEventResult): {
  status: number;
  body: Record<string, unknown>;
} {
  switch (result.kind) {
    case 'challenge':
      return { status: 200, body: { challenge: result.challenge } };
    case 'bad_request':
      return { status: 400, body: { error: result.reason } };
    default:
      return { status: 200, body: { ok: true, kind: result.kind } };
  }
}

/** The thread a raw payload belongs to, or null when it has none. */
export function threadIdFromBody(rawBody: string): string | null {
  try {
    const payload = JSON.parse(rawBody) as {
      type?: string;
      event?: { type?: string; channel?: string; ts?: string; thread_ts?: string };
    };
    if (
      payload.type !== 'event_callback' ||
      payload.event?.type !== 'message' ||
      payload.event.channel === undefined ||
      payload.event.ts === undefined
    ) {
      return null;
    }
    return `${payload.event.channel}:${payload.event.thread_ts ?? payload.event.ts}`;
  } catch {
    return null;
  }
}

/**
 * Minimum length for a doorbell capability to take effect. Longer is
 * expected in practice (the setup guide generates 48 hex characters);
 * a shorter value is treated as not configured (fail-closed).
 */
export const MIN_DOORBELL_CAPABILITY_LENGTH = 16;

export interface WorkerDeps extends SlackEventsDeps {
  signingSecret: string;
  /** Capability segment for the doorbell read route (see EnvBindings). */
  doorbellCapability?: string;
  nowSeconds?: () => number;
  /** Optional per-thread forwarder (the Durable Object route). */
  forwardToThread?: (
    threadId: string,
    rawBody: string,
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
}

export function createWorkerApp(deps: WorkerDeps): Hono {
  const app = new Hono();
  const sequencer = deps.sequencer ?? new ThreadSequencer();
  const nowSeconds =
    deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  app.get('/healthz', (c) => c.text('ok'));

  // Unknown routes answer with the same JSON 404 as a wrong doorbell
  // capability, so the two cannot be told apart by status or body.
  app.notFound((c) => c.json({ error: 'not found' }, 404));

  app.get('/doorbell/:capability/:threadId', async (c) => {
    const capability = deps.doorbellCapability;
    if (
      capability === undefined ||
      capability.length < MIN_DOORBELL_CAPABILITY_LENGTH ||
      c.req.param('capability') !== capability
    ) {
      return c.json({ error: 'not found' }, 404);
    }
    const flag = await deps.doorbell.peek(c.req.param('threadId'));
    return flag === null ? c.json({ flag: null }) : c.json(flag);
  });

  app.post('/slack/events', async (c) => {
    const body = await c.req.text();
    const verified = await verifySlackSignature({
      signingSecret: deps.signingSecret,
      timestamp: c.req.header('x-slack-request-timestamp') ?? '',
      body,
      signature: c.req.header('x-slack-signature') ?? '',
      nowSeconds: nowSeconds(),
    });
    if (!verified) return c.json({ error: 'invalid signature' }, 401);

    const threadId = threadIdFromBody(body);
    if (threadId !== null && deps.forwardToThread !== undefined) {
      const forwarded = await deps.forwardToThread(threadId, body);
      return c.json(forwarded.body, forwarded.status as 200);
    }
    const result = await handleSlackEvent({ ...deps, sequencer }, body);
    const mapped = resultToResponse(result);
    return c.json(mapped.body, mapped.status as 200);
  });

  return app;
}

export function createAppFromEnv(env: EnvBindings): Hono {
  const base = depsFromEnv(env);
  const forwardToThread =
    env.THREAD_LEDGER === undefined
      ? undefined
      : async (threadId: string, rawBody: string) => {
          const ns = env.THREAD_LEDGER!;
          const stub = ns.get(ns.idFromName(threadId));
          const res = await stub.fetch(
            new Request(
              `https://thread-ledger/thread/${encodeURIComponent(threadId)}`,
              { method: 'POST', body: rawBody },
            ),
          );
          return {
            status: res.status,
            body: (await res.json()) as Record<string, unknown>,
          };
        };
  return createWorkerApp({
    ...base,
    signingSecret: env.SLACK_SIGNING_SECRET,
    ...(env.DOORBELL_CAPABILITY === undefined ||
    env.DOORBELL_CAPABILITY === ''
      ? {}
      : { doorbellCapability: env.DOORBELL_CAPABILITY }),
    ...(forwardToThread === undefined ? {} : { forwardToThread }),
  });
}

/**
 * Durable Object: one instance owns one thread. Its fetch runs the same
 * ingress core through the object's own sequencer; because a Durable
 * Object processes one request at a time per instance and the Worker
 * routes by thread id, per-thread processing is serialized globally,
 * not just within an isolate.
 *
 * Trust premise: this fetch performs NO signature verification. The
 * Worker entry verifies the Slack signature before any forwarding, and
 * the forward does not carry the signature headers, so re-verification
 * here is impossible by design. This namespace must only ever be
 * reached through that verified Worker route; it must never be
 * exposed to unverified requests or bound for another caller, or
 * forged events could be written straight into the ledger, the
 * delivery queue and the doorbell.
 */
export class ThreadLedgerObject {
  readonly #env: EnvBindings;
  readonly #sequencer = new ThreadSequencer();

  constructor(_state: unknown, env: EnvBindings) {
    this.#env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const body = await request.text();
    const result = await handleSlackEvent(
      { ...depsFromEnv(this.#env), sequencer: this.#sequencer },
      body,
    );
    const mapped = resultToResponse(result);
    return Response.json(mapped.body, { status: mapped.status });
  }
}

const appCache = new WeakMap<EnvBindings, Hono>();

export default {
  fetch(request: Request, env: EnvBindings): Response | Promise<Response> {
    let app = appCache.get(env);
    if (app === undefined) {
      app = createAppFromEnv(env);
      appCache.set(env, app);
    }
    return app.fetch(request);
  },
};

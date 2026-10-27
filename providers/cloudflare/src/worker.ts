/**
 * Cloudflare provider: the Worker entry.
 *
 * Routes:
 * - GET  /healthz       liveness, no dependencies touched.
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
  THREAD_LEDGER?: DurableObjectNamespaceLike;
}

function depsFromEnv(env: EnvBindings): SlackEventsDeps {
  return {
    store: new D1LedgerStore(env.DB),
    doorbell: new KvDoorbell(env.KV),
    delivery: new QueueDelivery(env.QUEUE),
    participants: JSON.parse(env.PARTICIPANTS_JSON) as Participant[],
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

export interface WorkerDeps extends SlackEventsDeps {
  signingSecret: string;
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
    ...(forwardToThread === undefined ? {} : { forwardToThread }),
  });
}

/**
 * Durable Object: one instance owns one thread. Its fetch runs the same
 * ingress core through the object's own sequencer; because a Durable
 * Object processes one request at a time per instance and the Worker
 * routes by thread id, per-thread processing is serialized globally,
 * not just within an isolate.
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

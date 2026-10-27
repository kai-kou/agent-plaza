import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  ThreadLedgerObject,
  createAppFromEnv,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type DeliveryJob,
  type EnvBindings,
  type KVNamespaceLike,
} from '@agent-plaza/cloudflare';

class FakeD1 implements D1DatabaseLike {
  readonly rows = new Map<string, string>();
  prepare(query: string): D1PreparedStatementLike {
    const self = this;
    let bound: unknown[] = [];
    const stmt: D1PreparedStatementLike = {
      bind(...values: unknown[]) {
        bound = values;
        return stmt;
      },
      async first<T>() {
        if (query.startsWith('SELECT snapshot FROM threads')) {
          const snapshot = self.rows.get(bound[0] as string);
          return (snapshot === undefined ? null : { snapshot }) as T | null;
        }
        throw new Error(`fake D1: unexpected first() for: ${query}`);
      },
      async run() {
        if (query.startsWith('CREATE TABLE IF NOT EXISTS threads')) return {};
        if (query.startsWith('INSERT INTO threads')) {
          self.rows.set(bound[0] as string, bound[1] as string);
          return {};
        }
        throw new Error(`fake D1: unexpected run() for: ${query}`);
      },
    };
    return stmt;
  }
}

class FakeKV implements KVNamespaceLike {
  readonly data = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

const SECRET = 'synthetic-signing-secret';
const PARTICIPANTS = [
  { id: 'slack:U100', displayName: 'Owner', aliases: [], roles: [], kind: 'human' },
  { id: 'slack:U200', displayName: 'Alpha', aliases: ['Alpha'], roles: [], kind: 'agent' },
];

function makeEnv(withDo: boolean) {
  const db = new FakeD1();
  const kv = new FakeKV();
  const jobs: DeliveryJob[] = [];
  const routedThreads: string[] = [];
  const env: EnvBindings = {
    DB: db,
    KV: kv,
    QUEUE: {
      async send(job: DeliveryJob) {
        jobs.push(job);
      },
    },
    SLACK_SIGNING_SECRET: SECRET,
    PARTICIPANTS_JSON: JSON.stringify(PARTICIPANTS),
  };
  if (withDo) {
    const object = new ThreadLedgerObject(null, env);
    env.THREAD_LEDGER = {
      idFromName: (name: string) => name,
      get: (id: unknown) => {
        routedThreads.push(id as string);
        return { fetch: (req: Request) => object.fetch(req) };
      },
    };
  }
  return { env, db, kv, jobs, routedThreads };
}

function signedRequest(body: string): Request {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature =
    'v0=' +
    createHmac('sha256', SECRET)
      .update(`v0:${timestamp}:${body}`)
      .digest('hex');
  return new Request('http://hub.test/slack/events', {
    method: 'POST',
    headers: {
      'x-slack-signature': signature,
      'x-slack-request-timestamp': timestamp,
      'content-type': 'application/json',
    },
    body,
  });
}

const MESSAGE = JSON.stringify({
  type: 'event_callback',
  team_id: 'T1',
  event_id: 'Ev1',
  event: {
    type: 'message',
    user: 'U100',
    channel: 'C1',
    ts: '1793100000.000100',
    text: '<@U200> 調べてほしい',
  },
});

describe('worker app (direct route)', () => {
  it('serves healthz and rejects unsigned requests', async () => {
    const { env } = makeEnv(false);
    const app = createAppFromEnv(env);
    const health = await app.request('http://hub.test/healthz');
    expect(health.status).toBe(200);
    expect(await health.text()).toBe('ok');

    const unsigned = await app.request('http://hub.test/slack/events', {
      method: 'POST',
      body: MESSAGE,
    });
    expect(unsigned.status).toBe(401);
  });

  it('answers a signed challenge and processes a signed message end to end', async () => {
    const { env, db, jobs } = makeEnv(false);
    const app = createAppFromEnv(env);

    const challenge = await app.fetch(
      signedRequest(
        JSON.stringify({ type: 'url_verification', challenge: 'ch-1' }),
      ),
    );
    expect(challenge.status).toBe(200);
    expect(await challenge.json()).toEqual({ challenge: 'ch-1' });

    const res = await app.fetch(signedRequest(MESSAGE));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, kind: 'accepted' });
    expect(db.rows.has('C1:1793100000.000100')).toBe(true);
    expect(jobs).toEqual([
      { threadId: 'C1:1793100000.000100', messageId: 'evt-Ev1' },
    ]);
  });
});

describe('worker app (Durable Object route)', () => {
  it('routes message events to the Durable Object that owns the thread', async () => {
    const { env, db, routedThreads } = makeEnv(true);
    const app = createAppFromEnv(env);
    const res = await app.fetch(signedRequest(MESSAGE));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, kind: 'accepted' });
    expect(routedThreads).toEqual(['C1:1793100000.000100']);
    expect(db.rows.has('C1:1793100000.000100')).toBe(true);
  });
});

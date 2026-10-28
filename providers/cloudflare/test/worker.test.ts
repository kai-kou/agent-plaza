import { describe, it, expect, vi, afterEach } from 'vitest';
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

describe('worker app (channel allowlist)', () => {
  it('ignores messages from channels outside ALLOWED_CHANNEL_IDS_JSON', async () => {
    const { env, db, jobs } = makeEnv(false);
    env.ALLOWED_CHANNEL_IDS_JSON = '["C1"]';
    const app = createAppFromEnv(env);

    const outside = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event_id: 'EvOut',
      event: {
        type: 'message',
        user: 'U100',
        channel: 'C2',
        ts: '1793100000.000100',
        text: '<@U200> hi',
      },
    });
    const resOut = await app.fetch(signedRequest(outside));
    expect(resOut.status).toBe(200);
    expect(await resOut.json()).toEqual({ ok: true, kind: 'ignored' });
    expect(db.rows.size).toBe(0);
    expect(jobs).toHaveLength(0);

    const resIn = await app.fetch(signedRequest(MESSAGE));
    expect(resIn.status).toBe(200);
    expect(await resIn.json()).toEqual({ ok: true, kind: 'accepted' });
  });
});

describe('worker app (doorbell read route)', () => {
  const THREAD = 'C1:1793100000.000100';
  const CAP = 'test-capability-0123456789abcdef';

  function doorbellUrl(cap: string, thread: string): string {
    return `http://hub.test/doorbell/${cap}/${encodeURIComponent(thread)}`;
  }

  it('serves the flag only through the capability path', async () => {
    const { env, kv } = makeEnv(false);
    env.DOORBELL_CAPABILITY = CAP;
    kv.data.set(
      `doorbell:${THREAD}`,
      JSON.stringify({ eventId: 'Ev1', ts: '2026-10-27T00:00:00.000Z' }),
    );
    const app = createAppFromEnv(env);

    const ok = await app.request(doorbellUrl(CAP, THREAD));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      eventId: 'Ev1',
      ts: '2026-10-27T00:00:00.000Z',
    });

    const wrong = await app.request(doorbellUrl('nope', THREAD));
    expect(wrong.status).toBe(404);

    const absent = await app.request(doorbellUrl(CAP, 'C1:9999999999.999999'));
    expect(absent.status).toBe(200);
    expect(await absent.json()).toEqual({ flag: null });
  });

  it('is disabled when no capability is configured', async () => {
    const { env, kv } = makeEnv(false);
    kv.data.set(
      `doorbell:${THREAD}`,
      JSON.stringify({ eventId: 'Ev1', ts: '2026-10-27T00:00:00.000Z' }),
    );
    const app = createAppFromEnv(env);
    const res = await app.request(doorbellUrl(CAP, THREAD));
    expect(res.status).toBe(404);
  });

  it('treats a too-short capability as not configured', async () => {
    const { env, kv } = makeEnv(false);
    env.DOORBELL_CAPABILITY = 'short';
    kv.data.set(
      `doorbell:${THREAD}`,
      JSON.stringify({ eventId: 'Ev1', ts: '2026-10-27T00:00:00.000Z' }),
    );
    const app = createAppFromEnv(env);
    const res = await app.request(doorbellUrl('short', THREAD));
    expect(res.status).toBe(404);
  });

  it('answers unknown routes with the same 404 body as a wrong capability', async () => {
    const { env } = makeEnv(false);
    env.DOORBELL_CAPABILITY = CAP;
    const app = createAppFromEnv(env);
    const unknown = await app.request('http://hub.test/no-such-route');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'not found' });
    const wrong = await app.request(doorbellUrl('nope', THREAD));
    expect(wrong.status).toBe(404);
    expect(await wrong.json()).toEqual({ error: 'not found' });
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

describe('worker app (admin bot post route)', () => {
  const ADMIN_CAP = 'test-admin-capability-0123456789';
  const BOT_TOKEN = 'xoxb-test-bot-token';

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubSlackFetch(response: unknown): { calls: unknown[] } {
    const calls: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      async (url: unknown, init: unknown) => {
        calls.push({ url, init });
        return { json: async () => response };
      },
    );
    return { calls };
  }

  function postRequest(
    capability: string | undefined,
    body: unknown,
  ): Request {
    return new Request('http://hub.test/admin/post', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(capability === undefined
          ? {}
          : { 'x-admin-capability': capability }),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  function makeAdminEnv() {
    const { env } = makeEnv(false);
    env.ADMIN_CAPABILITY = ADMIN_CAP;
    env.SLACK_BOT_TOKEN = BOT_TOKEN;
    env.ALLOWED_CHANNEL_IDS_JSON = '["C1"]';
    return env;
  }

  it('posts as the hub bot to an allowlisted channel', async () => {
    const { calls } = stubSlackFetch({ ok: true, ts: '1793100002.000300' });
    const app = createAppFromEnv(makeAdminEnv());
    const res = await app.fetch(
      postRequest(ADMIN_CAP, { channel: 'C1', text: 'APV1 test' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ts: '1793100002.000300' });
    expect(calls).toHaveLength(1);
  });

  it('passes thread_ts through for thread replies', async () => {
    const { calls } = stubSlackFetch({ ok: true, ts: '1793100003.000400' });
    const app = createAppFromEnv(makeAdminEnv());
    const res = await app.fetch(
      postRequest(ADMIN_CAP, {
        channel: 'C1',
        text: 'reply',
        thread_ts: '1793100000.000100',
      }),
    );
    expect(res.status).toBe(200);
    const sent = calls[0] as {
      init: { body: string };
    };
    expect(JSON.parse(sent.init.body)).toEqual({
      channel: 'C1',
      text: 'reply',
      thread_ts: '1793100000.000100',
    });
  });

  it('is indistinguishable from an unknown route without the capability', async () => {
    stubSlackFetch({ ok: true, ts: '1.2' });
    const app = createAppFromEnv(makeAdminEnv());
    const missing = await app.fetch(
      postRequest(undefined, { channel: 'C1', text: 'hi' }),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not found' });
    const wrong = await app.fetch(
      postRequest('nope', { channel: 'C1', text: 'hi' }),
    );
    expect(wrong.status).toBe(404);
    expect(await wrong.json()).toEqual({ error: 'not found' });
  });

  it('is disabled when the capability or the bot token is not configured', async () => {
    const { calls } = stubSlackFetch({ ok: true, ts: '1.2' });
    const noCap = makeAdminEnv();
    delete noCap.ADMIN_CAPABILITY;
    const resNoCap = await createAppFromEnv(noCap).fetch(
      postRequest(ADMIN_CAP, { channel: 'C1', text: 'hi' }),
    );
    expect(resNoCap.status).toBe(404);

    const shortCap = makeAdminEnv();
    shortCap.ADMIN_CAPABILITY = 'short';
    const resShort = await createAppFromEnv(shortCap).fetch(
      postRequest('short', { channel: 'C1', text: 'hi' }),
    );
    expect(resShort.status).toBe(404);

    const noToken = makeAdminEnv();
    delete noToken.SLACK_BOT_TOKEN;
    const resNoToken = await createAppFromEnv(noToken).fetch(
      postRequest(ADMIN_CAP, { channel: 'C1', text: 'hi' }),
    );
    expect(resNoToken.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('rejects channels outside the allowlist without calling Slack', async () => {
    const { calls } = stubSlackFetch({ ok: true, ts: '1.2' });
    const app = createAppFromEnv(makeAdminEnv());
    const res = await app.fetch(
      postRequest(ADMIN_CAP, { channel: 'C2', text: 'hi' }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'channel not allowed' });
    expect(calls).toHaveLength(0);
  });

  it('rejects empty or oversized text and malformed bodies', async () => {
    const { calls } = stubSlackFetch({ ok: true, ts: '1.2' });
    const app = createAppFromEnv(makeAdminEnv());
    const empty = await app.fetch(
      postRequest(ADMIN_CAP, { channel: 'C1', text: '' }),
    );
    expect(empty.status).toBe(400);
    const oversized = await app.fetch(
      postRequest(ADMIN_CAP, { channel: 'C1', text: 'x'.repeat(4001) }),
    );
    expect(oversized.status).toBe(400);
    const malformed = await app.fetch(postRequest(ADMIN_CAP, 'not json'));
    expect(malformed.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('maps a Slack error to 502 with the Slack error code', async () => {
    stubSlackFetch({ ok: false, error: 'channel_not_found' });
    const app = createAppFromEnv(makeAdminEnv());
    const res = await app.fetch(
      postRequest(ADMIN_CAP, { channel: 'C1', text: 'hi' }),
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'channel_not_found',
    });
  });
});

describe('PARTICIPANTS_JSON element validation', () => {
  it('rejects a participant element without an id', () => {
    const { env } = makeEnv(false);
    env.PARTICIPANTS_JSON = JSON.stringify([
      { displayName: 'NoId', aliases: [], roles: [], kind: 'agent' },
    ]);
    expect(() => createAppFromEnv(env)).toThrow(/PARTICIPANTS_JSON/);
  });

  it('rejects a senderIds that is not an array of strings', () => {
    const { env } = makeEnv(false);
    env.PARTICIPANTS_JSON = JSON.stringify([
      {
        id: 'slack:U300',
        displayName: 'Beta',
        aliases: [],
        roles: [],
        kind: 'agent',
        senderIds: 'slack:U301',
      },
    ]);
    expect(() => createAppFromEnv(env)).toThrow(/PARTICIPANTS_JSON/);
  });

  it('accepts a participant element with a valid senderIds list', () => {
    const { env } = makeEnv(false);
    env.PARTICIPANTS_JSON = JSON.stringify([
      {
        id: 'slack:U300',
        displayName: 'Beta',
        aliases: ['Beta'],
        roles: [],
        kind: 'agent',
        senderIds: ['slack:U301'],
      },
    ]);
    expect(() => createAppFromEnv(env)).not.toThrow();
  });
});

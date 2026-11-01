import { describe, it, expect } from 'vitest';
import {
  D1LedgerStore,
  KvDoorbell,
  QueueDelivery,
  createAppFromEnv,
  createWorkerApp,
  isValidExchangeKeySuffix,
  resolveExchangeCapabilities,
  MAX_EXCHANGE_OBJECT_SIZE,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type DeliveryJob,
  type EnvBindings,
  type KVNamespaceLike,
  type R2BucketLike,
  type R2ObjectBodyLike,
  type R2ObjectLike,
  type WorkerDeps,
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

interface StoredObject {
  bytes: Uint8Array;
  contentType?: string;
}

class FakeBucket implements R2BucketLike {
  readonly objects = new Map<string, StoredObject>();

  async get(key: string): Promise<R2ObjectBodyLike | null> {
    const stored = this.objects.get(key);
    if (stored === undefined) return null;
    const bytes = stored.bytes;
    return {
      size: bytes.byteLength,
      etag: '"fake-etag"',
      httpMetadata:
        stored.contentType === undefined
          ? {}
          : { contentType: stored.contentType },
      arrayBuffer: async () =>
        bytes.slice().buffer as ArrayBuffer,
    };
  }

  async head(key: string): Promise<R2ObjectLike | null> {
    const stored = this.objects.get(key);
    if (stored === undefined) return null;
    return {
      size: stored.bytes.byteLength,
      etag: '"fake-etag"',
      httpMetadata:
        stored.contentType === undefined
          ? {}
          : { contentType: stored.contentType },
    };
  }

  async put(
    key: string,
    value: ArrayBuffer | Uint8Array,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown> {
    const bytes =
      value instanceof Uint8Array ? value : new Uint8Array(value);
    const contentType = options?.httpMetadata?.contentType;
    this.objects.set(key, {
      bytes: bytes.slice(),
      ...(contentType === undefined ? {} : { contentType }),
    });
    return {};
  }
}

const CAP_MARO = 'exchange-capability-for-maro-0123456789abcdef';
const CAP_GOMA = 'exchange-capability-for-goma-0123456789abcdef';

function makeApp(
  options: {
    bucket?: FakeBucket;
    withBucket?: boolean;
    capabilities?: ReadonlyMap<string, string>;
    maxObjectSize?: number;
  } = {},
) {
  const bucket = options.bucket ?? new FakeBucket();
  const deps: WorkerDeps = {
    store: new D1LedgerStore(new FakeD1()),
    doorbell: new KvDoorbell(new FakeKV()),
    delivery: new QueueDelivery({
      async send(_job: DeliveryJob) {},
    }),
    participants: [],
    signingSecret: 'synthetic-signing-secret',
    ...(options.withBucket === false
      ? {}
      : { exchangeBucket: bucket }),
    ...(options.capabilities === undefined
      ? {
          exchangeCapabilities: new Map<string, string>([
            [CAP_MARO, 'exchange/maro/'],
            [CAP_GOMA, 'exchange/goma/'],
          ]),
        }
      : { exchangeCapabilities: options.capabilities }),
    ...(options.maxObjectSize === undefined
      ? {}
      : { exchangeMaxObjectSize: options.maxObjectSize }),
  };
  return { app: createWorkerApp(deps), bucket };
}

function exchangeUrl(capability: string, suffix: string): string {
  return `http://hub.test/exchange/${capability}/${suffix}`;
}

const BYTES = new Uint8Array([0, 1, 2, 3, 250, 251, 252]);

describe('worker app (exchange routes, path form)', () => {
  it('round-trips PUT -> GET with identical bytes under the caller prefix', async () => {
    const { app, bucket } = makeApp();

    const put = await app.request(exchangeUrl(CAP_MARO, 'goma-to-maro.txt'), {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: BYTES.slice(),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({
      ok: true,
      key: 'exchange/maro/goma-to-maro.txt',
      size: BYTES.byteLength,
    });
    // The object lands under the caller's own prefix, nowhere else.
    expect([...bucket.objects.keys()]).toEqual([
      'exchange/maro/goma-to-maro.txt',
    ]);

    const get = await app.request(exchangeUrl(CAP_MARO, 'goma-to-maro.txt'));
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('text/plain');
    expect(get.headers.get('content-length')).toBe(
      String(BYTES.byteLength),
    );
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(BYTES);
  });

  it('supports nested suffixes, joined under the caller prefix', async () => {
    const { app, bucket } = makeApp();
    const put = await app.request(
      exchangeUrl(CAP_MARO, 'sub/dir/note.bin'),
      { method: 'PUT', body: BYTES.slice() },
    );
    expect(put.status).toBe(200);
    expect([...bucket.objects.keys()]).toEqual([
      'exchange/maro/sub/dir/note.bin',
    ]);
  });

  it('cannot escape into another participant prefix by construction', async () => {
    const { app, bucket } = makeApp();
    // The suffix names another participant's directory, but the route
    // key is only a suffix: it is always joined under the caller's own
    // prefix, so the stored key stays inside exchange/maro/.
    const put = await app.request(
      exchangeUrl(CAP_MARO, 'goma/secret.txt'),
      { method: 'PUT', body: BYTES.slice() },
    );
    expect(put.status).toBe(200);
    expect([...bucket.objects.keys()]).toEqual([
      'exchange/maro/goma/secret.txt',
    ]);
    // And the other participant cannot read it with its own capability.
    const cross = await app.request(
      exchangeUrl(CAP_GOMA, 'goma/secret.txt'),
    );
    expect(cross.status).toBe(404);
  });

  it('answers HEAD with the stored size and no body', async () => {
    const { app } = makeApp();
    await app.request(exchangeUrl(CAP_MARO, 'file.bin'), {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: BYTES.slice(),
    });
    const head = await app.request(exchangeUrl(CAP_MARO, 'file.bin'), {
      method: 'HEAD',
    });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(
      String(BYTES.byteLength),
    );
    expect(head.headers.get('content-type')).toBe(
      'application/octet-stream',
    );
    expect(await head.text()).toBe('');
  });

  it('answers 404 for a missing object on GET and HEAD', async () => {
    const { app } = makeApp();
    const get = await app.request(exchangeUrl(CAP_MARO, 'absent.bin'));
    expect(get.status).toBe(404);
    expect(await get.json()).toEqual({ error: 'not found' });
    const head = await app.request(exchangeUrl(CAP_MARO, 'absent.bin'), {
      method: 'HEAD',
    });
    expect(head.status).toBe(404);
  });

  it('answers the same 404 for a wrong capability on GET, PUT and HEAD', async () => {
    const { app, bucket } = makeApp();
    await app.request(exchangeUrl(CAP_MARO, 'file.bin'), {
      method: 'PUT',
      body: BYTES.slice(),
    });
    const wrong = 'wrong-capability-value-0123456789abcdef';
    const get = await app.request(exchangeUrl(wrong, 'file.bin'));
    expect(get.status).toBe(404);
    expect(await get.json()).toEqual({ error: 'not found' });
    const put = await app.request(exchangeUrl(wrong, 'file.bin'), {
      method: 'PUT',
      body: BYTES.slice(),
    });
    expect(put.status).toBe(404);
    const head = await app.request(exchangeUrl(wrong, 'file.bin'), {
      method: 'HEAD',
    });
    expect(head.status).toBe(404);
    // The failed PUT stored nothing new.
    expect([...bucket.objects.keys()]).toEqual(['exchange/maro/file.bin']);
  });

  it('rejects suffixes with dot segments and stores nothing', async () => {
    const { app, bucket } = makeApp();
    // %2F keeps the dot segment inside one URL segment so the request
    // reaches the route un-normalized; the decoded suffix is rejected.
    const put = await app.request(
      `http://hub.test/exchange/${CAP_MARO}/..%2F..%2Fgoma%2Fsecret.txt`,
      { method: 'PUT', body: BYTES.slice() },
    );
    expect(put.status).toBe(400);
    expect(bucket.objects.size).toBe(0);
  });

  it('rejects a GET whose suffix has a dot segment', async () => {
    const { app } = makeApp();
    const get = await app.request(
      `http://hub.test/exchange/${CAP_MARO}/..%2Fsecret.txt`,
    );
    expect(get.status).toBe(400);
    expect(await get.json()).toEqual({ error: 'invalid key' });
  });

  it('answers a wrong capability exactly like an unknown route', async () => {
    const { app } = makeApp();
    const unknown = await app.request('http://hub.test/no-such-route');
    expect(unknown.status).toBe(404);
    const wrong = await app.request(
      exchangeUrl('wrong-capability-value-0123456789abcdef', 'file.bin'),
    );
    expect(wrong.status).toBe(404);
    expect(await wrong.text()).toBe(await unknown.text());
  });

  it('answers 413 for a chunked PUT over the size cap and stores nothing', async () => {
    const { app, bucket } = makeApp({ maxObjectSize: 4 });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(BYTES.slice(0, 3));
        controller.enqueue(BYTES.slice(3));
        controller.close();
      },
    });
    // A streamed body arrives chunked, with no Content-Length for
    // the pre-check to reject: only the post-read cap can stop it.
    const res = await app.request(exchangeUrl(CAP_MARO, 'big.bin'), {
      method: 'PUT',
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(bucket.objects.size).toBe(0);
  });

  it('serves downloads with hardening headers, the stored etag and the default content type', async () => {
    const { app } = makeApp();
    // No explicit content type on the PUT: the stored type defaults
    // to application/octet-stream.
    await app.request(exchangeUrl(CAP_MARO, 'file.bin'), {
      method: 'PUT',
      body: BYTES.slice(),
    });
    const get = await app.request(exchangeUrl(CAP_MARO, 'file.bin'));
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe(
      'application/octet-stream',
    );
    expect(get.headers.get('etag')).toBe('"fake-etag"');
    expect(get.headers.get('content-disposition')).toBe('attachment');
    expect(get.headers.get('x-content-type-options')).toBe('nosniff');
    expect(get.headers.get('content-security-policy')).toBe('sandbox');
    const head = await app.request(exchangeUrl(CAP_MARO, 'file.bin'), {
      method: 'HEAD',
    });
    expect(head.status).toBe(200);
    expect(head.headers.get('etag')).toBe('"fake-etag"');
    expect(head.headers.get('content-disposition')).toBe('attachment');
    expect(head.headers.get('x-content-type-options')).toBe('nosniff');
    expect(head.headers.get('content-security-policy')).toBe('sandbox');
  });

  it('answers 413 for a PUT over the size cap and stores nothing', async () => {
    const { app, bucket } = makeApp({ maxObjectSize: 4 });
    const over = await app.request(exchangeUrl(CAP_MARO, 'big.bin'), {
      method: 'PUT',
      body: BYTES.slice(),
    });
    expect(over.status).toBe(413);
    expect(bucket.objects.size).toBe(0);
    const atCap = await app.request(exchangeUrl(CAP_MARO, 'ok.bin'), {
      method: 'PUT',
      body: BYTES.slice(0, 4),
    });
    expect(atCap.status).toBe(200);
  });

  it('answers 404 when the bucket binding is not configured', async () => {
    const { app } = makeApp({ withBucket: false });
    const get = await app.request(exchangeUrl(CAP_MARO, 'file.bin'));
    expect(get.status).toBe(404);
    expect(await get.json()).toEqual({ error: 'not found' });
    const put = await app.request(exchangeUrl(CAP_MARO, 'file.bin'), {
      method: 'PUT',
      body: BYTES.slice(),
    });
    expect(put.status).toBe(404);
  });

  it('never lets a too-short capability in the map take effect', async () => {
    const { app } = makeApp({
      capabilities: new Map([['short', 'exchange/maro/']]),
    });
    const get = await app.request(exchangeUrl('short', 'file.bin'));
    expect(get.status).toBe(404);
    const put = await app.request(exchangeUrl('short', 'file.bin'), {
      method: 'PUT',
      body: BYTES.slice(),
    });
    expect(put.status).toBe(404);
  });
});

describe('worker app (exchange routes, header form)', () => {
  it('round-trips with the capability in the Authorization header', async () => {
    const { app, bucket } = makeApp();
    const put = await app.request('http://hub.test/exchange/from-maro.txt', {
      method: 'PUT',
      headers: { authorization: `Bearer ${CAP_MARO}` },
      body: BYTES.slice(),
    });
    expect(put.status).toBe(200);
    expect([...bucket.objects.keys()]).toEqual([
      'exchange/maro/from-maro.txt',
    ]);
    const get = await app.request('http://hub.test/exchange/from-maro.txt', {
      headers: { 'x-capability': CAP_MARO },
    });
    expect(get.status).toBe(200);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(BYTES);
  });

  it('answers 404 when no capability is presented', async () => {
    const { app } = makeApp();
    const get = await app.request('http://hub.test/exchange/from-maro.txt');
    expect(get.status).toBe(404);
    expect(await get.json()).toEqual({ error: 'not found' });
    const put = await app.request('http://hub.test/exchange/from-maro.txt', {
      method: 'PUT',
      body: BYTES.slice(),
    });
    expect(put.status).toBe(404);
    const head = await app.request(
      'http://hub.test/exchange/from-maro.txt',
      { method: 'HEAD' },
    );
    expect(head.status).toBe(404);
  });

  it('answers the same 404 for a wrong header capability on GET, PUT and HEAD, storing nothing', async () => {
    const { app, bucket } = makeApp();
    const headers = {
      authorization:
        'Bearer wrong-capability-value-0123456789abcdef',
    };
    const get = await app.request('http://hub.test/exchange/file.bin', {
      headers,
    });
    expect(get.status).toBe(404);
    expect(await get.json()).toEqual({ error: 'not found' });
    const put = await app.request('http://hub.test/exchange/file.bin', {
      method: 'PUT',
      headers,
      body: BYTES.slice(),
    });
    expect(put.status).toBe(404);
    const head = await app.request('http://hub.test/exchange/file.bin', {
      method: 'HEAD',
      headers,
    });
    expect(head.status).toBe(404);
    expect(bucket.objects.size).toBe(0);
  });

  it('answers 404 when the two headers disagree', async () => {
    const { app } = makeApp();
    const res = await app.request('http://hub.test/exchange/from-maro.txt', {
      headers: {
        authorization: `Bearer ${CAP_MARO}`,
        'x-capability': CAP_GOMA,
      },
    });
    expect(res.status).toBe(404);
  });

  it('serves a nested suffix in the header form under the caller prefix', async () => {
    const { app, bucket } = makeApp();
    const put = await app.request('http://hub.test/exchange/sub/file.txt', {
      method: 'PUT',
      headers: { authorization: `Bearer ${CAP_GOMA}` },
      body: BYTES.slice(),
    });
    expect(put.status).toBe(200);
    expect([...bucket.objects.keys()]).toEqual([
      'exchange/goma/sub/file.txt',
    ]);
  });
});

describe('exchange key suffix validation', () => {
  it('accepts plain and nested suffixes', () => {
    expect(isValidExchangeKeySuffix('file.txt')).toBe(true);
    expect(isValidExchangeKeySuffix('a/b/c.bin')).toBe(true);
    expect(isValidExchangeKeySuffix('a..b/file')).toBe(true);
  });

  it('rejects empty, dot-segment, backslash, control and overlong suffixes', () => {
    expect(isValidExchangeKeySuffix('')).toBe(false);
    expect(isValidExchangeKeySuffix('.')).toBe(false);
    expect(isValidExchangeKeySuffix('..')).toBe(false);
    expect(isValidExchangeKeySuffix('a/../b')).toBe(false);
    expect(isValidExchangeKeySuffix('a/./b')).toBe(false);
    expect(isValidExchangeKeySuffix('../goma/secret.txt')).toBe(false);
    expect(isValidExchangeKeySuffix('a\\b')).toBe(false);
    expect(isValidExchangeKeySuffix('a\u0001b')).toBe(false);
    expect(isValidExchangeKeySuffix('/leading')).toBe(false);
    expect(isValidExchangeKeySuffix('trailing/')).toBe(false);
    expect(isValidExchangeKeySuffix('a'.repeat(513))).toBe(false);
    expect(isValidExchangeKeySuffix('a'.repeat(512))).toBe(true);
  });
});

describe('resolveExchangeCapabilities', () => {
  it('maps each capability value to the participant prefix', () => {
    const resolved = resolveExchangeCapabilities(
      JSON.stringify({ 'agent:maro': CAP_MARO, 'agent:goma': CAP_GOMA }),
    );
    expect(resolved.get(CAP_MARO)).toBe('exchange/maro/');
    expect(resolved.get(CAP_GOMA)).toBe('exchange/goma/');
    expect(resolved.size).toBe(2);
  });

  it('returns an empty map when unconfigured', () => {
    expect(resolveExchangeCapabilities(undefined).size).toBe(0);
    expect(resolveExchangeCapabilities('').size).toBe(0);
  });

  it('throws on malformed configuration instead of weakening the route', () => {
    expect(() => resolveExchangeCapabilities('not json')).toThrow();
    expect(() => resolveExchangeCapabilities('[]')).toThrow();
    expect(() =>
      resolveExchangeCapabilities(JSON.stringify({ '': CAP_MARO })),
    ).toThrow();
    expect(() =>
      resolveExchangeCapabilities(
        JSON.stringify({ 'agent:maro': 'too-short' }),
      ),
    ).toThrow();
    expect(() =>
      resolveExchangeCapabilities(
        JSON.stringify({ 'agent:maro': CAP_MARO, 'agent:goma': CAP_MARO }),
      ),
    ).toThrow();
    expect(() =>
      resolveExchangeCapabilities(JSON.stringify({ 'agent:maro': 42 })),
    ).toThrow();
  });

  it('throws when two participant ids derive the same prefix', () => {
    let thrown: unknown;
    try {
      resolveExchangeCapabilities(
        JSON.stringify({ 'agent:maro': CAP_MARO, maro: CAP_GOMA }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    // The error names the participant ids, never a capability value.
    const message = (thrown as Error).message;
    expect(message).toContain('agent:maro');
    expect(message).toContain('maro');
    expect(message).not.toContain(CAP_MARO);
    expect(message).not.toContain(CAP_GOMA);
  });

  it('resolves ids with and without the agent: prefix to distinct prefixes', () => {
    const resolved = resolveExchangeCapabilities(
      JSON.stringify({ 'agent:maro': CAP_MARO, goma: CAP_GOMA }),
    );
    expect(resolved.get(CAP_MARO)).toBe('exchange/maro/');
    expect(resolved.get(CAP_GOMA)).toBe('exchange/goma/');
    expect(resolved.size).toBe(2);
  });
});

describe('exchange limits', () => {
  it('caps one exchanged object at 25 MiB', () => {
    expect(MAX_EXCHANGE_OBJECT_SIZE).toBe(25 * 1024 * 1024);
  });
});

describe('worker app (exchange routes via env wiring)', () => {
  it('round-trips with EXCHANGE_CAPABILITIES_JSON and EXCHANGE_BUCKET', async () => {
    const bucket = new FakeBucket();
    const jobs: DeliveryJob[] = [];
    const env: EnvBindings = {
      DB: new FakeD1(),
      KV: new FakeKV(),
      QUEUE: {
        async send(job: DeliveryJob) {
          jobs.push(job);
        },
      },
      SLACK_SIGNING_SECRET: '<redacted>',
      PARTICIPANTS_JSON: '[]',
      EXCHANGE_CAPABILITIES_JSON: JSON.stringify({
        'agent:maro': CAP_MARO,
      }),
      EXCHANGE_BUCKET: bucket,
    };
    const app = createAppFromEnv(env);
    const put = await app.request(exchangeUrl(CAP_MARO, 'hello.txt'), {
      method: 'PUT',
      body: BYTES.slice(),
    });
    expect(put.status).toBe(200);
    const get = await app.request(exchangeUrl(CAP_MARO, 'hello.txt'));
    expect(get.status).toBe(200);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(BYTES);
  });

  it('fails startup on a malformed EXCHANGE_CAPABILITIES_JSON', () => {
    const env: EnvBindings = {
      DB: new FakeD1(),
      KV: new FakeKV(),
      QUEUE: {
        async send(_job: DeliveryJob) {},
      },
      SLACK_SIGNING_SECRET: '<redacted>',
      PARTICIPANTS_JSON: '[]',
      EXCHANGE_CAPABILITIES_JSON: '{"agent:maro": "short"}',
      EXCHANGE_BUCKET: new FakeBucket(),
    };
    expect(() => createAppFromEnv(env)).toThrow();
  });

  it('fails startup on a syntactically invalid EXCHANGE_CAPABILITIES_JSON', () => {
    const env: EnvBindings = {
      DB: new FakeD1(),
      KV: new FakeKV(),
      QUEUE: {
        async send(_job: DeliveryJob) {},
      },
      SLACK_SIGNING_SECRET: '<redacted>',
      PARTICIPANTS_JSON: '[]',
      EXCHANGE_CAPABILITIES_JSON: '{not json',
      EXCHANGE_BUCKET: new FakeBucket(),
    };
    expect(() => createAppFromEnv(env)).toThrow();
  });
});

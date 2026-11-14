import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  LedgerStore,
  Participant,
  ThreadLedgerSnapshot,
} from '@agent-plaza/core';
import {
  KvDoorbell,
  QueueDelivery,
  createWorkerApp,
  handleSlackEvent,
  resolveDoorbellCapabilityOwners,
  type DeliveryJob,
  type KVNamespaceLike,
  type SlackEventsDeps,
  type WorkerDeps,
} from '@agent-plaza/cloudflare';

// Synthetic participants only (repository rule: no real ids in tests).
const participants: Participant[] = [
  { id: 'slack:U100', displayName: 'Owner', aliases: [], roles: [], kind: 'human' },
  { id: 'slack:U200', displayName: 'Alpha', aliases: ['Alpha'], roles: [], kind: 'agent' },
  { id: 'slack:U300', displayName: 'Beta', aliases: ['Beta'], roles: [], kind: 'agent' },
];

class MapStore implements LedgerStore {
  readonly data = new Map<string, string>();
  async load(threadId: string): Promise<ThreadLedgerSnapshot | null> {
    const raw = this.data.get(threadId);
    return raw === undefined
      ? null
      : (JSON.parse(raw) as ThreadLedgerSnapshot);
  }
  async save(threadId: string, snapshot: ThreadLedgerSnapshot): Promise<void> {
    this.data.set(threadId, JSON.stringify(snapshot));
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

function makeDeps(overrides: Partial<SlackEventsDeps> = {}) {
  const store = new MapStore();
  const kv = new FakeKV();
  const jobs: DeliveryJob[] = [];
  const deps: SlackEventsDeps = {
    store,
    doorbell: new KvDoorbell(kv),
    delivery: new QueueDelivery({
      async send(job: DeliveryJob) {
        jobs.push(job);
      },
    }),
    participants,
    ...overrides,
  };
  return { deps, store, kv, jobs };
}

function messageBody(input: {
  eventId: string;
  user: string;
  text: string;
  ts?: string;
  threadTs?: string;
  subtype?: string;
  botId?: string;
}): string {
  return JSON.stringify({
    type: 'event_callback',
    team_id: 'T1',
    event_id: input.eventId,
    event: {
      type: 'message',
      user: input.user,
      ...(input.botId === undefined ? {} : { bot_id: input.botId }),
      channel: 'C1',
      ts: input.ts ?? '1793100000.000100',
      ...(input.threadTs === undefined ? {} : { thread_ts: input.threadTs }),
      ...(input.subtype === undefined ? {} : { subtype: input.subtype }),
      text: input.text,
    },
  });
}

const pointer = (participantId: string) => `C1:__latest__:${participantId}`;

describe('ingress participant doorbell routing (D-22)', () => {
  it('rings only the addressed participant pointer, plus the shared keys', async () => {
    const { deps } = makeDeps();
    const r = await handleSlackEvent(
      deps,
      messageBody({ eventId: 'Ev1', user: 'U100', text: '<@U200> 調べてほしい' }),
    );
    expect(r.kind).toBe('accepted');
    expect((await deps.doorbell.peek(pointer('slack:U200')))?.eventId).toBe('Ev1');
    expect(await deps.doorbell.peek(pointer('slack:U300'))).toBeNull();
    expect(await deps.doorbell.peek(pointer('slack:U100'))).toBeNull();
    // Dual ring during migration: shared pointer and thread flag move too.
    expect((await deps.doorbell.peek('C1:__latest__'))?.eventId).toBe('Ev1');
    expect(
      (await deps.doorbell.peek('C1:1793100000.000100'))?.eventId,
    ).toBe('Ev1');
    // The participant pointer serves the cursor form as well.
    const since = await deps.doorbell.peekSince(pointer('slack:U200'), null);
    expect(since.events.map((e) => e.eventId)).toEqual(['Ev1']);
  });

  it('rings every participant pointer for a human post with no addressee', async () => {
    const { deps } = makeDeps();
    const r = await handleSlackEvent(
      deps,
      messageBody({ eventId: 'Ev1', user: 'U100', text: 'みなさんへ連絡です' }),
    );
    expect(r.kind).toBe('accepted');
    for (const id of ['slack:U100', 'slack:U200', 'slack:U300']) {
      expect((await deps.doorbell.peek(pointer(id)))?.eventId).toBe('Ev1');
    }
  });

  it('rings no participant pointer for an agent post with no addressee, but keeps the shared ring', async () => {
    const { deps } = makeDeps();
    const r = await handleSlackEvent(
      deps,
      messageBody({ eventId: 'Ev1', user: 'U200', text: '作業メモです' }),
    );
    expect(r.kind).toBe('accepted');
    for (const id of ['slack:U100', 'slack:U200', 'slack:U300']) {
      expect(await deps.doorbell.peek(pointer(id))).toBeNull();
    }
    expect((await deps.doorbell.peek('C1:__latest__'))?.eventId).toBe('Ev1');
    expect(
      (await deps.doorbell.peek('C1:1793100000.000100'))?.eventId,
    ).toBe('Ev1');
  });

  it('fails open for an agent post carrying a complete marker', async () => {
    const { deps } = makeDeps();
    const r = await handleSlackEvent(
      deps,
      messageBody({
        eventId: 'Ev1',
        user: 'U200',
        text: '状況を共有します\n⟦AH1⟧ from=slack:U200 type=REPORT to=slack:U300 cid=synthetic-1',
      }),
    );
    expect(r.kind).toBe('accepted');
    for (const id of ['slack:U100', 'slack:U200', 'slack:U300']) {
      expect((await deps.doorbell.peek(pointer(id)))?.eventId).toBe('Ev1');
    }
  });

  it('fails open to the other thread participants for an unaddressed thread reply', async () => {
    const { deps } = makeDeps();
    const ROOT = '1793100000.000100';
    // Root: an agent post with no addressee (silence on pointers).
    expect(
      (
        await handleSlackEvent(
          deps,
          messageBody({ eventId: 'EvA', user: 'U200', text: '作業を開始します', ts: ROOT }),
        )
      ).kind,
    ).toBe('accepted');
    // Beta joins the thread, addressed to Alpha.
    expect(
      (
        await handleSlackEvent(
          deps,
          messageBody({
            eventId: 'EvB',
            user: 'U300',
            text: '<@U200> 引き継ぎます',
            ts: '1793100000.000200',
            threadTs: ROOT,
          }),
        )
      ).kind,
    ).toBe('accepted');
    expect((await deps.doorbell.peek(pointer('slack:U200')))?.eventId).toBe('EvB');
    // Alpha replies with no addressee: the thread continuation
    // fail-open rings Beta, the other participant in the thread.
    expect(
      (
        await handleSlackEvent(
          deps,
          messageBody({
            eventId: 'EvC',
            user: 'U200',
            text: '了解です',
            ts: '1793100000.000300',
            threadTs: ROOT,
          }),
        )
      ).kind,
    ).toBe('accepted');
    expect((await deps.doorbell.peek(pointer('slack:U300')))?.eventId).toBe('EvC');
    expect((await deps.doorbell.peek(pointer('slack:U200')))?.eventId).toBe('EvB');
  });

  describe('denied-notice stays a broadcast (FR-53 (2))', () => {
    const SMALL_THREAD_CAPS = {
      maxThreadMessages: 2,
      maxPerAgent: 10,
      maxPairRoundTrips: 10,
      maxConsecutiveByAgent: 10,
      maxSameContent: 10,
      maxCorrectionRounds: 3,
    };
    const ROOT_TS = '1793100000.000100';
    const THREAD = `C1:${ROOT_TS}`;

    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    function agentPost(eventId: string, ts: string, text: string): string {
      return messageBody({
        eventId,
        user: 'U200',
        text,
        ts,
        threadTs: ROOT_TS,
        subtype: 'bot_message',
        botId: 'B200',
      });
    }

    it('does not move participant pointers on a denied-notice ring', async () => {
      const { deps } = makeDeps({
        caps: SMALL_THREAD_CAPS,
        deniedNoticeEnabled: true,
      });
      await handleSlackEvent(deps, agentPost('EvA1', '1793100000.000200', '<@U100> one'));
      await handleSlackEvent(deps, agentPost('EvA2', '1793100000.000300', '<@U100> two'));
      // The two accepted posts were addressed to the owner: the
      // owner's participant pointer holds the second accepted event.
      expect((await deps.doorbell.peek(pointer('slack:U100')))?.eventId).toBe('EvA2');

      const denied = await handleSlackEvent(
        deps,
        agentPost('EvD1', '1793100000.000400', '<@U100> three'),
      );
      expect(denied.kind).toBe('denied');
      // The notice rings the shared broadcast keys, as before.
      expect((await deps.doorbell.peek(THREAD))?.eventId).toBe('EvD1');
      expect((await deps.doorbell.peek('C1:__latest__'))?.eventId).toBe('EvD1');
      // Participant pointers are not moved by a denied-notice.
      expect((await deps.doorbell.peek(pointer('slack:U100')))?.eventId).toBe('EvA2');
      expect(await deps.doorbell.peek(pointer('slack:U200'))).toBeNull();
      expect(await deps.doorbell.peek(pointer('slack:U300'))).toBeNull();
    });
  });
});

describe('doorbell read route participant scoping (D-22)', () => {
  const SHARED = 'shared-capability-0123456789abcdef';
  const CAP_ALPHA = 'alpha-capability-0123456789abcdef';
  const CAP_BETA = 'beta-capability-0123456789abcdeff';
  const THREAD = 'C1:1793100000.000100';

  function makeApp() {
    const kv = new FakeKV();
    const deps: WorkerDeps = {
      store: new MapStore(),
      doorbell: new KvDoorbell(kv),
      delivery: new QueueDelivery({
        async send() {},
      }),
      participants,
      signingSecret: 'synthetic-signing-secret',
      doorbellCapabilities: new Set([SHARED, CAP_ALPHA, CAP_BETA]),
      doorbellCapabilityOwners: new Map<string, string | null>([
        [SHARED, null],
        [CAP_ALPHA, 'slack:U200'],
        [CAP_BETA, 'slack:U300'],
      ]),
    };
    return { app: createWorkerApp(deps), kv, doorbell: deps.doorbell };
  }

  function url(cap: string, thread: string): string {
    return `http://hub.test/doorbell/${cap}/${encodeURIComponent(thread)}`;
  }

  it('resolves capability owners: shared maps to null, per-participant values keep their participant', () => {
    const owners = resolveDoorbellCapabilityOwners(
      SHARED,
      JSON.stringify({ 'slack:U200': CAP_ALPHA }),
      { 'slack:U300': CAP_BETA },
    );
    expect(owners.get(SHARED)).toBeNull();
    expect(owners.get(CAP_ALPHA)).toBe('slack:U200');
    expect(owners.get(CAP_BETA)).toBe('slack:U300');
    expect(owners.size).toBe(3);
  });

  it('serves a participant pointer only to its own capability', async () => {
    const { app, doorbell } = makeApp();
    await doorbell.ring(pointer('slack:U200'), 'EvA');
    await doorbell.ring(pointer('slack:U300'), 'EvB');
    await doorbell.ring(THREAD, 'EvT');
    await doorbell.ring('C1:__latest__', 'EvL');

    const own = await app.request(url(CAP_ALPHA, pointer('slack:U200')));
    expect(own.status).toBe(200);
    expect(((await own.json()) as { eventId: string }).eventId).toBe('EvA');

    const other = await app.request(url(CAP_ALPHA, pointer('slack:U300')));
    expect(other.status).toBe(404);

    // Shared keys stay readable with any valid capability during the
    // migration, and the shared capability reads participant pointers.
    expect((await app.request(url(CAP_ALPHA, THREAD))).status).toBe(200);
    expect((await app.request(url(CAP_ALPHA, 'C1:__latest__'))).status).toBe(200);
    expect((await app.request(url(SHARED, pointer('slack:U300')))).status).toBe(200);
    expect((await app.request(url('nope', pointer('slack:U200')))).status).toBe(404);
  });

  it('scopes the since form the same way, in both route presentations', async () => {
    const { app, doorbell } = makeApp();
    await doorbell.ring(pointer('slack:U200'), 'EvA1');
    await doorbell.ring(pointer('slack:U200'), 'EvA2');
    await doorbell.ring(pointer('slack:U300'), 'EvB1');

    const ownSince = await app.request(
      `${url(CAP_ALPHA, pointer('slack:U200'))}?since=EvA1`,
    );
    expect(ownSince.status).toBe(200);
    const body = (await ownSince.json()) as {
      events: { eventId: string }[];
    };
    expect(body.events.map((e) => e.eventId)).toEqual(['EvA2']);

    const otherSince = await app.request(
      `${url(CAP_ALPHA, pointer('slack:U300'))}?since=`,
    );
    expect(otherSince.status).toBe(404);

    // Header form: the same scoping applies.
    const headerUrl = `http://hub.test/doorbell/${encodeURIComponent(pointer('slack:U300'))}`;
    const headerOther = await app.request(headerUrl, {
      headers: { authorization: `Bearer ${CAP_ALPHA}` },
    });
    expect(headerOther.status).toBe(404);
    const headerOwn = await app.request(headerUrl, {
      headers: { authorization: `Bearer ${CAP_BETA}` },
    });
    expect(headerOwn.status).toBe(200);
  });

  it('keeps legacy Set-only wiring unscoped (any capability reads any key)', async () => {
    const kv = new FakeKV();
    const doorbell = new KvDoorbell(kv);
    await doorbell.ring(pointer('slack:U300'), 'EvB');
    const deps: WorkerDeps = {
      store: new MapStore(),
      doorbell,
      delivery: new QueueDelivery({
        async send() {},
      }),
      participants,
      signingSecret: 'synthetic-signing-secret',
      doorbellCapabilities: new Set([CAP_ALPHA]),
    };
    const app = createWorkerApp(deps);
    const res = await app.request(url(CAP_ALPHA, pointer('slack:U300')));
    expect(res.status).toBe(200);
  });
});

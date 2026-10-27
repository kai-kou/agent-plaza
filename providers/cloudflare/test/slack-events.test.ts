import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  ThreadLedger,
  type LedgerStore,
  type Participant,
  type ThreadLedgerSnapshot,
} from '@agent-plaza/core';
import {
  KvDoorbell,
  QueueDelivery,
  handleSlackEvent,
  type DeliveryJob,
  type KVNamespaceLike,
  type SlackEventsDeps,
} from '@agent-plaza/cloudflare';

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

const participants: Participant[] = [
  { id: 'slack:U100', displayName: 'Owner', aliases: [], roles: [], kind: 'human' },
  { id: 'slack:U200', displayName: 'Alpha', aliases: ['Alpha'], roles: ['research'], kind: 'agent' },
];

function makeDeps() {
  const store = new MapStore();
  const kv = new FakeKV();
  const jobs: DeliveryJob[] = [];
  let failNextSend = false;
  const deps: SlackEventsDeps = {
    store,
    doorbell: new KvDoorbell(kv),
    delivery: new QueueDelivery({
      async send(job: DeliveryJob) {
        if (failNextSend) {
          failNextSend = false;
          throw new Error('queue unavailable');
        }
        jobs.push(job);
      },
    }),
    participants,
  };
  return {
    deps,
    store,
    kv,
    jobs,
    failNextQueueSend: () => {
      failNextSend = true;
    },
  };
}

function messageBody(input: {
  eventId: string;
  user: string;
  text: string;
  ts?: string;
  threadTs?: string;
  subtype?: string;
}): string {
  return JSON.stringify({
    type: 'event_callback',
    team_id: 'T1',
    event_id: input.eventId,
    event: {
      type: 'message',
      user: input.user,
      channel: 'C1',
      ts: input.ts ?? '1793100000.000100',
      ...(input.threadTs === undefined ? {} : { thread_ts: input.threadTs }),
      ...(input.subtype === undefined ? {} : { subtype: input.subtype }),
      text: input.text,
    },
  });
}

describe('handleSlackEvent', () => {
  it('answers the url_verification challenge', async () => {
    const { deps } = makeDeps();
    const r = await handleSlackEvent(
      deps,
      JSON.stringify({ type: 'url_verification', challenge: 'abc123' }),
    );
    expect(r).toEqual({ kind: 'challenge', challenge: 'abc123' });
  });

  it('accepts a message: addressed, persisted, enqueued, doorbell rung', async () => {
    const { deps, store, jobs } = makeDeps();
    const text = '<@U200> 調べてほしい';
    const r = await handleSlackEvent(
      deps,
      messageBody({ eventId: 'Ev1', user: 'U100', text }),
    );
    expect(r.kind).toBe('accepted');
    if (r.kind !== 'accepted') throw new Error('unreachable');
    expect(r.entry.envelope.senderId).toBe('slack:U100');
    expect(r.entry.envelope.recipientIds).toEqual(['slack:U200']);
    expect(r.entry.envelope.turnNumber).toBe(1);
    expect(r.entry.state).toBe('queued');
    expect(r.entry.envelope.bodySha256).toBe(
      createHash('sha256').update(text).digest('hex'),
    );
    const loaded = await store.load('C1:1793100000.000100');
    expect(loaded).not.toBeNull();
    expect(
      ThreadLedger.restore(loaded!, {
        participants: new Map(participants.map((p) => [p.id, p.kind] as const)),
      }).entries(),
    ).toHaveLength(1);
    expect(jobs).toEqual([
      { threadId: 'C1:1793100000.000100', messageId: 'evt-Ev1' },
    ]);
    const flag = await deps.doorbell.peek('C1:1793100000.000100');
    expect(flag?.eventId).toBe('Ev1');
  });

  it('treats a Slack retry as a duplicate: one entry, one job', async () => {
    const { deps, store, jobs } = makeDeps();
    const body = messageBody({ eventId: 'Ev1', user: 'U100', text: 'hello' });
    await handleSlackEvent(deps, body);
    const r2 = await handleSlackEvent(deps, body);
    expect(r2.kind).toBe('duplicate');
    const loaded = await store.load('C1:1793100000.000100');
    expect(loaded?.entries).toHaveLength(1);
    expect(jobs).toHaveLength(1);
  });

  it('heals on retry when the first attempt died before enqueueing', async () => {
    const { deps, store, jobs, failNextQueueSend } = makeDeps();
    const body = messageBody({ eventId: 'Ev1', user: 'U100', text: 'hello' });
    failNextQueueSend();
    await expect(handleSlackEvent(deps, body)).rejects.toThrow(
      'queue unavailable',
    );
    // The acceptance is durable even though delivery was not enqueued.
    const mid = await store.load('C1:1793100000.000100');
    expect(mid?.entries[0]?.state).toBe('durably_accepted');

    const r = await handleSlackEvent(deps, body);
    expect(r.kind).toBe('duplicate');
    if (r.kind !== 'duplicate') throw new Error('unreachable');
    expect(r.entry.state).toBe('queued');
    expect(jobs).toHaveLength(1);
  });

  it('denies an unregistered sender and signals nothing', async () => {
    const { deps, store, jobs } = makeDeps();
    const r = await handleSlackEvent(
      deps,
      messageBody({ eventId: 'Ev9', user: 'U999', text: 'hello' }),
    );
    expect(r.kind).toBe('denied');
    expect(store.data.size).toBe(0);
    expect(jobs).toHaveLength(0);
    expect(await deps.doorbell.peek('C1:1793100000.000100')).toBeNull();
  });

  it('ignores subtypes and non-message events, rejects malformed bodies', async () => {
    const { deps } = makeDeps();
    expect(
      (
        await handleSlackEvent(
          deps,
          messageBody({
            eventId: 'Ev2',
            user: 'U100',
            text: 'bot echo',
            subtype: 'bot_message',
          }),
        )
      ).kind,
    ).toBe('ignored');
    expect(
      (
        await handleSlackEvent(
          deps,
          JSON.stringify({
            type: 'event_callback',
            event_id: 'Ev3',
            event: { type: 'reaction_added', user: 'U100' },
          }),
        )
      ).kind,
    ).toBe('ignored');
    expect((await handleSlackEvent(deps, '{not json')).kind).toBe(
      'bad_request',
    );
    expect(
      (
        await handleSlackEvent(
          deps,
          JSON.stringify({
            type: 'event_callback',
            event_id: 'Ev4',
            event: { type: 'message', user: 'U100', channel: 'C1', ts: '1.1' },
          }),
        )
      ).kind,
    ).toBe('bad_request');
  });

  it('nominates the thread root author for replies without a mention', async () => {
    const { deps } = makeDeps();
    const root = await handleSlackEvent(
      deps,
      messageBody({
        eventId: 'EvRoot',
        user: 'U100',
        text: '質問です',
        ts: '1793100000.000100',
      }),
    );
    expect(root.kind).toBe('accepted');
    const reply = await handleSlackEvent(
      deps,
      messageBody({
        eventId: 'EvReply',
        user: 'U200',
        text: '回答です',
        ts: '1793100060.000200',
        threadTs: '1793100000.000100',
      }),
    );
    expect(reply.kind).toBe('accepted');
    if (reply.kind !== 'accepted') throw new Error('unreachable');
    expect(reply.entry.envelope.recipientIds).toEqual(['slack:U100']);
    expect(reply.entry.envelope.turnNumber).toBe(2);
    expect(reply.entry.envelope.threadTs).toBe('1793100000.000100');
  });
});

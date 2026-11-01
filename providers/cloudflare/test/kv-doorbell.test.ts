import { describe, it, expect } from 'vitest';
import {
  KvDoorbell,
  DOORBELL_HISTORY_LIMIT,
  channelLatestThreadId,
  type KVNamespaceLike,
} from '@agent-plaza/cloudflare';

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

describe('KvDoorbell', () => {
  it('rings, peeks and clears; the flag carries only an event id and a timestamp', async () => {
    const kv = new FakeKV();
    const doorbell = new KvDoorbell(kv);
    expect(await doorbell.peek('thread-1')).toBeNull();

    await doorbell.ring('thread-1', 'evt-42');
    const flag = await doorbell.peek('thread-1');
    expect(flag?.eventId).toBe('evt-42');
    expect(typeof flag?.ts).toBe('string');
    expect(Object.keys(JSON.parse(kv.data.get('doorbell:thread-1')!) as object).sort()).toEqual(['eventId', 'ts']);

    // Ringing again replaces the flag.
    await doorbell.ring('thread-1', 'evt-43');
    expect((await doorbell.peek('thread-1'))?.eventId).toBe('evt-43');

    await doorbell.clear('thread-1');
    expect(await doorbell.peek('thread-1')).toBeNull();
  });

  it('treats a malformed stored flag as absent (the doorbell is not a correctness mechanism)', async () => {
    const kv = new FakeKV();
    const doorbell = new KvDoorbell(kv);
    for (const bad of [
      '{oops',
      '{"foo":1}',
      '{"eventId":42,"ts":"2026-10-27T00:00:00.000Z"}',
      '"just a string"',
    ]) {
      kv.data.set('doorbell:thread-1', bad);
      expect(await doorbell.peek('thread-1')).toBeNull();
    }
  });

  it('keeps flags for different threads independent', async () => {
    const doorbell = new KvDoorbell(new FakeKV());
    await doorbell.ring('thread-1', 'evt-1');
    expect(await doorbell.peek('thread-2')).toBeNull();
    expect((await doorbell.peek('thread-1'))?.eventId).toBe('evt-1');
  });

  it('records a bounded history on ring and returns the events after a since cursor', async () => {
    const doorbell = new KvDoorbell(new FakeKV());
    await doorbell.ring('thread-1', 'evt-1');
    await doorbell.ring('thread-1', 'evt-2');
    await doorbell.ring('thread-1', 'evt-3');

    const afterFirst = await doorbell.peekSince('thread-1', 'evt-1');
    expect(afterFirst.outOfRange).toBe(false);
    expect(afterFirst.events.map((f) => f.eventId)).toEqual(['evt-2', 'evt-3']);
    expect(afterFirst.latest?.eventId).toBe('evt-3');

    // A cursor at the latest event yields no events, in range.
    const afterLatest = await doorbell.peekSince('thread-1', 'evt-3');
    expect(afterLatest.outOfRange).toBe(false);
    expect(afterLatest.events).toEqual([]);

    // A null cursor returns everything retained.
    const all = await doorbell.peekSince('thread-1', null);
    expect(all.outOfRange).toBe(false);
    expect(all.events.map((f) => f.eventId)).toEqual(['evt-1', 'evt-2', 'evt-3']);
  });

  it('flags an unknown since cursor as out of range instead of silently returning empty', async () => {
    const doorbell = new KvDoorbell(new FakeKV());
    await doorbell.ring('thread-1', 'evt-1');
    const result = await doorbell.peekSince('thread-1', 'evt-never-seen');
    expect(result.outOfRange).toBe(true);
    // The retained history is still returned so the reader can reconcile.
    expect(result.events.map((f) => f.eventId)).toEqual(['evt-1']);
    expect(result.latest?.eventId).toBe('evt-1');
  });

  it('does not duplicate a consecutively re-rung event in the history', async () => {
    const doorbell = new KvDoorbell(new FakeKV());
    await doorbell.ring('thread-1', 'evt-1');
    await doorbell.ring('thread-1', 'evt-1');
    const all = await doorbell.peekSince('thread-1', null);
    expect(all.events.map((f) => f.eventId)).toEqual(['evt-1']);
  });

  it('bounds the history and ages out the oldest events', async () => {
    const doorbell = new KvDoorbell(new FakeKV());
    for (let i = 1; i <= DOORBELL_HISTORY_LIMIT + 5; i++) {
      await doorbell.ring('thread-1', `evt-${i}`);
    }
    const all = await doorbell.peekSince('thread-1', null);
    expect(all.events.length).toBe(DOORBELL_HISTORY_LIMIT);
    expect(all.events[0]?.eventId).toBe('evt-6');
    // A cursor that aged out is reported out of range.
    const aged = await doorbell.peekSince('thread-1', 'evt-1');
    expect(aged.outOfRange).toBe(true);
  });

  it('treats a malformed stored history as empty, and clearing removes the history too', async () => {
    const kv = new FakeKV();
    const doorbell = new KvDoorbell(kv);
    kv.data.set('doorbell-history:thread-1', '{oops');
    const empty = await doorbell.peekSince('thread-1', null);
    expect(empty.events).toEqual([]);
    expect(empty.outOfRange).toBe(false);

    await doorbell.ring('thread-1', 'evt-1');
    expect((await doorbell.peekSince('thread-1', null)).events.length).toBe(1);
    await doorbell.clear('thread-1');
    expect((await doorbell.peekSince('thread-1', null)).events).toEqual([]);
    expect((await doorbell.peekSince('thread-1', null)).latest).toBeNull();
  });

  it('keeps histories for different threads independent', async () => {
    const doorbell = new KvDoorbell(new FakeKV());
    await doorbell.ring('thread-1', 'evt-1');
    await doorbell.ring('thread-2', 'evt-2');
    expect((await doorbell.peekSince('thread-1', null)).events.map((f) => f.eventId)).toEqual(['evt-1']);
    expect((await doorbell.peekSince('thread-2', null)).events.map((f) => f.eventId)).toEqual(['evt-2']);
  });

  it('derives the channel-latest pointer id, distinct from any real thread id', async () => {
    expect(channelLatestThreadId('C1')).toBe('C1:__latest__');
    const doorbell = new KvDoorbell(new FakeKV());
    await doorbell.ring(channelLatestThreadId('C1'), 'evt-9');
    expect((await doorbell.peek('C1:__latest__'))?.eventId).toBe('evt-9');
    // A real thread flag is independent of the channel pointer.
    expect(await doorbell.peek('C1:1793100000.000100')).toBeNull();
  });
});

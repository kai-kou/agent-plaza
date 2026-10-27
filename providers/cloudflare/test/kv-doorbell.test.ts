import { describe, it, expect } from 'vitest';
import {
  KvDoorbell,
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

  it('derives the channel-latest pointer id, distinct from any real thread id', async () => {
    expect(channelLatestThreadId('C1')).toBe('C1:__latest__');
    const doorbell = new KvDoorbell(new FakeKV());
    await doorbell.ring(channelLatestThreadId('C1'), 'evt-9');
    expect((await doorbell.peek('C1:__latest__'))?.eventId).toBe('evt-9');
    // A real thread flag is independent of the channel pointer.
    expect(await doorbell.peek('C1:1793100000.000100')).toBeNull();
  });
});

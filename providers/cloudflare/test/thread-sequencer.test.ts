import { describe, it, expect } from 'vitest';
import { ThreadSequencer } from '@agent-plaza/cloudflare';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('ThreadSequencer', () => {
  it('runs work for the same thread one at a time, in arrival order', async () => {
    const seq = new ThreadSequencer();
    const order: string[] = [];
    const gate = deferred();
    const first = seq.run('t1', async () => {
      order.push('first:start');
      await gate.promise;
      order.push('first:end');
    });
    const second = seq.run('t1', async () => {
      order.push('second:start');
    });
    // Let the first task start; the second must still be waiting.
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['first:start']);
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('lets different threads proceed in parallel', async () => {
    const seq = new ThreadSequencer();
    const gate = deferred();
    const slow = seq.run('t1', async () => {
      await gate.promise;
      return 'slow';
    });
    const fast = await seq.run('t2', async () => 'fast');
    expect(fast).toBe('fast');
    gate.resolve();
    expect(await slow).toBe('slow');
  });

  it('releases the thread when work throws', async () => {
    const seq = new ThreadSequencer();
    await expect(
      seq.run('t1', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(seq.run('t1', async () => 'recovered')).resolves.toBe(
      'recovered',
    );
  });
});

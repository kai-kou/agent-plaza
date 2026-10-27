/**
 * Cloudflare provider: per-thread serialization.
 *
 * Turn numbers are assigned by the ledger inside a read-modify-write of
 * the thread snapshot, so two events for the same thread must never be
 * processed concurrently. This sequencer chains work per thread id
 * within the current isolate. The cross-isolate guarantee in production
 * comes from routing a thread's requests through its Durable Object
 * (see worker.ts), which uses this same sequencer inside the object;
 * the contract — one thread, one thing at a time, in arrival order — is
 * identical either way.
 */

export class ThreadSequencer {
  readonly #tails = new Map<string, Promise<unknown>>();

  async run<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.#tails.set(threadId, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.#tails.get(threadId) === tail) {
        this.#tails.delete(threadId);
      }
    }
  }
}

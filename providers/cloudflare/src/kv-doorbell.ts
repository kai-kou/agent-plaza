/**
 * Cloudflare provider: the doorbell flag in KV.
 *
 * The doorbell is a latency optimization, never a correctness mechanism:
 * its payload carries only an event id and a timestamp — never a message
 * body (requirements: the doorbell transports no content). A reader that
 * finds a flag wakes up and reads the actual state through the ledger;
 * a lost or unreadable flag is harmless because wake sources are always
 * backed by periodic reconciliation.
 */

export interface KVNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface DoorbellFlag {
  eventId: string;
  /** When the doorbell was rung (ISO 8601), not when the event occurred. */
  ts: string;
}

/**
 * The synthetic thread id whose flag is a channel's latest-event pointer:
 * `doorbell:<channel>:__latest__` names the latest event id rung for the
 * channel. Ingress moves this pointer whenever
 * it rings a thread flag, so a Tier-C reader can poll one key per
 * channel and still notice a brand-new thread — whose real thread id it
 * cannot know in advance — then reconcile against the ledger as usual.
 * The flag carries the same `{eventId, ts}` payload as any other: a
 * pointer, never content. The suffix cannot collide with a real thread
 * id, whose tail is always a Slack timestamp.
 */
export function channelLatestThreadId(channel: string): string {
  return `${channel}:__latest__`;
}

export class KvDoorbell {
  readonly #kv: KVNamespaceLike;

  constructor(kv: KVNamespaceLike) {
    this.#kv = kv;
  }

  static keyFor(threadId: string): string {
    return `doorbell:${threadId}`;
  }

  /**
   * Ring for a thread. The flag is a pointer, not a queue: ringing again
   * replaces it, and peek can only ever return the latest event id. Who
   * clears the flag after consuming it is the reader's convention, fixed
   * where the reader is built; leaving it in place is safe because
   * readers compare the event id against what they already processed.
   */
  async ring(threadId: string, eventId: string): Promise<void> {
    const flag: DoorbellFlag = {
      eventId,
      ts: new Date().toISOString(),
    };
    await this.#kv.put(KvDoorbell.keyFor(threadId), JSON.stringify(flag));
  }

  /** The current flag, or null when absent or unreadable. */
  async peek(threadId: string): Promise<DoorbellFlag | null> {
    const raw = await this.#kv.get(KvDoorbell.keyFor(threadId));
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<DoorbellFlag>;
      if (
        typeof parsed.eventId === 'string' &&
        typeof parsed.ts === 'string'
      ) {
        return { eventId: parsed.eventId, ts: parsed.ts };
      }
      return null;
    } catch {
      return null;
    }
  }

  async clear(threadId: string): Promise<void> {
    await this.#kv.delete(KvDoorbell.keyFor(threadId));
  }
}

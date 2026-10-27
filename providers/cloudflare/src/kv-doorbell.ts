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
  ts: string;
}

export class KvDoorbell {
  readonly #kv: KVNamespaceLike;

  constructor(kv: KVNamespaceLike) {
    this.#kv = kv;
  }

  static keyFor(threadId: string): string {
    return `doorbell:${threadId}`;
  }

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

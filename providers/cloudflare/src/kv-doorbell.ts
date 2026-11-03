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
 * What a history entry signals. `'accepted'` is the ordinary ring for
 * an accepted post; `'denied-notice'` is the transition-only signal
 * for a denied post (FR-53): it carries the same `{eventId, ts}`
 * payload and no content, and exists only in the history — the flag
 * itself stays `{eventId, ts}` so existing readers are unaffected.
 */
export type DoorbellKind = 'accepted' | 'denied-notice';

/**
 * One retained history entry. `kind` is always present on entries
 * written by this version; entries written before `kind` existed read
 * as `'accepted'`.
 */
export interface DoorbellHistoryEntry {
  eventId: string;
  /** When the doorbell was rung (ISO 8601), not when the event occurred. */
  ts: string;
  kind: DoorbellKind;
}

/**
 * How many recent rings are retained per key for the cursor read
 * (`peekSince`). Bounded so the history stays a recovery aid, never a
 * second ledger: once an event ages out of the retained window, a
 * reader holding it as a cursor is told so (`outOfRange`) and falls
 * back to reconciling against the ledger, as FR-9 already requires.
 */
export const DOORBELL_HISTORY_LIMIT = 50;

export interface DoorbellSinceResult {
  /** Retained events rung after the cursor, oldest first. */
  events: DoorbellHistoryEntry[];
  /**
   * True when the cursor names an event that is not in the retained
   * history (unknown, or aged out of the window). The retained events
   * are still returned so the caller can reconcile; an out-of-range
   * cursor is never silently answered with an empty list.
   */
  outOfRange: boolean;
  /** The current flag, or null when absent or unreadable. */
  latest: DoorbellFlag | null;
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

  static historyKeyFor(threadId: string): string {
    return `doorbell-history:${threadId}`;
  }

  /**
   * Ring for a thread. The flag is a pointer, not a queue: ringing again
   * replaces it, and peek can only ever return the latest event id. Who
   * clears the flag after consuming it is the reader's convention, fixed
   * where the reader is built; leaving it in place is safe because
   * readers compare the event id against what they already processed.
   *
   * Alongside the flag, each ring is appended to a bounded history for
   * the same key (see {@link DOORBELL_HISTORY_LIMIT}), which the cursor
   * read (`peekSince`) serves. The history carries the same
   * `{eventId, ts}` pairs as the flag — never content. Its update is a
   * KV read-modify-write, so the loss model is wider than a single
   * entry: two rings racing on one key can lose an entry, and because
   * KV is eventually consistent, an update based on an older snapshot
   * can drop several entries at once or revive entries that had aged
   * out of the window. That is acceptable for the same reason a lost
   * flag is: the doorbell is a latency optimization, and the ledger
   * remains the source of truth readers reconcile against.
   */
  async ring(
    threadId: string,
    eventId: string,
    kind: DoorbellKind = 'accepted',
  ): Promise<void> {
    const flag: DoorbellFlag = {
      eventId,
      ts: new Date().toISOString(),
    };
    await this.#kv.put(KvDoorbell.keyFor(threadId), JSON.stringify(flag));
    const history = await this.#readHistory(threadId);
    if (history[history.length - 1]?.eventId !== eventId) {
      history.push({ ...flag, kind });
    }
    const bounded = history.slice(-DOORBELL_HISTORY_LIMIT);
    await this.#kv.put(
      KvDoorbell.historyKeyFor(threadId),
      JSON.stringify(bounded),
    );
  }

  /**
   * The kind of the most recent retained history entry for a thread,
   * or null when the thread has no retained history. The denied-notice
   * transition check (FR-53) reads this: a thread whose latest entry
   * is already a denied-notice does not ring again until an accepted
   * ring resets it.
   */
  async lastKind(threadId: string): Promise<DoorbellKind | null> {
    const history = await this.#readHistory(threadId);
    return history[history.length - 1]?.kind ?? null;
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

  /**
   * The retained events rung after `sinceEventId`, oldest first, for a
   * reader that polls with a cursor (the last event id it processed).
   * A null cursor returns everything retained. A cursor that names no
   * retained event — unknown, or aged out of the bounded window — is
   * reported with `outOfRange: true` and the full retained history, so
   * the reader can tell "nothing new" from "my cursor fell off" and
   * reconcile instead of silently missing events.
   */
  async peekSince(
    threadId: string,
    sinceEventId: string | null,
  ): Promise<DoorbellSinceResult> {
    const history = await this.#readHistory(threadId);
    const latest = await this.peek(threadId);
    if (sinceEventId === null) {
      return { events: history, outOfRange: false, latest };
    }
    const index = history.findIndex((f) => f.eventId === sinceEventId);
    if (index === -1) {
      return { events: history, outOfRange: true, latest };
    }
    return { events: history.slice(index + 1), outOfRange: false, latest };
  }

  async clear(threadId: string): Promise<void> {
    await this.#kv.delete(KvDoorbell.keyFor(threadId));
    await this.#kv.delete(KvDoorbell.historyKeyFor(threadId));
  }

  /** The retained history for a key; a missing or malformed value reads as empty. */
  async #readHistory(threadId: string): Promise<DoorbellHistoryEntry[]> {
    const raw = await this.#kv.get(KvDoorbell.historyKeyFor(threadId));
    if (raw === null) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // The stored value is a trust boundary: project each entry onto a
      // fresh {eventId, ts, kind} object so extra fields a writer (or a
      // manual edit, or partial corruption) put there are never served
      // or re-persisted, exactly as peek() does for the flag. An entry
      // without a kind (written before kinds existed) reads as
      // 'accepted'; an entry with any other kind value is dropped. The
      // read side also re-applies the retention limit, so an over-long
      // stored value stays bounded (fail-closed).
      return parsed
        .filter(
          (entry): entry is DoorbellHistoryEntry =>
            typeof entry === 'object' &&
            entry !== null &&
            typeof (entry as DoorbellHistoryEntry).eventId === 'string' &&
            typeof (entry as DoorbellHistoryEntry).ts === 'string' &&
            ((entry as DoorbellHistoryEntry).kind === undefined ||
              (entry as DoorbellHistoryEntry).kind === 'accepted' ||
              (entry as DoorbellHistoryEntry).kind === 'denied-notice'),
        )
        .map((entry) => ({
          eventId: entry.eventId,
          ts: entry.ts,
          kind: entry.kind ?? 'accepted',
        }))
        .slice(-DOORBELL_HISTORY_LIMIT);
    } catch {
      return [];
    }
  }
}

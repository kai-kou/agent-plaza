/**
 * Local provider: in-memory LedgerStore.
 *
 * Snapshots pass through a JSON round-trip on both save and load, so this
 * store has exactly the same serializability contract as the SQLite store:
 * anything that would not survive persistence fails here too, in tests.
 */

import type { LedgerStore, ThreadLedgerSnapshot } from '@agent-plaza/core';

export class InMemoryLedgerStore implements LedgerStore {
  readonly #data = new Map<string, string>();

  async load(threadId: string): Promise<ThreadLedgerSnapshot | null> {
    const raw = this.#data.get(threadId);
    return raw === undefined
      ? null
      : (JSON.parse(raw) as ThreadLedgerSnapshot);
  }

  async save(threadId: string, snapshot: ThreadLedgerSnapshot): Promise<void> {
    this.#data.set(threadId, JSON.stringify(snapshot));
  }
}

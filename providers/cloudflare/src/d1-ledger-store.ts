/**
 * Cloudflare provider: D1 LedgerStore.
 *
 * The D1 binding is consumed through a minimal structural interface, so
 * this package needs no Cloudflare SDK or types dependency and the store
 * can be exercised against a fake in tests. The real D1Database binding
 * satisfies the interface. As with every LedgerStore, the snapshot moves
 * as JSON text and is validated by ThreadLedger.restore on the way back.
 */

import type { LedgerStore, ThreadLedgerSnapshot } from '@agent-plaza/core';

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
}

export class D1LedgerStore implements LedgerStore {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.#db = db;
  }

  /** Create the threads table if it does not exist yet. */
  async ensureSchema(): Promise<void> {
    await this.#db
      .prepare(
        'CREATE TABLE IF NOT EXISTS threads (thread_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL)',
      )
      .run();
  }

  async load(threadId: string): Promise<ThreadLedgerSnapshot | null> {
    const row = await this.#db
      .prepare('SELECT snapshot FROM threads WHERE thread_id = ?')
      .bind(threadId)
      .first<{ snapshot: string }>();
    return row === null
      ? null
      : (JSON.parse(row.snapshot) as ThreadLedgerSnapshot);
  }

  async save(threadId: string, snapshot: ThreadLedgerSnapshot): Promise<void> {
    await this.#db
      .prepare(
        'INSERT INTO threads (thread_id, snapshot) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET snapshot = excluded.snapshot',
      )
      .bind(threadId, JSON.stringify(snapshot))
      .run();
  }
}

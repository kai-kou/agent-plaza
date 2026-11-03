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
  /**
   * Multi-row read (the real D1 binding's `all()`). Optional so
   * single-row fakes in existing tests keep working; stores that list
   * rows require it and fail loudly when it is absent.
   */
  all?<T>(): Promise<{ results: T[] }>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
}

export class D1LedgerStore implements LedgerStore {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.#db = db;
  }

  /**
   * Create the threads table if it does not exist yet. For tests and
   * local development only: production schema is owned by the setup
   * procedure (schema.sql, see the provider README), and request-time
   * code never calls this. The store deliberately does not create the
   * table implicitly, so a missing table fails loudly instead of being
   * masked.
   */
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

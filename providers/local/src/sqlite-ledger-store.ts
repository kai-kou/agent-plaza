/**
 * Local provider: SQLite LedgerStore, backed by Node's built-in node:sqlite
 * (no third-party dependency). One row per thread; the snapshot is stored as
 * its JSON serialization and validated by ThreadLedger.restore on the way
 * back into the domain.
 */

import { DatabaseSync } from 'node:sqlite';
import type { LedgerStore, ThreadLedgerSnapshot } from '@agent-plaza/core';

export class SqliteLedgerStore implements LedgerStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(
      'CREATE TABLE IF NOT EXISTS threads (thread_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL)',
    );
  }

  async load(threadId: string): Promise<ThreadLedgerSnapshot | null> {
    const row = this.#db
      .prepare('SELECT snapshot FROM threads WHERE thread_id = ?')
      .get(threadId) as { snapshot: string } | undefined;
    return row === undefined
      ? null
      : (JSON.parse(row.snapshot) as ThreadLedgerSnapshot);
  }

  async save(threadId: string, snapshot: ThreadLedgerSnapshot): Promise<void> {
    this.#db
      .prepare(
        'INSERT INTO threads (thread_id, snapshot) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET snapshot = excluded.snapshot',
      )
      .run(threadId, JSON.stringify(snapshot));
  }

  close(): void {
    this.#db.close();
  }
}

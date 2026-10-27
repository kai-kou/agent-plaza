/**
 * Conversation context: the ledger persistence port.
 *
 * Providers (local SQLite, Cloudflare D1, ...) implement this port; the core
 * never imports a storage SDK. Snapshots are the ThreadLedger's own format
 * (see ledger.ts) and are validated again by ThreadLedger.restore on load,
 * so a store only has to move JSON-shaped data faithfully.
 */

import type { ThreadLedgerSnapshot } from './ledger.js';

export interface LedgerStore {
  load(threadId: string): Promise<ThreadLedgerSnapshot | null>;
  save(threadId: string, snapshot: ThreadLedgerSnapshot): Promise<void>;
}

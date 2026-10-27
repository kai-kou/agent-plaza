import { describe, it, expect } from 'vitest';
import {
  ThreadLedger,
  type MessageEnvelope,
} from '@agent-plaza/core';
import {
  D1LedgerStore,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
} from '@agent-plaza/cloudflare';

/**
 * A minimal fake D1 that understands exactly the statements the store
 * issues. It deliberately matches on the SQL shape so that a change to
 * the store's SQL breaks the fake loudly instead of passing silently.
 */
class FakeD1 implements D1DatabaseLike {
  readonly rows = new Map<string, string>();

  prepare(query: string): D1PreparedStatementLike {
    const rows = this.rows;
    let bound: unknown[] = [];
    const stmt: D1PreparedStatementLike = {
      bind(...values: unknown[]) {
        bound = values;
        return stmt;
      },
      async first<T>() {
        if (query.startsWith('SELECT snapshot FROM threads')) {
          const snapshot = rows.get(bound[0] as string);
          return (snapshot === undefined ? null : { snapshot }) as T | null;
        }
        throw new Error(`fake D1: unexpected first() for: ${query}`);
      },
      async run() {
        if (query.startsWith('CREATE TABLE IF NOT EXISTS threads')) {
          return {};
        }
        if (query.startsWith('INSERT INTO threads')) {
          rows.set(bound[0] as string, bound[1] as string);
          return {};
        }
        throw new Error(`fake D1: unexpected run() for: ${query}`);
      },
    };
    return stmt;
  }
}

const participants = new Map<string, 'human' | 'agent'>([
  ['human-1', 'human'],
  ['agent-a', 'agent'],
]);

let seq = 0;
function envelope(senderId: string): MessageEnvelope {
  seq += 1;
  return {
    messageId: `msg-${seq}`,
    idempotencyKey: `idem-${seq}`,
    tenantId: 'tenant-synthetic',
    channelId: 'channel-synthetic',
    threadTs: null,
    senderId,
    recipientIds: [],
    kind: 'discussion',
    hopCount: 0,
    turnNumber: null,
    issuedAt: '2026-10-27T00:00:00.000Z',
    expiresAt: '2026-10-27T01:00:00.000Z',
    bodyRef: `ledger://msg-${seq}`,
    bodySha256: 'a'.repeat(64),
  };
}

describe('D1LedgerStore (against a fake D1)', () => {
  it('satisfies the LedgerStore contract: null, round-trip fidelity, overwrite, independence', async () => {
    const store = new D1LedgerStore(new FakeD1());
    await store.ensureSchema();
    expect(await store.load('thread-missing')).toBeNull();

    const ledger = new ThreadLedger({ participants });
    const acc = ledger.accept(envelope('human-1'));
    if (!acc.accepted) throw new Error('setup failed');
    ledger.transition(acc.entry.envelope.messageId, 'queued');
    await store.save('thread-1', ledger.snapshot());

    const loaded = await store.load('thread-1');
    expect(loaded).not.toBeNull();
    expect(loaded).toEqual(ledger.snapshot());
    const restored = ThreadLedger.restore(loaded!, { participants });
    expect(restored.entries()).toHaveLength(1);
    expect(restored.entries()[0]?.state).toBe('queued');

    ledger.accept(envelope('agent-a'));
    await store.save('thread-1', ledger.snapshot());
    await store.save('thread-2', new ThreadLedger({ participants }).snapshot());
    expect(
      ThreadLedger.restore((await store.load('thread-1'))!, { participants })
        .entries(),
    ).toHaveLength(2);
    expect(
      ThreadLedger.restore((await store.load('thread-2'))!, { participants })
        .entries(),
    ).toHaveLength(0);
  });

  it('surfaces malformed stored JSON as a SyntaxError, never as an empty thread', async () => {
    const db = new FakeD1();
    db.rows.set('thread-bad', '{not json');
    const store = new D1LedgerStore(db);
    await expect(store.load('thread-bad')).rejects.toBeInstanceOf(SyntaxError);
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ThreadLedger,
  type LedgerStore,
  type MessageEnvelope,
} from '@agent-plaza/core';
import { InMemoryLedgerStore, SqliteLedgerStore } from '@agent-plaza/local';

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

async function exerciseStoreContract(store: LedgerStore): Promise<void> {
  expect(await store.load('thread-missing')).toBeNull();

  const ledger = new ThreadLedger({ participants });
  const acc = ledger.accept(envelope('human-1'));
  if (!acc.accepted) throw new Error('setup failed');
  ledger.transition(acc.entry.envelope.messageId, 'queued');
  await store.save('thread-1', ledger.snapshot());

  const loaded = await store.load('thread-1');
  expect(loaded).not.toBeNull();
  // The full snapshot (entries, states, counters, indexes) survives the
  // round trip unchanged.
  expect(loaded).toEqual(ledger.snapshot());
  const restored = ThreadLedger.restore(loaded!, { participants });
  expect(restored.entries()).toHaveLength(1);
  expect(restored.entries()[0]?.envelope.turnNumber).toBe(1);
  expect(restored.entries()[0]?.state).toBe('queued');

  // Saving again replaces the snapshot for that thread only.
  ledger.accept(envelope('agent-a'));
  await store.save('thread-1', ledger.snapshot());
  await store.save('thread-2', new ThreadLedger({ participants }).snapshot());
  const reloaded = await store.load('thread-1');
  expect(
    ThreadLedger.restore(reloaded!, { participants }).entries(),
  ).toHaveLength(2);
  expect(
    ThreadLedger.restore((await store.load('thread-2'))!, { participants })
      .entries(),
  ).toHaveLength(0);
}

describe('LedgerStore contract: in-memory', () => {
  it('satisfies the contract', async () => {
    await exerciseStoreContract(new InMemoryLedgerStore());
  });
});

describe('LedgerStore contract: sqlite', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('satisfies the contract', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-plaza-sqlite-'));
    dirs.push(dir);
    const store = new SqliteLedgerStore(join(dir, 'ledger.db'));
    try {
      await exerciseStoreContract(store);
    } finally {
      store.close();
    }
  });

  it('survives closing and reopening the database file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-plaza-sqlite-'));
    dirs.push(dir);
    const path = join(dir, 'ledger.db');
    const first = new SqliteLedgerStore(path);
    const ledger = new ThreadLedger({ participants });
    ledger.accept(envelope('human-1'));
    await first.save('thread-1', ledger.snapshot());
    first.close();

    const second = new SqliteLedgerStore(path);
    try {
      const loaded = await second.load('thread-1');
      expect(loaded).not.toBeNull();
      expect(
        ThreadLedger.restore(loaded!, { participants }).entries(),
      ).toHaveLength(1);
    } finally {
      second.close();
    }
  });

  it('surfaces malformed stored JSON as a SyntaxError, never as an empty thread', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-plaza-sqlite-'));
    dirs.push(dir);
    const path = join(dir, 'ledger.db');
    const store = new SqliteLedgerStore(path);
    const raw = new DatabaseSync(path);
    raw
      .prepare('INSERT INTO threads (thread_id, snapshot) VALUES (?, ?)')
      .run('thread-bad', '{not json');
    raw.close();
    try {
      await expect(store.load('thread-bad')).rejects.toBeInstanceOf(
        SyntaxError,
      );
    } finally {
      store.close();
    }
  });
});

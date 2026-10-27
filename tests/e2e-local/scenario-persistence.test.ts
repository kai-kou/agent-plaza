import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Participant } from '@agent-plaza/core';
import {
  FakeSlack,
  LocalHub,
  SqliteLedgerStore,
  type PostDraft,
} from '@agent-plaza/local';

/**
 * Synthetic E2E (level L1) on the local provider: the M1 scenario
 * (human -> A -> B -> A -> conclusion) running on the persistent ledger.
 * The hub is closed and reopened from the SQLite store mid-test and the
 * conversation continues with turn numbers and states intact. No real
 * Slack, no real agents.
 */

const participants: Participant[] = [
  { id: 'human-1', displayName: 'Owner', aliases: [], roles: [], kind: 'human' },
  { id: 'agent-a', displayName: 'Alpha', aliases: ['Alpha'], roles: ['research'], kind: 'agent' },
  { id: 'agent-b', displayName: 'Beta', aliases: ['Beta'], roles: ['review'], kind: 'agent' },
];

function registerScriptedAgents(hub: LocalHub): void {
  hub.registerAgent('agent-a', async (delivered): Promise<PostDraft | null> => {
    if (delivered.senderId === 'human-1') {
      return {
        senderId: 'agent-a',
        addressing: { mentionedIds: ['agent-b'] },
        bodyText: 'Beta レビューしてほしい',
      };
    }
    return {
      senderId: 'agent-a',
      addressing: { mentionedIds: ['human-1'] },
      bodyText: '結論です',
    };
  });
  hub.registerAgent('agent-b', async (): Promise<PostDraft | null> => ({
    senderId: 'agent-b',
    addressing: { mentionedIds: ['agent-a'] },
    bodyText: 'Alpha 指摘を返します',
  }));
}

describe('synthetic E2E with persistence: human -> A -> B -> A -> conclusion, then restart', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('completes the round trip, persists, and continues after reopening the hub', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-plaza-e2e-'));
    dirs.push(dir);
    const dbPath = join(dir, 'ledger.db');
    const slack = new FakeSlack();

    const store1 = new SqliteLedgerStore(dbPath);
    const hub = await LocalHub.open({
      store: store1,
      threadId: 'thread-1',
      channelId: 'channel-synthetic',
      participants,
      slack,
    });
    registerScriptedAgents(hub);

    const r = await hub.post({
      senderId: 'human-1',
      addressing: { mentionedIds: ['agent-a'] },
      bodyText: 'Alpha 調べてほしい',
    });
    expect(r.accepted).toBe(true);

    const entries = hub.entries();
    expect(entries.map((e) => e.envelope.senderId)).toEqual([
      'human-1',
      'agent-a',
      'agent-b',
      'agent-a',
    ]);
    expect(entries.map((e) => e.envelope.turnNumber)).toEqual([1, 2, 3, 4]);
    expect(entries.map((e) => e.envelope.hopCount)).toEqual([0, 0, 1, 2]);
    expect(entries.map((e) => e.state)).toEqual([
      'replied',
      'replied',
      'replied',
      'delivery_accepted',
    ]);
    expect(slack.messages().map((m) => m.bodyText)).toEqual([
      'Alpha 調べてほしい',
      'Beta レビューしてほしい',
      'Alpha 指摘を返します',
      '結論です',
    ]);
    expect(slack.bodyByRef(entries[3]!.envelope.bodyRef)).toBe('結論です');
    store1.close();

    // Reopen hub and store from the same database file: the conversation
    // continues where it left off.
    const store2 = new SqliteLedgerStore(dbPath);
    try {
      const hub2 = await LocalHub.open({
        store: store2,
        threadId: 'thread-1',
        channelId: 'channel-synthetic',
        participants,
        slack,
      });
      registerScriptedAgents(hub2);
      expect(hub2.entries()).toHaveLength(4);
      expect(hub2.entries().map((e) => e.state)).toEqual([
        'replied',
        'replied',
        'replied',
        'delivery_accepted',
      ]);

      const r2 = await hub2.post({
        senderId: 'human-1',
        addressing: { mentionedIds: ['agent-a'] },
        bodyText: 'Alpha もう一つ調べてほしい',
      });
      expect(r2.accepted).toBe(true);
      const all = hub2.entries();
      expect(all).toHaveLength(8);
      expect(all.map((e) => e.envelope.turnNumber)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8,
      ]);
      expect(all[7]?.envelope.senderId).toBe('agent-a');
      expect(slack.bodyByRef(all[7]!.envelope.bodyRef)).toBe('結論です');
    } finally {
      store2.close();
    }
  });

  it('stops an endless agent exchange at the pair cap and never posts the denied reply to Slack', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-plaza-e2e-'));
    dirs.push(dir);
    const store = new SqliteLedgerStore(join(dir, 'ledger.db'));
    try {
      const hub = await LocalHub.open({
        store,
        threadId: 'thread-loop',
        channelId: 'channel-synthetic',
        participants,
      });
      let n = 0;
      hub.registerAgent('agent-a', async (): Promise<PostDraft> => ({
        senderId: 'agent-a',
        addressing: { mentionedIds: ['agent-b'] },
        bodyText: `A の返信 ${(n += 1)}`,
      }));
      hub.registerAgent('agent-b', async (): Promise<PostDraft> => ({
        senderId: 'agent-b',
        addressing: { mentionedIds: ['agent-a'] },
        bodyText: `B の返信 ${(n += 1)}`,
      }));

      await hub.post({
        senderId: 'human-1',
        addressing: { mentionedIds: ['agent-a'] },
        bodyText: 'Alpha 始めて',
      });

      const entries = hub.entries();
      // 1 human + 6 agent messages (pair cap), the 7th agent reply denied.
      expect(entries).toHaveLength(7);
      expect(hub.slack.messages()).toHaveLength(7);
      expect(
        hub.slack.messages().map((m) => m.bodyText),
      ).not.toContain('A の返信 7');
      expect(entries[6]?.state).toBe('started');
    } finally {
      store.close();
    }
  });
});

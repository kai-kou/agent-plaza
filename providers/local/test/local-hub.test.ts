import { describe, it, expect } from 'vitest';
import type { Participant } from '@agent-plaza/core';
import { InMemoryLedgerStore, LocalHub } from '@agent-plaza/local';

const participants: Participant[] = [
  { id: 'human-1', displayName: 'Owner', aliases: [], roles: [], kind: 'human' },
  { id: 'agent-a', displayName: 'Alpha', aliases: ['Alpha'], roles: ['research'], kind: 'agent' },
  { id: 'agent-b', displayName: 'Beta', aliases: ['Beta'], roles: ['review'], kind: 'agent' },
];

async function openHub(store: InMemoryLedgerStore, threadId = 'thread-x') {
  return LocalHub.open({
    store,
    threadId,
    channelId: 'channel-synthetic',
    participants,
  });
}

describe('LocalHub composition behavior', () => {
  it('rejects an unregistered sender and posts nothing to Slack', async () => {
    const hub = await openHub(new InMemoryLedgerStore());
    const r = await hub.post({
      senderId: 'ghost',
      addressing: { mentionedIds: ['agent-a'] },
      bodyText: '誰かいますか',
    });
    expect(r.accepted).toBe(false);
    if (!r.accepted && !r.accept.accepted && 'errors' in r.accept) {
      expect(r.accept.errors.join(' ')).toContain(
        'not a registered participant',
      );
    }
    expect(hub.entries()).toHaveLength(0);
    expect(hub.slack.messages()).toHaveLength(0);
  });

  it('leaves the entry started when the agent handler answers null (silence)', async () => {
    const hub = await openHub(new InMemoryLedgerStore());
    hub.registerAgent('agent-a', async () => null);
    const r = await hub.post({
      senderId: 'human-1',
      addressing: { mentionedIds: ['agent-a'] },
      bodyText: 'Alpha 見てる？',
    });
    expect(r.accepted).toBe(true);
    expect(hub.entries()).toHaveLength(1);
    expect(hub.entries()[0]?.state).toBe('started');
    expect(hub.slack.messages()).toHaveLength(1);
  });

  it('marks the entry failed and propagates when a handler throws', async () => {
    const hub = await openHub(new InMemoryLedgerStore());
    hub.registerAgent('agent-a', async () => {
      throw new Error('agent exploded');
    });
    await expect(
      hub.post({
        senderId: 'human-1',
        addressing: { mentionedIds: ['agent-a'] },
        bodyText: 'Alpha お願い',
      }),
    ).rejects.toThrow('agent exploded');
    expect(hub.entries()[0]?.state).toBe('failed');
  });

  it('passes a correction through the hub onto the ledger entry', async () => {
    const hub = await openHub(new InMemoryLedgerStore());
    const first = await hub.post({
      senderId: 'human-1',
      addressing: { mentionedIds: ['agent-a'] },
      bodyText: 'Alpha 調べてほしい',
    });
    if (!first.accepted) throw new Error('setup failed');
    const target = first.entry.envelope.messageId;
    const fix = await hub.post({
      senderId: 'agent-a',
      addressing: { mentionedIds: ['human-1'] },
      bodyText: '先ほどの件、訂正します',
      correctsMessageId: target,
    });
    expect(fix.accepted).toBe(true);
    if (fix.accepted) expect(fix.entry.correctsMessageId).toBe(target);
  });

  it('delivers one post to several agents on broadcast; each reply is its own entry', async () => {
    const hub = await openHub(new InMemoryLedgerStore());
    hub.registerAgent('agent-a', async () => ({
      senderId: 'agent-a',
      addressing: { mentionedIds: ['human-1'] },
      bodyText: 'Alpha の見解です',
    }));
    hub.registerAgent('agent-b', async () => ({
      senderId: 'agent-b',
      addressing: { mentionedIds: ['human-1'] },
      bodyText: 'Beta の見解です',
    }));
    const r = await hub.post({
      senderId: 'human-1',
      addressing: { broadcast: true },
      bodyText: '全員に聞きたい',
    });
    expect(r.accepted).toBe(true);
    const entries = hub.entries();
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.envelope.senderId)).toEqual([
      'human-1',
      'agent-a',
      'agent-b',
    ]);
    expect(entries[0]?.state).toBe('replied');
  });

  it('never reuses a message id after reopen, even when denied posts consumed sequence numbers', async () => {
    const store = new InMemoryLedgerStore();
    const hub = await openHub(store);
    const p1 = await hub.post({
      senderId: 'human-1',
      addressing: { mentionedIds: ['agent-a'] },
      bodyText: '一つ目',
    });
    expect(p1.accepted).toBe(true);
    const denied = await hub.post({
      senderId: 'ghost',
      bodyText: '割り込み',
    });
    expect(denied.accepted).toBe(false);
    const p3 = await hub.post({
      senderId: 'agent-a',
      addressing: { mentionedIds: ['human-1'] },
      bodyText: '三つ目',
    });
    expect(p3.accepted).toBe(true);

    const hub2 = await openHub(store);
    const p4 = await hub2.post({
      senderId: 'human-1',
      addressing: { mentionedIds: ['agent-a'] },
      bodyText: '四つ目（再オープン後）',
    });
    expect(p4.accepted).toBe(true);
    if (p4.accepted) {
      expect(p4.entry.envelope.messageId).toBe('msg-thread-x-4');
      expect(hub2.slack.bodyByRef(p4.entry.envelope.bodyRef)).toBe(
        '四つ目（再オープン後）',
      );
    }
    expect(hub2.entries().map((e) => e.envelope.turnNumber)).toEqual([1, 2, 3]);
  });

  it('refuses to reopen a thread whose stored identity does not match the options', async () => {
    const store = new InMemoryLedgerStore();
    const hub = await openHub(store);
    await hub.post({ senderId: 'human-1', bodyText: '最初の投稿' });
    await expect(
      LocalHub.open({
        store,
        threadId: 'thread-x',
        channelId: 'channel-other',
        participants,
      }),
    ).rejects.toThrow('identity');
  });
});

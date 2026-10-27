import { describe, it, expect } from 'vitest';
import {
  validateEnvelope,
  decideAddressing,
  evaluateLoopGuard,
  recordAgentPost,
  resetForHumanPost,
  type AddressingInput,
  type MessageEnvelope,
  type Participant,
  type ThreadActivity,
} from '../../packages/core/src/index.js';

/**
 * Synthetic E2E (level L1): a fake hub wiring the core domain together with
 * scripted fake agents. No real Slack, no real agents. This is the seed of
 * the conformance scenario "human -> A -> B -> A -> conclusion".
 */

const participants: Participant[] = [
  { id: 'human-1', displayName: 'Owner', aliases: [], roles: [], kind: 'human' },
  { id: 'agent-a', displayName: 'Alpha', aliases: ['Alpha'], roles: ['research'], kind: 'agent' },
  { id: 'agent-b', displayName: 'Beta', aliases: ['Beta'], roles: ['review'], kind: 'agent' },
];

type PostResult =
  | { accepted: true; envelope: MessageEnvelope }
  | { accepted: false; reason: string };

class FakeHub {
  ledger: MessageEnvelope[] = [];
  activity: ThreadActivity = resetForHumanPost();
  private seq = 0;

  post(
    senderId: string,
    addressing: Partial<AddressingInput>,
    bodyText: string,
  ): PostResult {
    this.seq += 1;
    const n = this.seq;
    const decision = decideAddressing(
      {
        mentionedIds: [],
        threadNominationId: null,
        bodyText,
        roleMentions: [],
        broadcast: false,
        senderId,
        ...addressing,
      },
      participants,
    );
    const envelope: MessageEnvelope = {
      messageId: `msg-${n}`,
      idempotencyKey: `idem-${n}`,
      tenantId: 'tenant-synthetic',
      channelId: 'channel-synthetic',
      threadTs: 'thread-1',
      senderId,
      recipientIds: decision.recipients,
      kind: 'discussion',
      hopCount: 0,
      turnNumber: null,
      issuedAt: new Date(Date.UTC(2026, 9, 27, 0, n)).toISOString(),
      expiresAt: new Date(Date.UTC(2026, 9, 27, 1, n)).toISOString(),
      bodyRef: `ledger://msg-${n}`,
      bodySha256: n.toString(16).padStart(64, '0'),
    };
    const v = validateEnvelope(envelope);
    if (!v.ok) return { accepted: false, reason: v.errors.join('; ') };

    const sender = participants.find((p) => p.id === senderId);
    if (sender?.kind === 'agent') {
      const verdict = evaluateLoopGuard(this.activity, {
        senderId,
        recipientId:
          decision.recipients.length === 1 ? decision.recipients[0] : undefined,
        contentHash: envelope.bodySha256,
      });
      if (!verdict.allowed) return { accepted: false, reason: verdict.reason };
      this.activity = recordAgentPost(this.activity, {
        senderId,
        recipientId:
          decision.recipients.length === 1 ? decision.recipients[0] : undefined,
        contentHash: envelope.bodySha256,
      });
    } else {
      this.activity = resetForHumanPost();
    }

    const accepted: MessageEnvelope = {
      ...envelope,
      turnNumber: this.ledger.length + 1,
    };
    this.ledger.push(accepted);
    return { accepted: true, envelope: accepted };
  }
}

describe('synthetic E2E: human -> A -> B -> A -> conclusion', () => {
  it('completes the round trip with sequential turn numbers', () => {
    const hub = new FakeHub();

    const r1 = hub.post('human-1', { mentionedIds: ['agent-a'] }, 'Alpha 調べてほしい');
    const r2 = hub.post('agent-a', { mentionedIds: ['agent-b'] }, 'Beta レビューしてほしい');
    const r3 = hub.post('agent-b', { mentionedIds: ['agent-a'] }, 'Alpha 指摘を返します');
    const r4 = hub.post('agent-a', { mentionedIds: ['human-1'] }, '結論です');

    for (const r of [r1, r2, r3, r4]) expect(r.accepted).toBe(true);
    expect(hub.ledger.map((e) => e.senderId)).toEqual([
      'human-1',
      'agent-a',
      'agent-b',
      'agent-a',
    ]);
    expect(hub.ledger.map((e) => e.turnNumber)).toEqual([1, 2, 3, 4]);
  });

  it('stops two agents that keep replying to each other at the pair cap', () => {
    const hub = new FakeHub();
    hub.post('human-1', { mentionedIds: ['agent-a'] }, 'Alpha 始めて');

    let lastReason = '';
    let current: 'agent-a' | 'agent-b' = 'agent-a';
    for (let i = 0; i < 50; i++) {
      const other: 'agent-a' | 'agent-b' = current === 'agent-a' ? 'agent-b' : 'agent-a';
      const r = hub.post(current, { mentionedIds: [other] }, `返信 ${i}`);
      if (!r.accepted) {
        lastReason = r.reason;
        break;
      }
      current = other;
    }

    expect(lastReason).toBe('pair_roundtrip_cap');
    const agentMessages = hub.ledger.filter((e) => e.senderId !== 'human-1');
    expect(agentMessages.length).toBe(6);
  });
});

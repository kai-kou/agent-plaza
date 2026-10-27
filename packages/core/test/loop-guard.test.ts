import { describe, it, expect } from 'vitest';
import {
  evaluateLoopGuard,
  recordAgentPost,
  resetForHumanPost,
  pairKey,
  DEFAULT_LOOP_CAPS,
  type ThreadActivity,
} from '@agent-plaza/core';

function activity(overrides: Partial<ThreadActivity> = {}): ThreadActivity {
  return {
    totalAgentMessages: 0,
    perAgentCounts: {},
    lastSenderId: null,
    consecutiveByLastSender: 0,
    pairExchanges: {},
    contentOccurrences: {},
    ...overrides,
  };
}

describe('loop guard (D-5 caps)', () => {
  it('exposes the decided default caps', () => {
    expect(DEFAULT_LOOP_CAPS).toEqual({
      maxThreadMessages: 20,
      maxPerAgent: 7,
      maxPairRoundTrips: 6,
      maxConsecutiveByAgent: 2,
      maxSameContent: 2,
      maxCorrectionRounds: 3,
    });
  });

  it('allows a first agent post in an empty thread', () => {
    const v = evaluateLoopGuard(activity(), {
      senderId: 'agent-a',
      contentHash: 'h1',
    });
    expect(v.allowed).toBe(true);
  });

  it('denies the post that would exceed the thread cap', () => {
    const v = evaluateLoopGuard(activity({ totalAgentMessages: 20 }), {
      senderId: 'agent-a',
      contentHash: 'h1',
    });
    expect(v).toEqual({ allowed: false, reason: 'thread_cap' });
  });

  it('denies the post that would exceed the per-agent cap', () => {
    const v = evaluateLoopGuard(
      activity({ totalAgentMessages: 7, perAgentCounts: { 'agent-a': 7 } }),
      { senderId: 'agent-a', contentHash: 'h1' },
    );
    expect(v).toEqual({ allowed: false, reason: 'per_agent_cap' });
  });

  it('denies a third consecutive post by the same agent', () => {
    const v = evaluateLoopGuard(
      activity({
        totalAgentMessages: 2,
        perAgentCounts: { 'agent-a': 2 },
        lastSenderId: 'agent-a',
        consecutiveByLastSender: 2,
      }),
      { senderId: 'agent-a', contentHash: 'h1' },
    );
    expect(v).toEqual({ allowed: false, reason: 'consecutive_cap' });
  });

  it('allows a different agent to post after two consecutive posts', () => {
    const v = evaluateLoopGuard(
      activity({
        totalAgentMessages: 2,
        perAgentCounts: { 'agent-a': 2 },
        lastSenderId: 'agent-a',
        consecutiveByLastSender: 2,
      }),
      { senderId: 'agent-b', contentHash: 'h1' },
    );
    expect(v.allowed).toBe(true);
  });

  it('denies the third occurrence of identical content', () => {
    const v = evaluateLoopGuard(
      activity({ contentOccurrences: { h1: 2 } }),
      { senderId: 'agent-a', contentHash: 'h1' },
    );
    expect(v).toEqual({ allowed: false, reason: 'same_content_cap' });
  });

  it('denies the exchange that would exceed the pair round-trip cap', () => {
    const v = evaluateLoopGuard(
      activity({ pairExchanges: { 'agent-a|agent-b': 6 } }),
      { senderId: 'agent-a', recipientId: 'agent-b', contentHash: 'h1' },
    );
    expect(v).toEqual({ allowed: false, reason: 'pair_roundtrip_cap' });
  });
});

describe('recordAgentPost', () => {
  it('folds counts, treats a pair symmetrically, and does not mutate the input', () => {
    const before = activity();
    let a = recordAgentPost(before, {
      senderId: 'agent-a',
      recipientId: 'agent-b',
      contentHash: 'h1',
    });
    a = recordAgentPost(a, {
      senderId: 'agent-b',
      recipientId: 'agent-a',
      contentHash: 'h2',
    });
    expect(a.totalAgentMessages).toBe(2);
    expect(a.perAgentCounts).toEqual({ 'agent-a': 1, 'agent-b': 1 });
    expect(a.pairExchanges).toEqual({ [pairKey('agent-a', 'agent-b')]: 2 });
    expect(a.contentOccurrences).toEqual({ h1: 1, h2: 1 });
    expect(before).toEqual(activity());
  });

  it('tracks consecutive posts by the same agent and resets the streak on a different sender', () => {
    let a = recordAgentPost(activity(), { senderId: 'agent-a', contentHash: 'h1' });
    a = recordAgentPost(a, { senderId: 'agent-a', contentHash: 'h2' });
    expect(a.consecutiveByLastSender).toBe(2);
    a = recordAgentPost(a, { senderId: 'agent-b', contentHash: 'h3' });
    expect(a.lastSenderId).toBe('agent-b');
    expect(a.consecutiveByLastSender).toBe(1);
  });
});

describe('resetForHumanPost', () => {
  it('clears the counters so a capped pair can post again after a human post', () => {
    let a = activity();
    for (let i = 0; i < 6; i++) {
      a = recordAgentPost(a, {
        senderId: i % 2 === 0 ? 'agent-a' : 'agent-b',
        recipientId: i % 2 === 0 ? 'agent-b' : 'agent-a',
        contentHash: `h${i}`,
      });
    }
    const denied = evaluateLoopGuard(a, {
      senderId: 'agent-a',
      recipientId: 'agent-b',
      contentHash: 'h-new',
    });
    expect(denied).toEqual({ allowed: false, reason: 'pair_roundtrip_cap' });

    const reset = resetForHumanPost();
    expect(reset).toEqual(activity());
    const allowed = evaluateLoopGuard(reset, {
      senderId: 'agent-a',
      recipientId: 'agent-b',
      contentHash: 'h-new',
    });
    expect(allowed.allowed).toBe(true);
  });
});

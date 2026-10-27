import { describe, it, expect } from 'vitest';
import {
  evaluateLoopGuard,
  DEFAULT_LOOP_CAPS,
  type ThreadActivity,
} from '../src/governance/loop-guard.js';

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

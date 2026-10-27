/**
 * Governance context: loop prevention.
 *
 * Caps are the values decided in D-5 (REQUIREMENTS.md). They are configuration,
 * not constants of nature: callers pass caps explicitly, and DEFAULT_LOOP_CAPS
 * is the decided starting set. Human posts reset the underlying activity
 * counters (hop count and exchanges): this module provides the cleared
 * activity via resetForHumanPost, and the caller applies it when it folds a
 * human message into the ledger.
 */

export interface LoopCaps {
  maxThreadMessages: number;
  maxPerAgent: number;
  maxPairRoundTrips: number;
  maxConsecutiveByAgent: number;
  maxSameContent: number;
  maxCorrectionRounds: number;
}

export const DEFAULT_LOOP_CAPS: LoopCaps = {
  maxThreadMessages: 20,
  maxPerAgent: 7,
  maxPairRoundTrips: 6,
  maxConsecutiveByAgent: 2,
  maxSameContent: 2,
  maxCorrectionRounds: 3,
};

/** Agent-side activity accumulated for one thread since the last human post. */
export interface ThreadActivity {
  totalAgentMessages: number;
  perAgentCounts: Record<string, number>;
  lastSenderId: string | null;
  consecutiveByLastSender: number;
  /** Key: the two participant ids, sorted, joined with "|". */
  pairExchanges: Record<string, number>;
  /** Key: content hash of a posted body. */
  contentOccurrences: Record<string, number>;
}

export interface LoopCandidate {
  senderId: string;
  /** Set when the post addresses exactly one participant. */
  recipientId?: string | undefined;
  contentHash: string;
}

export type LoopDenyReason =
  | 'thread_cap'
  | 'per_agent_cap'
  | 'consecutive_cap'
  | 'pair_roundtrip_cap'
  | 'same_content_cap';

export type LoopVerdict =
  | { allowed: true }
  | { allowed: false; reason: LoopDenyReason };

export function pairKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

export function evaluateLoopGuard(
  activity: ThreadActivity,
  candidate: LoopCandidate,
  caps: LoopCaps = DEFAULT_LOOP_CAPS,
): LoopVerdict {
  if (activity.totalAgentMessages + 1 > caps.maxThreadMessages) {
    return { allowed: false, reason: 'thread_cap' };
  }
  const bySender = activity.perAgentCounts[candidate.senderId] ?? 0;
  if (bySender + 1 > caps.maxPerAgent) {
    return { allowed: false, reason: 'per_agent_cap' };
  }
  if (
    activity.lastSenderId === candidate.senderId &&
    activity.consecutiveByLastSender + 1 > caps.maxConsecutiveByAgent
  ) {
    return { allowed: false, reason: 'consecutive_cap' };
  }
  if (candidate.recipientId !== undefined) {
    const exchanges =
      activity.pairExchanges[pairKey(candidate.senderId, candidate.recipientId)] ?? 0;
    if (exchanges + 1 > caps.maxPairRoundTrips) {
      return { allowed: false, reason: 'pair_roundtrip_cap' };
    }
  }
  const seen = activity.contentOccurrences[candidate.contentHash] ?? 0;
  if (seen + 1 > caps.maxSameContent) {
    return { allowed: false, reason: 'same_content_cap' };
  }
  return { allowed: true };
}

/** Fold one accepted agent post into the activity counters. */
export function recordAgentPost(
  activity: ThreadActivity,
  post: LoopCandidate,
): ThreadActivity {
  const next: ThreadActivity = {
    totalAgentMessages: activity.totalAgentMessages + 1,
    perAgentCounts: { ...activity.perAgentCounts },
    lastSenderId: post.senderId,
    consecutiveByLastSender:
      activity.lastSenderId === post.senderId
        ? activity.consecutiveByLastSender + 1
        : 1,
    pairExchanges: { ...activity.pairExchanges },
    contentOccurrences: { ...activity.contentOccurrences },
  };
  next.perAgentCounts[post.senderId] =
    (next.perAgentCounts[post.senderId] ?? 0) + 1;
  if (post.recipientId !== undefined) {
    const key = pairKey(post.senderId, post.recipientId);
    next.pairExchanges[key] = (next.pairExchanges[key] ?? 0) + 1;
  }
  next.contentOccurrences[post.contentHash] =
    (next.contentOccurrences[post.contentHash] ?? 0) + 1;
  return next;
}

/** A human post resets the agent-side counters (D-5 design). */
export function resetForHumanPost(): ThreadActivity {
  return {
    totalAgentMessages: 0,
    perAgentCounts: {},
    lastSenderId: null,
    consecutiveByLastSender: 0,
    pairExchanges: {},
    contentOccurrences: {},
  };
}

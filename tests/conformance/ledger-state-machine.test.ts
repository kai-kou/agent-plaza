import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  LEDGER_TRANSITIONS,
  ThreadLedger,
  type LedgerEntryState,
  type MessageEnvelope,
} from '@agent-plaza/core';

/**
 * Conformance: spec/ledger-state-machine.json is the canonical definition
 * of the ledger entry state machine. These tests pin both the exported
 * transition table and the observable behavior of ThreadLedger.transition
 * to that file: every (from, to) pair over the stored states is exercised.
 */

interface StateMachineSpec {
  initial: string;
  states: string[];
  terminal: string[];
  transitions: Record<string, string[]>;
}

const spec = JSON.parse(
  readFileSync(
    new URL('../../spec/ledger-state-machine.json', import.meta.url),
    'utf8',
  ),
) as StateMachineSpec;

const participants = new Map<string, 'human' | 'agent'>([
  ['human-1', 'human'],
  ['agent-a', 'agent'],
]);

let seq = 0;
function envelope(): MessageEnvelope {
  seq += 1;
  return {
    messageId: `sm-msg-${seq}`,
    idempotencyKey: `sm-idem-${seq}`,
    tenantId: 'tenant-synthetic',
    channelId: 'channel-synthetic',
    threadTs: null,
    senderId: 'human-1',
    recipientIds: [],
    kind: 'discussion',
    hopCount: 0,
    turnNumber: null,
    issuedAt: '2026-10-27T00:00:00.000Z',
    expiresAt: '2026-10-27T01:00:00.000Z',
    bodyRef: `ledger://sm-msg-${seq}`,
    bodySha256: 'a'.repeat(64),
  };
}

/**
 * Legal paths from the initial state to each stored state. When a state is
 * added to the spec, a path for it must be added here too; without one the
 * sweep for that state fails loudly in setup rather than passing silently.
 */
const PATHS: Record<LedgerEntryState, LedgerEntryState[]> = {
  durably_accepted: [],
  queued: ['queued'],
  delivery_accepted: ['queued', 'delivery_accepted'],
  started: ['queued', 'delivery_accepted', 'started'],
  replied: ['queued', 'delivery_accepted', 'started', 'replied'],
  verified: ['queued', 'delivery_accepted', 'started', 'replied', 'verified'],
  completed: ['queued', 'delivery_accepted', 'started', 'replied', 'completed'],
  blocked: ['blocked'],
  unknown: ['queued', 'unknown'],
  failed: ['failed'],
  cancelled: ['cancelled'],
};

function ledgerInState(state: LedgerEntryState): {
  ledger: ThreadLedger;
  messageId: string;
} {
  const ledger = new ThreadLedger({ participants });
  const r = ledger.accept(envelope());
  if (!r.accepted) throw new Error('setup failed');
  const messageId = r.entry.envelope.messageId;
  for (const step of PATHS[state]) {
    const t = ledger.transition(messageId, step);
    if (!t.ok) throw new Error(`setup path to ${state} failed at ${step}`);
  }
  const reached = ledger.getEntry(messageId);
  if (reached?.state !== state) {
    throw new Error(`setup path ended in ${reached?.state}, not ${state}`);
  }
  return { ledger, messageId };
}

describe('spec/ledger-state-machine.json conformance', () => {
  it('the spec is internally consistent', () => {
    expect(spec.states).toContain(spec.initial);
    expect(new Set(spec.states).size).toBe(spec.states.length);
    const keys = Object.keys(spec.transitions).sort();
    expect(keys).toEqual([...spec.states].sort());
    for (const targets of Object.values(spec.transitions)) {
      expect(new Set(targets).size).toBe(targets.length);
      for (const target of targets) expect(spec.states).toContain(target);
    }
    const computedTerminal = spec.states
      .filter((s) => (spec.transitions[s] ?? []).length === 0)
      .sort();
    expect([...spec.terminal].sort()).toEqual(computedTerminal);
  });

  it('the exported transition table matches the spec exactly', () => {
    const impl: Record<string, string[]> = {};
    for (const [state, targets] of Object.entries(LEDGER_TRANSITIONS)) {
      impl[state] = [...targets].sort();
    }
    const wanted: Record<string, string[]> = {};
    for (const [state, targets] of Object.entries(spec.transitions)) {
      wanted[state] = [...targets].sort();
    }
    expect(impl).toEqual(wanted);
  });

  it('a newly accepted entry starts at the spec initial state', () => {
    const ledger = new ThreadLedger({ participants });
    const r = ledger.accept(envelope());
    if (!r.accepted) throw new Error('accept failed');
    expect(r.entry.state).toBe(spec.initial);
  });

  describe('observable behavior matches the spec for every (from, to) pair', () => {
    for (const from of spec.states as LedgerEntryState[]) {
      for (const to of spec.states as LedgerEntryState[]) {
        const allowed = (spec.transitions[from] ?? []).includes(to);
        it(`${from} -> ${to} is ${allowed ? 'allowed' : 'rejected'}`, () => {
          const { ledger, messageId } = ledgerInState(from);
          const r = ledger.transition(messageId, to);
          expect(r.ok).toBe(allowed);
          const after = ledger.getEntry(messageId);
          expect(after?.state).toBe(allowed ? to : from);
        });
      }
    }
  });
});

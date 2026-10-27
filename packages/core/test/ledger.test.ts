import { describe, it, expect } from 'vitest';
import {
  ThreadLedger,
  validateEnvelope,
  type LedgerConfig,
  type MessageEnvelope,
} from '@agent-plaza/core';

const config: LedgerConfig = {
  participants: new Map([
    ['human-1', 'human'],
    ['agent-a', 'agent'],
    ['agent-b', 'agent'],
  ]),
};

let seq = 0;
function envelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  seq += 1;
  return {
    messageId: `msg-${seq}`,
    idempotencyKey: `idem-${seq}`,
    tenantId: 'tenant-synthetic',
    channelId: 'channel-synthetic',
    threadTs: null,
    senderId: 'human-1',
    recipientIds: ['agent-a'],
    kind: 'discussion',
    hopCount: 0,
    turnNumber: null,
    issuedAt: '2026-10-27T00:00:00.000Z',
    expiresAt: '2026-10-27T01:00:00.000Z',
    bodyRef: `ledger://msg-${seq}`,
    bodySha256: 'a'.repeat(64),
    ...overrides,
  };
}

describe('thread ledger acceptance', () => {
  it('accepts a valid envelope, assigns turn number 1 and starts durably_accepted', () => {
    const ledger = new ThreadLedger(config);
    const r = ledger.accept(envelope());
    expect(r.accepted).toBe(true);
    if (r.accepted) {
      expect(r.duplicate).toBe(false);
      expect(r.entry.envelope.turnNumber).toBe(1);
      expect(r.entry.state).toBe('durably_accepted');
      expect(r.entry.correctsMessageId).toBeNull();
    }
  });

  it('rejects an envelope that fails validation and consumes no turn', () => {
    const ledger = new ThreadLedger(config);
    const bad = ledger.accept(envelope({ bodySha256: 'xyz' }));
    expect(bad.accepted).toBe(false);
    const good = ledger.accept(envelope({ senderId: 'agent-a' }));
    expect(good.accepted).toBe(true);
    if (good.accepted) expect(good.entry.envelope.turnNumber).toBe(1);
  });

  it('rejects a candidate that already carries a turn number', () => {
    const ledger = new ThreadLedger(config);
    const r = ledger.accept(envelope({ turnNumber: 5 }));
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.errors?.join(' ')).toContain('turnNumber');
  });

  it('rejects an envelope from an unregistered sender', () => {
    const ledger = new ThreadLedger(config);
    const r = ledger.accept(envelope({ senderId: 'stranger' }));
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.errors?.join(' ')).toContain('sender');
  });

  it('is idempotent on idempotencyKey: a retry returns the original entry and no new turn', () => {
    const ledger = new ThreadLedger(config);
    const firstEnv = envelope();
    const first = ledger.accept(firstEnv);
    expect(first.accepted).toBe(true);
    // Same idempotency key as the first accept, different messageId.
    const retry = ledger.accept({
      ...envelope(),
      idempotencyKey: firstEnv.idempotencyKey,
    });
    expect(retry.accepted).toBe(true);
    if (retry.accepted && first.accepted) {
      expect(retry.duplicate).toBe(true);
      expect(retry.entry.envelope.messageId).toBe(first.entry.envelope.messageId);
      expect(retry.entry.envelope.turnNumber).toBe(1);
    }
    const next = ledger.accept(envelope({ senderId: 'agent-a' }));
    expect(next.accepted).toBe(true);
    if (next.accepted) expect(next.entry.envelope.turnNumber).toBe(2);
  });

  it('rejects a second accept that reuses a messageId under a different idempotency key', () => {
    const ledger = new ThreadLedger(config);
    const firstEnv = envelope();
    const first = ledger.accept(firstEnv);
    expect(first.accepted).toBe(true);
    const clash = ledger.accept(
      envelope({ messageId: firstEnv.messageId, idempotencyKey: 'idem-other' }),
    );
    expect(clash.accepted).toBe(false);
    if (!clash.accepted) expect(clash.errors?.join(' ')).toContain('messageId');
  });
});

describe('thread ledger state machine', () => {
  it('walks the happy path durably_accepted -> queued -> delivery_accepted -> started -> replied -> verified -> completed', () => {
    const ledger = new ThreadLedger(config);
    const r = ledger.accept(envelope());
    if (!r.accepted) throw new Error('setup failed');
    const id = r.entry.envelope.messageId;
    for (const to of [
      'queued',
      'delivery_accepted',
      'started',
      'replied',
      'verified',
      'completed',
    ] as const) {
      const t = ledger.transition(id, to);
      expect(t.ok).toBe(true);
      if (t.ok) expect(t.entry.state).toBe(to);
    }
  });

  it('allows replied -> completed directly (verification is optional)', () => {
    const ledger = new ThreadLedger(config);
    const r = ledger.accept(envelope());
    if (!r.accepted) throw new Error('setup failed');
    const id = r.entry.envelope.messageId;
    ledger.transition(id, 'queued');
    ledger.transition(id, 'delivery_accepted');
    ledger.transition(id, 'started');
    ledger.transition(id, 'replied');
    const t = ledger.transition(id, 'completed');
    expect(t.ok).toBe(true);
  });

  it('rejects an illegal transition and leaves the state unchanged', () => {
    const ledger = new ThreadLedger(config);
    const r = ledger.accept(envelope());
    if (!r.accepted) throw new Error('setup failed');
    const id = r.entry.envelope.messageId;
    const t = ledger.transition(id, 'completed');
    expect(t.ok).toBe(false);
    expect(ledger.getEntry(id)?.state).toBe('durably_accepted');
  });

  it('rejects transitions out of a terminal state', () => {
    const ledger = new ThreadLedger(config);
    const r = ledger.accept(envelope());
    if (!r.accepted) throw new Error('setup failed');
    const id = r.entry.envelope.messageId;
    expect(ledger.transition(id, 'cancelled').ok).toBe(true);
    expect(ledger.transition(id, 'queued').ok).toBe(false);
  });

  it('returns not-ok for a transition on an unknown messageId', () => {
    const ledger = new ThreadLedger(config);
    expect(ledger.transition('nope', 'queued').ok).toBe(false);
  });
});

describe('thread ledger loop-guard integration', () => {
  it('denies an agent post at the pair cap without consuming a turn, and a human post resets the counters', () => {
    const ledger = new ThreadLedger(config);
    // Human opens the thread.
    expect(ledger.accept(envelope()).accepted).toBe(true);
    // Six agent exchanges A<->B reach the pair cap (D-5: 6).
    for (let i = 0; i < 6; i++) {
      const fromA = i % 2 === 0;
      const r = ledger.accept(
        envelope({
          senderId: fromA ? 'agent-a' : 'agent-b',
          recipientIds: [fromA ? 'agent-b' : 'agent-a'],
          bodySha256: 'abcdef'[i]!.repeat(64),
          hopCount: i + 1,
        }),
      );
      expect(r.accepted).toBe(true);
    }
    const denied = ledger.accept(
      envelope({
        senderId: 'agent-a',
        recipientIds: ['agent-b'],
        bodySha256: 'c'.repeat(64),
        hopCount: 7,
      }),
    );
    expect(denied.accepted).toBe(false);
    if (!denied.accepted) expect(denied.reason).toBe('pair_roundtrip_cap');
    // The denied post consumed no turn: 1 human + 6 agent = 7 entries.
    expect(ledger.entries()).toHaveLength(7);
    // A human post resets the loop counters, so the same agent post now passes.
    expect(ledger.accept(envelope()).accepted).toBe(true);
    const after = ledger.accept(
      envelope({
        senderId: 'agent-a',
        recipientIds: ['agent-b'],
        bodySha256: 'c'.repeat(64),
        hopCount: 1,
      }),
    );
    expect(after.accepted).toBe(true);
    if (after.accepted) expect(after.entry.envelope.turnNumber).toBe(9);
  });
});

describe('thread ledger correction rounds (D-5)', () => {
  it('enforces the correction-round cap per corrected message', () => {
    const ledger = new ThreadLedger(config);
    const original = ledger.accept(envelope({ senderId: 'agent-a' }));
    if (!original.accepted) throw new Error('setup failed');
    const target = original.entry.envelope.messageId;
    const senders = ['agent-b', 'agent-a', 'agent-b'] as const;
    for (let i = 0; i < 3; i++) {
      const sender = senders[i]!;
      const r = ledger.accept(
        envelope({
          senderId: sender,
          recipientIds: [sender === 'agent-a' ? 'agent-b' : 'agent-a'],
          bodySha256: `${i + 1}`.repeat(64),
        }),
        { correctsMessageId: target },
      );
      expect(r.accepted).toBe(true);
      if (r.accepted) expect(r.entry.correctsMessageId).toBe(target);
    }
    const fourth = ledger.accept(
      envelope({
        senderId: 'agent-a',
        recipientIds: ['agent-b'],
        bodySha256: '9'.repeat(64),
      }),
      { correctsMessageId: target },
    );
    expect(fourth.accepted).toBe(false);
    if (!fourth.accepted) expect(fourth.reason).toBe('correction_round_cap');
  });

  it('rejects a correction that targets an unknown message', () => {
    const ledger = new ThreadLedger(config);
    const r = ledger.accept(envelope({ senderId: 'agent-a' }), {
      correctsMessageId: 'missing',
    });
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.errors?.join(' ')).toContain('correctsMessageId');
  });
});

describe('thread ledger snapshot / restore', () => {
  it('round-trips through a JSON snapshot without losing turns, states or counters', () => {
    const ledger = new ThreadLedger(config);
    const a = ledger.accept(envelope());
    if (!a.accepted) throw new Error('setup failed');
    ledger.transition(a.entry.envelope.messageId, 'queued');
    ledger.accept(envelope({ senderId: 'agent-a', bodySha256: 'd'.repeat(64) }));

    const restored = ThreadLedger.restore(
      JSON.parse(JSON.stringify(ledger.snapshot())) as unknown,
      config,
    );
    expect(restored.entries()).toHaveLength(2);
    expect(restored.getEntry(a.entry.envelope.messageId)?.state).toBe('queued');
    // Idempotency survives the round-trip.
    const retry = restored.accept(
      envelope({ idempotencyKey: a.entry.envelope.idempotencyKey }),
    );
    expect(retry.accepted).toBe(true);
    if (retry.accepted) expect(retry.duplicate).toBe(true);
    // Turn numbering continues where it left off.
    const next = restored.accept(envelope({ senderId: 'agent-b' }));
    expect(next.accepted).toBe(true);
    if (next.accepted) expect(next.entry.envelope.turnNumber).toBe(3);
  });

  it('keeps the accepted envelope itself valid after turn assignment', () => {
    const ledger = new ThreadLedger(config);
    const r = ledger.accept(envelope());
    if (!r.accepted) throw new Error('setup failed');
    expect(validateEnvelope(r.entry.envelope).ok).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import {
  validateEnvelope,
  type MessageEnvelope,
} from '@agent-plaza/core';

function valid(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    messageId: 'msg-0001',
    idempotencyKey: 'idem-0001',
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
    bodyRef: 'ledger://msg-0001',
    bodySha256: 'a'.repeat(64),
    ...overrides,
  };
}

describe('message envelope validation', () => {
  it('accepts a valid envelope with an unassigned turn number', () => {
    const r = validateEnvelope(valid());
    expect(r.ok).toBe(true);
  });

  it('rejects an envelope with a missing messageId', () => {
    const r = validateEnvelope(valid({ messageId: '' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain('messageId');
  });

  it('rejects an envelope whose idempotency key is missing', () => {
    const r = validateEnvelope(valid({ idempotencyKey: '' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain('idempotencyKey');
  });

  it('rejects a body hash that is not a SHA-256 hex digest', () => {
    const r = validateEnvelope(valid({ bodySha256: 'xyz' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain('bodySha256');
  });

  it('rejects an expiry that is not after the issue time', () => {
    const r = validateEnvelope(
      valid({ expiresAt: '2026-10-27T00:00:00.000Z' }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain('expiresAt');
  });

  it('rejects a negative hop count', () => {
    const r = validateEnvelope(valid({ hopCount: -1 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain('hopCount');
  });

  it('rejects an envelope with an unknown field (schema additionalProperties: false)', () => {
    const candidate = { ...valid(), unexpectedField: 'x' };
    const r = validateEnvelope(candidate);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain('unexpectedField');
  });

  it('rejects an unknown message kind', () => {
    const r = validateEnvelope(
      valid({ kind: 'telepathy' as MessageEnvelope['kind'] }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain('kind');
  });
});

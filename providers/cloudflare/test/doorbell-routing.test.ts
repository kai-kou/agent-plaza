import { describe, it, expect } from 'vitest';
import type { Participant } from '@agent-plaza/core';
import {
  hasCompleteMarker,
  participantIdFromLatestPointer,
  participantLatestThreadId,
  routeDoorbellRecipients,
  type DoorbellRoutingInput,
} from '@agent-plaza/cloudflare';

// Synthetic participants only (repository rule: no real ids in tests).
const participants: Participant[] = [
  { id: 'slack:U100', displayName: 'Owner', aliases: [], roles: [], kind: 'human' },
  { id: 'slack:U200', displayName: 'Alpha', aliases: ['Alpha'], roles: [], kind: 'agent' },
  { id: 'slack:U300', displayName: 'Beta', aliases: ['Beta'], roles: [], kind: 'agent' },
];

function input(
  overrides: Partial<DoorbellRoutingInput> = {},
): DoorbellRoutingInput {
  return {
    recipients: [],
    senderId: 'slack:U100',
    participants,
    hasMarker: false,
    isThreadReply: false,
    threadParticipantIds: [],
    ...overrides,
  };
}

describe('routeDoorbellRecipients (D-22)', () => {
  it('rings only the addressed participants when recipients are decided', () => {
    const r = routeDoorbellRecipients(input({ recipients: ['slack:U200'] }));
    expect(r.basis).toBe('recipients');
    expect(r.participantIds).toEqual(['slack:U200']);
  });

  it('never rings the sender, even if the sender appears in recipients', () => {
    const r = routeDoorbellRecipients(
      input({
        senderId: 'slack:U200',
        recipients: ['slack:U200', 'slack:U300'],
      }),
    );
    expect(r.basis).toBe('recipients');
    expect(r.participantIds).toEqual(['slack:U300']);
  });

  it('drops unknown recipient ids instead of ringing an unregistered key', () => {
    const r = routeDoorbellRecipients(
      input({ senderId: 'slack:U200', recipients: ['slack:U999'] }),
    );
    expect(r.basis).toBe('agent-silence');
    expect(r.participantIds).toEqual([]);
  });

  it('broadcasts to all participants when a human sender has no recipients', () => {
    const r = routeDoorbellRecipients(input({ recipients: [] }));
    expect(r.basis).toBe('human-broadcast');
    expect(r.participantIds).toEqual([
      'slack:U100',
      'slack:U200',
      'slack:U300',
    ]);
  });

  it('rings no participant pointer when an agent sender has no recipients (FR-11)', () => {
    const r = routeDoorbellRecipients(
      input({ senderId: 'slack:U200', recipients: [] }),
    );
    expect(r.basis).toBe('agent-silence');
    expect(r.participantIds).toEqual([]);
  });

  it('fails open to all participants for an unknown sender', () => {
    const r = routeDoorbellRecipients(
      input({ senderId: 'slack:U999', recipients: [] }),
    );
    expect(r.basis).toBe('fail-open-unknown-sender');
    expect(r.participantIds).toEqual([
      'slack:U100',
      'slack:U200',
      'slack:U300',
    ]);
  });

  it('fails open to all participants when a complete marker is present', () => {
    // The marker's to= is not parsed at ingress (FR-53 (3)), so an
    // agent post carrying one must not be silenced by empty recipients.
    const r = routeDoorbellRecipients(
      input({ senderId: 'slack:U200', recipients: [], hasMarker: true }),
    );
    expect(r.basis).toBe('fail-open-marker');
    expect(r.participantIds).toEqual([
      'slack:U100',
      'slack:U200',
      'slack:U300',
    ]);
  });

  it('lets the marker fail-open win over decided recipients', () => {
    const r = routeDoorbellRecipients(
      input({ recipients: ['slack:U200'], hasMarker: true }),
    );
    expect(r.basis).toBe('fail-open-marker');
    expect(r.participantIds).toHaveLength(3);
  });

  it('fails open to the other thread participants for a thread continuation', () => {
    const r = routeDoorbellRecipients(
      input({
        senderId: 'slack:U200',
        recipients: [],
        isThreadReply: true,
        threadParticipantIds: ['slack:U200', 'slack:U300'],
      }),
    );
    expect(r.basis).toBe('fail-open-thread');
    expect(r.participantIds).toEqual(['slack:U300']);
  });

  it('falls through to silence when a thread reply has no other participants', () => {
    const r = routeDoorbellRecipients(
      input({
        senderId: 'slack:U200',
        recipients: [],
        isThreadReply: true,
        threadParticipantIds: ['slack:U200'],
      }),
    );
    expect(r.basis).toBe('agent-silence');
    expect(r.participantIds).toEqual([]);
  });

  it('ignores thread participants for a top-level post', () => {
    const r = routeDoorbellRecipients(
      input({
        senderId: 'slack:U200',
        recipients: [],
        isThreadReply: false,
        threadParticipantIds: ['slack:U300'],
      }),
    );
    expect(r.basis).toBe('agent-silence');
  });

  it('decided recipients win over the thread fail-open', () => {
    const r = routeDoorbellRecipients(
      input({
        senderId: 'slack:U200',
        recipients: ['slack:U100'],
        isThreadReply: true,
        threadParticipantIds: ['slack:U300'],
      }),
    );
    expect(r.basis).toBe('recipients');
    expect(r.participantIds).toEqual(['slack:U100']);
  });
});

describe('hasCompleteMarker', () => {
  it('detects the primary marker token without parsing it', () => {
    expect(
      hasCompleteMarker('本文\n⟦AH1⟧ from=agent:alpha type=REPORT to=agent:beta cid=x'),
    ).toBe(true);
  });

  it('detects the ASCII alias marker token', () => {
    expect(
      hasCompleteMarker('[AGENT-HUB/0.1] from=agent:alpha type=REPORT'),
    ).toBe(true);
  });

  it('is false for ordinary text', () => {
    expect(hasCompleteMarker('ただの投稿です')).toBe(false);
    expect(hasCompleteMarker('AH1 について話す')).toBe(false);
  });
});

describe('participant latest pointer keys', () => {
  it('builds and parses a participant pointer thread id', () => {
    expect(participantLatestThreadId('C1', 'agent:alpha')).toBe(
      'C1:__latest__:agent:alpha',
    );
    expect(participantIdFromLatestPointer('C1:__latest__:agent:alpha')).toBe(
      'agent:alpha',
    );
    expect(participantIdFromLatestPointer('C1:__latest__:slack:U200')).toBe(
      'slack:U200',
    );
  });

  it('returns null for the shared pointer and for thread ids', () => {
    expect(participantIdFromLatestPointer('C1:__latest__')).toBeNull();
    expect(
      participantIdFromLatestPointer('C1:1793100000.000100'),
    ).toBeNull();
    expect(participantIdFromLatestPointer('C1:__latest__:')).toBeNull();
  });
});

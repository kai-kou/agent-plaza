import { describe, it, expect } from 'vitest';
import type { Participant } from '@agent-plaza/core';
import {
  hasBroadcastAddress,
  hasCompleteMarker,
  parseCompleteMarkerAddressees,
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
    markerRecipients: [],
    broadcastAddress: false,
    senderId: 'slack:U100',
    participants,
    ...overrides,
  };
}

describe('routeDoorbellRecipients (D-22 / D-23)', () => {
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

  it('rings only the marker addressee when the marker to= decides', () => {
    const r = routeDoorbellRecipients(
      input({ senderId: 'slack:U200', markerRecipients: ['slack:U300'] }),
    );
    expect(r.basis).toBe('marker-recipients');
    expect(r.participantIds).toEqual(['slack:U300']);
  });

  it('unions marker addressees with the FR-10 recipients', () => {
    const r = routeDoorbellRecipients(
      input({
        senderId: 'slack:U200',
        recipients: ['slack:U100'],
        markerRecipients: ['slack:U300'],
      }),
    );
    expect(r.basis).toBe('marker-recipients');
    expect(r.participantIds).toEqual(['slack:U100', 'slack:U300']);
  });

  it('does not fail open on a marker whose addressees are all unusable', () => {
    // The sender themself, and an unregistered id: nothing usable
    // remains, so an agent post falls through to silence (D-23
    // replaced the marker-presence fail-open).
    const r = routeDoorbellRecipients(
      input({
        senderId: 'slack:U200',
        markerRecipients: ['slack:U200', 'agent:nobody'],
      }),
    );
    expect(r.basis).toBe('agent-silence');
    expect(r.participantIds).toEqual([]);
  });

  it('broadcasts to all participants for an explicit broadcast address', () => {
    const r = routeDoorbellRecipients(
      input({ senderId: 'slack:U200', broadcastAddress: true }),
    );
    expect(r.basis).toBe('broadcast');
    expect(r.participantIds).toEqual([
      'slack:U100',
      'slack:U200',
      'slack:U300',
    ]);
  });

  it('lets the explicit broadcast win over decided recipients', () => {
    const r = routeDoorbellRecipients(
      input({ recipients: ['slack:U200'], broadcastAddress: true }),
    );
    expect(r.basis).toBe('broadcast');
    expect(r.participantIds).toHaveLength(3);
  });

  it('broadcasts to all participants when the owner (human) has no addressees', () => {
    const r = routeDoorbellRecipients(input({ recipients: [] }));
    expect(r.basis).toBe('owner-broadcast');
    expect(r.participantIds).toEqual([
      'slack:U100',
      'slack:U200',
      'slack:U300',
    ]);
  });

  it('rings no participant pointer when an agent sender has no addressees (FR-11)', () => {
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

describe('parseCompleteMarkerAddressees', () => {
  it('extracts the to= addressee of the primary marker', () => {
    expect(
      parseCompleteMarkerAddressees(
        '本文\n⟦AH1⟧ from=agent:alpha type=REPORT to=agent:beta cid=x',
      ),
    ).toEqual(['agent:beta']);
  });

  it('extracts the to= addressee of the ASCII alias marker', () => {
    expect(
      parseCompleteMarkerAddressees(
        '[AGENT-HUB/0.1] from=agent:alpha type=REQUEST to=agent:beta',
      ),
    ).toEqual(['agent:beta']);
  });

  it('splits a comma-separated to= into every addressee', () => {
    expect(
      parseCompleteMarkerAddressees(
        '⟦AH1⟧ from=agent:alpha type=REQUEST to=agent:beta,agent:gamma cid=x',
      ),
    ).toEqual(['agent:beta', 'agent:gamma']);
  });

  it('collects repeated to= fields and removes duplicates', () => {
    expect(
      parseCompleteMarkerAddressees(
        '⟦AH1⟧ from=agent:alpha type=REQUEST to=agent:beta to=agent:beta cid=x',
      ),
    ).toEqual(['agent:beta']);
  });

  it('returns nothing for a marker without to=', () => {
    expect(
      parseCompleteMarkerAddressees(
        '⟦AH1⟧ from=agent:alpha type=REPORT cid=x',
      ),
    ).toEqual([]);
  });

  it('never mines body prose for to= without a marker', () => {
    expect(
      parseCompleteMarkerAddressees('宛先は to=agent:beta と書きます'),
    ).toEqual([]);
  });
});

describe('hasBroadcastAddress', () => {
  it('detects here, channel and everyone, with or without a label', () => {
    expect(hasBroadcastAddress('<!here> 連絡です')).toBe(true);
    expect(hasBroadcastAddress('<!channel> 連絡です')).toBe(true);
    expect(hasBroadcastAddress('<!everyone> 連絡です')).toBe(true);
    expect(hasBroadcastAddress('<!here|@here> 連絡です')).toBe(true);
  });

  it('is false for mentions and ordinary text', () => {
    expect(hasBroadcastAddress('<@U200> 調べてほしい')).toBe(false);
    expect(hasBroadcastAddress('ただの投稿です')).toBe(false);
    expect(hasBroadcastAddress('<!date^1793100000^本日> の話')).toBe(false);
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

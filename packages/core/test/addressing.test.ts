import { describe, it, expect } from 'vitest';
import {
  decideAddressing,
  type AddressingInput,
  type Participant,
} from '../src/routing/addressing.js';

const participants: Participant[] = [
  { id: 'human-1', displayName: 'Owner', aliases: [], roles: [], kind: 'human' },
  { id: 'agent-a', displayName: 'Alpha', aliases: ['Alpha', 'あるふぁ'], roles: ['research'], kind: 'agent' },
  { id: 'agent-b', displayName: 'Beta', aliases: ['Beta'], roles: ['review'], kind: 'agent' },
];

function input(overrides: Partial<AddressingInput> = {}): AddressingInput {
  return {
    mentionedIds: [],
    threadNominationId: null,
    bodyText: '',
    roleMentions: [],
    broadcast: false,
    senderId: 'human-1',
    ...overrides,
  };
}

describe('addressing (FR-10 priority)', () => {
  it('mention wins over a name appearing in the body', () => {
    const d = decideAddressing(
      input({ mentionedIds: ['agent-b'], bodyText: 'Alpha にも見てほしい' }),
      participants,
    );
    expect(d).toEqual({ recipients: ['agent-b'], basis: 'mention' });
  });

  it('falls back to the thread nomination when there is no mention', () => {
    const d = decideAddressing(
      input({ threadNominationId: 'agent-a', bodyText: '続きをお願い' }),
      participants,
    );
    expect(d).toEqual({ recipients: ['agent-a'], basis: 'thread' });
  });

  it('matches a participant by alias in the body', () => {
    const d = decideAddressing(
      input({ bodyText: 'Beta に確認してほしい' }),
      participants,
    );
    expect(d).toEqual({ recipients: ['agent-b'], basis: 'name' });
  });

  it('matches participants by role', () => {
    const d = decideAddressing(
      input({ roleMentions: ['review'] }),
      participants,
    );
    expect(d).toEqual({ recipients: ['agent-b'], basis: 'role' });
  });

  it('broadcast reaches every agent except the sender', () => {
    const d = decideAddressing(input({ broadcast: true }), participants);
    expect(d.basis).toBe('broadcast');
    expect(d.recipients.sort()).toEqual(['agent-a', 'agent-b']);
  });

  it('defaults to silence when nothing addresses anyone', () => {
    const d = decideAddressing(input({ bodyText: 'ただのメモ' }), participants);
    expect(d).toEqual({ recipients: [], basis: 'none' });
  });

  it('never addresses the sender, and a self-mention falls through', () => {
    const d = decideAddressing(
      input({ mentionedIds: ['agent-a'], senderId: 'agent-a', bodyText: '自分の投稿' }),
      participants,
    );
    expect(d).toEqual({ recipients: [], basis: 'none' });
  });
});

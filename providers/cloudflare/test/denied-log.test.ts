import { describe, it, expect } from 'vitest';
import {
  D1DeniedLogStore,
  type DeniedLogRecord,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
} from '@agent-plaza/cloudflare';

interface Row {
  thread_id: string;
  event_id: string;
  slack_ts: string;
  recorded_at: string;
  sender_id: string;
  reason: string;
  caps_actual: number | null;
  caps_limit: number | null;
  addressing_basis: string;
  recipients_json: string;
  notice_rung: number;
}

class FakeD1 implements D1DatabaseLike {
  readonly rows: Row[] = [];
  failNextRun = false;
  prepare(query: string): D1PreparedStatementLike {
    const self = this;
    let bound: unknown[] = [];
    const stmt: D1PreparedStatementLike = {
      bind(...values: unknown[]) {
        bound = values;
        return stmt;
      },
      async first<T>() {
        throw new Error(`fake D1: unexpected first() for: ${query}`);
      },
      async run() {
        if (self.failNextRun) {
          self.failNextRun = false;
          throw new Error('d1 unavailable');
        }
        if (query.startsWith('INSERT INTO denied_log')) {
          const row: Row = {
            thread_id: bound[0] as string,
            event_id: bound[1] as string,
            slack_ts: bound[2] as string,
            recorded_at: bound[3] as string,
            sender_id: bound[4] as string,
            reason: bound[5] as string,
            caps_actual: bound[6] as number | null,
            caps_limit: bound[7] as number | null,
            addressing_basis: bound[8] as string,
            recipients_json: bound[9] as string,
            notice_rung: bound[10] as number,
          };
          // ON CONFLICT(event_id) DO NOTHING: a Slack retry that
          // re-records the same event id adds no second row.
          if (!self.rows.some((r) => r.event_id === row.event_id)) {
            self.rows.push(row);
          }
          return {};
        }
        if (query.startsWith('CREATE TABLE IF NOT EXISTS denied_log')) {
          return {};
        }
        throw new Error(`fake D1: unexpected run() for: ${query}`);
      },
      async all<T>() {
        if (query.startsWith('SELECT') && query.includes('FROM denied_log')) {
          const threadId = bound[0] as string;
          const results = self.rows
            .filter((r) => r.thread_id === threadId)
            .sort(
              (a, b) =>
                a.recorded_at.localeCompare(b.recorded_at) ||
                a.slack_ts.localeCompare(b.slack_ts) ||
                a.event_id.localeCompare(b.event_id),
            );
          return { results: results as T[] };
        }
        throw new Error(`fake D1: unexpected all() for: ${query}`);
      },
    };
    return stmt;
  }
}

const RECORD: DeniedLogRecord = {
  threadId: 'C1:1793100000.000100',
  eventId: 'EvD1',
  slackTs: '1793100000.000400',
  recordedAt: '2026-11-03T05:00:00.000Z',
  senderId: 'slack:U200',
  reason: 'thread_cap',
  capsActual: 20,
  capsLimit: 20,
  addressingBasis: 'mention',
  recipients: ['slack:U100'],
  noticeRung: true,
};

describe('D1DeniedLogStore', () => {
  it('records a denial and reads it back for the thread', async () => {
    const db = new FakeD1();
    const store = new D1DeniedLogStore(db);
    await store.record(RECORD);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]?.recipients_json).toBe('["slack:U100"]');
    expect(db.rows[0]?.notice_rung).toBe(1);

    const listed = await store.listByThread('C1:1793100000.000100');
    expect(listed).toEqual([RECORD]);
    expect(await store.listByThread('C1:other')).toEqual([]);
  });

  it('does not double-record a retried event id', async () => {
    const db = new FakeD1();
    const store = new D1DeniedLogStore(db);
    await store.record(RECORD);
    await store.record({ ...RECORD, recordedAt: '2026-11-03T05:00:01.000Z' });
    expect(db.rows).toHaveLength(1);
    expect((await store.listByThread('C1:1793100000.000100')).length).toBe(1);
  });

  it('stores null caps for reasons without a cap value', async () => {
    const db = new FakeD1();
    const store = new D1DeniedLogStore(db);
    await store.record({
      ...RECORD,
      eventId: 'Ev9',
      reason: 'unregistered_sender',
      capsActual: null,
      capsLimit: null,
      addressingBasis: 'none',
      recipients: [],
      noticeRung: false,
    });
    const listed = await store.listByThread('C1:1793100000.000100');
    expect(listed[0]).toMatchObject({
      reason: 'unregistered_sender',
      capsActual: null,
      capsLimit: null,
      recipients: [],
      noticeRung: false,
    });
  });

  it('propagates a write failure to the caller (best-effort lives at the call site)', async () => {
    const db = new FakeD1();
    const store = new D1DeniedLogStore(db);
    db.failNextRun = true;
    await expect(store.record(RECORD)).rejects.toThrow('d1 unavailable');
  });
});

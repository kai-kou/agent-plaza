/**
 * Cloudflare provider: the denied log in D1.
 *
 * A denied post never reaches the ledger, the delivery queue, or the
 * doorbell (FR-53), so without a record of its own it is invisible:
 * this store is that record. One row per denied post, keyed by the
 * Slack event id so a Slack retry cannot double-record it. The row
 * carries no message body, no body hash, no secret, and no raw Slack
 * user id — the sender is the normalized participant id, exactly as
 * FR-34 requires of the audit log.
 *
 * The D1 binding is consumed through the same minimal structural
 * interface as D1LedgerStore, so the store can be exercised against a
 * fake in tests. Writes are best-effort at the call site (see
 * slack-events.ts): this store itself reports failures to its caller
 * and never swallows them.
 */

import type { D1DatabaseLike } from './d1-ledger-store.js';

/** Reason codes stored for a denied post (see slack-events.ts). */
export type DeniedReasonCode =
  | 'thread_cap'
  | 'per_agent_cap'
  | 'consecutive_cap'
  | 'pair_roundtrip_cap'
  | 'same_content_cap'
  | 'correction_round_cap'
  | 'validation_error'
  | 'unregistered_sender'
  | 'duplicate_message'
  | 'invalid_correction_target';

export interface DeniedLogRecord {
  threadId: string;
  eventId: string;
  /** The denied post's Slack `ts`. */
  slackTs: string;
  /** When the hub recorded the denial (ISO 8601). */
  recordedAt: string;
  /** Normalized participant id of the sender. */
  senderId: string;
  reason: DeniedReasonCode;
  /** The cap value actually reached, or null when the reason has none. */
  capsActual: number | null;
  /** The cap limit for the reason, or null when the reason has none. */
  capsLimit: number | null;
  /** Addressing basis at ingress (e.g. 'mention', 'thread', 'none'). */
  addressingBasis: string;
  /** Recipients the addressing decision produced, if any. */
  recipients: string[];
  /** Whether this denial rang a denied-notice doorbell (FR-53). */
  noticeRung: boolean;
}

export interface DeniedLogStore {
  record(record: DeniedLogRecord): Promise<void>;
  listByThread(threadId: string): Promise<DeniedLogRecord[]>;
}

interface DeniedLogRow {
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

export class D1DeniedLogStore implements DeniedLogStore {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.#db = db;
  }

  /**
   * Create the denied_log table if it does not exist yet. For tests
   * and local development only: production schema is owned by the
   * setup procedure (schema.sql, see the provider README), and
   * request-time code never calls this.
   */
  async ensureSchema(): Promise<void> {
    await this.#db
      .prepare(
        'CREATE TABLE IF NOT EXISTS denied_log (thread_id TEXT NOT NULL, event_id TEXT NOT NULL UNIQUE, slack_ts TEXT NOT NULL, recorded_at TEXT NOT NULL, sender_id TEXT NOT NULL, reason TEXT NOT NULL, caps_actual INTEGER, caps_limit INTEGER, addressing_basis TEXT NOT NULL, recipients_json TEXT NOT NULL, notice_rung INTEGER NOT NULL)',
      )
      .run();
  }

  async record(record: DeniedLogRecord): Promise<void> {
    await this.#db
      .prepare(
        'INSERT INTO denied_log (thread_id, event_id, slack_ts, recorded_at, sender_id, reason, caps_actual, caps_limit, addressing_basis, recipients_json, notice_rung) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING',
      )
      .bind(
        record.threadId,
        record.eventId,
        record.slackTs,
        record.recordedAt,
        record.senderId,
        record.reason,
        record.capsActual,
        record.capsLimit,
        record.addressingBasis,
        JSON.stringify(record.recipients),
        record.noticeRung ? 1 : 0,
      )
      .run();
  }

  async listByThread(threadId: string): Promise<DeniedLogRecord[]> {
    const stmt = this.#db
      .prepare(
        'SELECT thread_id, event_id, slack_ts, recorded_at, sender_id, reason, caps_actual, caps_limit, addressing_basis, recipients_json, notice_rung FROM denied_log WHERE thread_id = ? ORDER BY recorded_at ASC, slack_ts ASC, event_id ASC',
      )
      .bind(threadId);
    if (stmt.all === undefined) {
      throw new Error('denied_log listing requires a D1 binding with all()');
    }
    const { results } = await stmt.all<DeniedLogRow>();
    return results.map((row) => ({
      threadId: row.thread_id,
      eventId: row.event_id,
      slackTs: row.slack_ts,
      recordedAt: row.recorded_at,
      senderId: row.sender_id,
      reason: row.reason as DeniedReasonCode,
      capsActual: row.caps_actual,
      capsLimit: row.caps_limit,
      addressingBasis: row.addressing_basis,
      recipients: parseRecipients(row.recipients_json),
      noticeRung: row.notice_rung === 1,
    }));
  }
}

function parseRecipients(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) &&
      parsed.every((v) => typeof v === 'string')
      ? parsed
      : [];
  } catch {
    return [];
  }
}

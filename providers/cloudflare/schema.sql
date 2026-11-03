-- agent-plaza hub: D1 schema.
-- Owned by the setup procedure (see README.md in this directory): run
-- this once when the database is created, and apply future schema
-- changes as new migrations here. Request-time code never creates
-- tables implicitly; D1LedgerStore.ensureSchema exists for tests and
-- local development only.
CREATE TABLE IF NOT EXISTS threads (
  thread_id TEXT PRIMARY KEY,
  snapshot TEXT NOT NULL
);

-- Denied posts (FR-53): one row per denial, keyed by Slack event id
-- so a Slack retry cannot double-record. No message body, no body
-- hash, no secret, and no raw Slack user id is stored here — the
-- sender is the normalized participant id. This is an operational
-- log, not a second ledger: it is never read by the doorbell routes.
CREATE TABLE IF NOT EXISTS denied_log (
  thread_id TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  slack_ts TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  caps_actual INTEGER,
  caps_limit INTEGER,
  addressing_basis TEXT NOT NULL,
  recipients_json TEXT NOT NULL,
  notice_rung INTEGER NOT NULL
);

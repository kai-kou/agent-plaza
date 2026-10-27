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

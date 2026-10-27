# agent-plaza hub — Cloudflare provider

The Cloudflare reference implementation of the agent-plaza hub: a Worker
that receives Slack events, verifies them, records them in the ledger on
D1, enqueues delivery jobs on Queues, and rings the doorbell flag in KV.

## Components

| Piece | Where | Role |
|---|---|---|
| Ledger store | `src/d1-ledger-store.ts` | The core `LedgerStore` port over D1 |
| Doorbell | `src/kv-doorbell.ts` | KV flag carrying only `{eventId, ts}` — never content |
| Signature | `src/slack-signature.ts` | Slack v0 HMAC verification with replay tolerance |
| Ingress core | `src/slack-events.ts` | Addressing → acceptance → persist → enqueue → ring |
| Worker | `src/worker.ts` | HTTP entry (`/healthz`, `/slack/events`) and the per-thread Durable Object |
| Schema | `schema.sql` | The D1 schema, owned by this setup procedure |

## Setup

Prerequisites: a Cloudflare account, Node.js 20+, and a Slack app with a
signing secret and the `message.channels` event subscription (the app
setup itself is part of the live-integration step, not this provider).

1. Install dependencies from the repository root:

   ```sh
   npm install
   ```

2. Create the resources (wrangler is invoked through npx; log in first
   with `npx wrangler login`):

   ```sh
   npx wrangler d1 create agent-plaza
   npx wrangler kv namespace create agent-plaza-doorbell
   npx wrangler queues create agent-plaza-delivery
   ```

3. Put the printed ids into `wrangler.toml` (replace every
   `REPLACE_WITH_*` placeholder).

4. Create the schema. This step owns the schema: request-time code never
   creates tables, so a database without this step fails loudly.

   ```sh
   npx wrangler d1 execute agent-plaza --remote --file providers/cloudflare/schema.sql
   ```

5. Configure the deployment in `wrangler.toml`:

   - `[vars] PARTICIPANTS_JSON`: a JSON array of participants. Ids are
     the stable identities; for Slack users the id is `slack:<user id>`.
     Example: `[{"id":"slack:U00000000","displayName":"Owner","aliases":[],"roles":[],"kind":"human"}]`

6. Set the signing secret (never commit it):

   ```sh
   npx wrangler secret put SLACK_SIGNING_SECRET
   ```

7. Deploy:

   ```sh
   npx wrangler deploy --config providers/cloudflare/wrangler.toml
   ```

8. Point the Slack app's Event Subscriptions request URL at
   `https://<your-worker-host>/slack/events`. The URL verification
   challenge is answered by the Worker once the signature checks out.

## Operational notes

- **Retries.** Slack retries deliveries it cannot confirm. The retry
  carries the same `event_id`, which is the ledger's idempotency key:
  the original entry stands, and if the first attempt was interrupted
  before enqueueing, the retry completes the enqueue. No duplicates.
- **Doorbell consumption.** The flag is a pointer, not a queue. A reader
  compares the flag's `eventId` with what it already processed and
  clears or leaves the flag by its own convention; the ledger is always
  the source of truth.
- **Serialization.** Requests for one thread are processed one at a
  time: within an isolate by the thread sequencer, and globally through
  the `THREAD_LEDGER` Durable Object (one instance per thread) when the
  binding is present, as in `wrangler.toml`.
- **Schema changes.** Add them as new statements in `schema.sql` (or a
  new migration file) and apply with step 4. Never rely on
  `D1LedgerStore.ensureSchema` outside tests and local development.

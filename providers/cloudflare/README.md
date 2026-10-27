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
signing secret and the `message.channels` event subscription — plus
`message.groups` when the designated channel is private (the app
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
   - `[vars] ALLOWED_CHANNEL_IDS_JSON`: a JSON array of the Slack
     channel ids the hub serves (FR-1, D-9: a single designated channel
     in v1). The shipped `"[]"` denies every channel until this is set,
     and channels outside the list are ignored even if the app is
     invited to them.
   - `[vars] BOT_PARTICIPANTS_JSON` (optional): a JSON object mapping
     Slack `bot_id` to participant id, for `bot_message` events that
     carry no user id.
   - `[vars] OWN_BOT_ID` (optional): this deployment's own Slack
     `bot_id`; its posts are delivery echoes and are ignored.

6. Set the secrets (never commit them):

   ```sh
   npx wrangler secret put SLACK_SIGNING_SECRET
   npx wrangler secret put DOORBELL_CAPABILITY
   ```

   `DOORBELL_CAPABILITY` is a long random string you generate (for
   example `openssl rand -hex 24`). It enables the doorbell read route
   below; without it the route is disabled.

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
  the original entry stands — the ledger never holds duplicates. If
  the first attempt was interrupted before enqueueing, the retry
  completes the enqueue. Delivery jobs are at-least-once, though: a
  retry after an interrupted first attempt can enqueue the same
  message twice, and consumers must deduplicate by
  `{threadId, messageId}` against the ledger state.
- **Doorbell consumption.** The flag is a pointer, not a queue. A reader
  compares the flag's `eventId` with what it already processed and
  clears or leaves the flag by its own convention; the ledger is always
  the source of truth. A ring can be lost when an attempt dies after
  the queued state is persisted, so reconciling against the ledger on
  wake is a hard requirement for readers (FR-9), not an optimization.
- **Doorbell read route.** Tier-C readers poll
  `GET /doorbell/<capability>/<threadId>` (threadId URL-encoded). The
  capability is the `DOORBELL_CAPABILITY` secret; a wrong capability
  returns the same 404 as an unknown route, and the route is disabled
  when the secret is unset. The response is the flag
  (`{eventId, ts}`) or `{flag: null}` — never content. Treat the
  capability URL as a credential for the reader's local configuration
  only: never commit it, and rotate it by changing the secret if it
  leaks.
- **Addressing reach.** The ingress supplies Slack mentions and thread
  continuation. Role and broadcast addressing are not parsed here —
  structured marker parsing (M4) owns them. Bot-origin posts are
  stricter (FR-14): only an explicit mention in the message itself
  addresses anyone.
- **Serialization.** Requests for one thread are processed one at a
  time: within an isolate by the thread sequencer, and globally through
  the `THREAD_LEDGER` Durable Object (one instance per thread) when the
  binding is present, as in `wrangler.toml`. The direct route without
  the binding serializes only within one isolate; production
  deployments must keep the Durable Object binding.
- **Schema changes.** Add them as new statements in `schema.sql` (or a
  new migration file) and apply with step 4. Never rely on
  `D1LedgerStore.ensureSchema` outside tests and local development.

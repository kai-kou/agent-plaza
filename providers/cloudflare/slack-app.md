# Slack app for the hub

The hub runs as one Slack app (a bot user) per deployment. Create it
from the bundled manifest — [`slack-app-manifest.json`](slack-app-manifest.json)
in this directory — instead of picking scopes and event subscriptions
by hand. This document is the canonical list of what the hub app
needs and why; if the manifest and this list ever disagree with the
code, the code (and the tests) win and the manifest is the bug.

This app is the **hub** app. It is not a participant's bot app:
participant bots follow [docs/onboarding.md](../../docs/onboarding.md)
section 1 (their scopes — `chat:write`, `files:write`, history/read
scopes — serve the participant's own reading and posting, which the
hub never does). It is also not a Socket Mode listener app: Socket
Mode belongs to participant-side listeners
([docs/socket-mode-listener.md](../../docs/socket-mode-listener.md))
and needs a separate app with an app-level token. One Slack app
cannot combine the Events API (HTTP) with Socket Mode, and the hub
uses the Events API.

## Creating the app from the manifest

A manifest declares configuration only. It does not install the app,
invite the bot anywhere, or hand any token to the Worker. The full
sequence:

1. **Prepare the request URL.** The manifest's
   `settings.event_subscriptions.request_url` is the placeholder
   `https://REPLACE_WITH_YOUR_WORKER_HOST/slack/events`. If you
   already know the Worker's host (for example its `workers.dev`
   subdomain), replace `REPLACE_WITH_YOUR_WORKER_HOST` with it before
   creating the app. If not, keep the placeholder for now and set the
   real URL in step 6 — Slack cannot verify a URL that does not
   answer yet, and the Worker can only answer once it is deployed
   with the signing secret (steps 4–5).
2. **Create the app.** At <https://api.slack.com/apps>, choose
   "Create New App" → "From a manifest", pick the target workspace,
   and paste the manifest JSON.
3. **Install the app to the workspace.** Manifest creation does not
   install anything. Install from the app's "Install App" page; the
   Bot User OAuth Token (`xoxb-…`) is issued at this point.
4. **Copy the credentials into Worker secrets — never into the
   repository.** The Signing Secret (the app's "Basic Information" →
   "App Credentials") becomes `SLACK_SIGNING_SECRET`, and the Bot
   User OAuth Token becomes `SLACK_BOT_TOKEN`, both via
   `wrangler secret put` as in the [README Setup](README.md#setup)
   step 6.
5. **Deploy the Worker** following the README Setup steps 1–7.
6. **Set the real Request URL.** In the app's "Event Subscriptions"
   page, make sure the Request URL is
   `https://<your-worker-host>/slack/events` (README Setup step 8).
   Slack sends a `url_verification` challenge to that URL; the Worker
   answers it once the signature checks out
   (`src/worker.ts` route `POST /slack/events`, challenge handling in
   `src/slack-events.ts`).
7. **Invite the hub bot to the designated channel.** Scopes are not
   channel membership: the bot only receives events from channels it
   belongs to, and only the allowlisted designated channel is served
   (`ALLOWED_CHANNEL_IDS_JSON`, README Setup step 5).

Changing any scope or event subscription later requires reinstalling
the app to the workspace for the change to take effect.

## Bot token scopes — what uses each one

The hub's code calls exactly one Slack Web API method,
`chat.postMessage`. The other two scopes issue no API call at all:
Slack's platform requires them before it will deliver the message
events the ingress is built on.

| Scope | Used by |
|---|---|
| `chat:write` | Posting as the hub bot: `chat.postMessage` in `src/slack-post.ts`, called only from the operator-only `POST /admin/post` route in `src/worker.ts`. Without it that route fails with a Slack error; ingress does not need it. |
| `channels:history` | Platform requirement for delivering the `message.channels` event (public channels). The hub calls no `conversations.history` API; the scope exists so the event subscription below can fire. |
| `groups:history` | Platform requirement for delivering the `message.groups` event (private channels). Same note as above: no history API is called. |

If the designated channel is public only, `message.groups` and
`groups:history` may be dropped (and vice versa for a private-only
deployment); the shipped manifest keeps both so one manifest covers
the private designated channel the onboarding flow assumes and the
public case without editing.

## Event subscriptions — what uses each one

Delivery is the Events API over HTTP: Slack POSTs to
`POST /slack/events` on the Worker, which verifies the v0 signature
(`src/slack-signature.ts`) before the ingress core
(`src/slack-events.ts`) processes the event — addressing, ledger
acceptance and recording, delivery enqueue, and the doorbell ring.

| Bot event | Used by |
|---|---|
| `message.channels` | New posts in a public designated channel. The ingress handles only `event.type === 'message'` (subtypes classified per FR-2/FR-14: new posts ingested, edits/deletions not propagated). Mentions are parsed from the message text itself (`<@…>` in `src/slack-events.ts`). |
| `message.groups` | The same for a private designated channel. |

## Settings in the manifest

| Setting | Value | Why |
|---|---|---|
| `settings.socket_mode_enabled` | `false` | The hub receives via the Events API (HTTP). Socket Mode is the participant-listener alternative and is exclusive with the Events API for one app. |
| `settings.interactivity.is_enabled` | `false` | The Worker exposes no interactivity, slash-command, or shortcut endpoint (`src/worker.ts` routes are `/healthz`, `/slack/events`, `/doorbell/…`, `/exchange/…`, `/admin/…` only), so none is declared. |
| `features.bot_user` | display name `agent-plaza hub` | The name the `/admin/post` posts appear under. It is a generic name on purpose: deployments rename it in their own app configuration; no environment-specific name belongs in this template. |

## Deliberately not included

Each entry below was checked against the hub code; the scope or
event is absent because nothing in `providers/cloudflare/src/`
uses it — not because it was overlooked.

- **`app_mentions:read` / the `app_mention` event.** The ingress
  ignores every event whose type is not `message`
  (`src/slack-events.ts`), so `app_mention` deliveries would be
  discarded. Hub addressing reads mentions out of message events.
  Note the difference from REQUIREMENTS.md section 4: its
  minimum-scope draft (`app_mentions:read`, `channels:history` /
  `groups:history`, `channels:read` / `groups:read`, `chat:write`)
  describes the generic agent-connection standard (the Tier A row
  subscribes `app_mention`, `message.channels`, `message.groups`),
  not this provider's hub app. For the hub app, this document and
  the manifest are canonical.
- **`channels:read` / `groups:read`.** The hub calls no
  `conversations.list` / `conversations.info` API. The designated
  channel reaches the hub as configuration
  (`ALLOWED_CHANNEL_IDS_JSON`), not via API discovery. (Participant
  bots do need the read scopes — they list channels and read history
  themselves; see onboarding section 1.)
- **`files:write`.** The hub never uploads files to Slack. The
  provider's file exchange runs over R2 (`src/r2-exchange.ts`), not
  Slack files. REQUIREMENTS.md section 4 likewise keeps file scopes
  out of the v1 standard configuration.
- **`reactions:write` / `reactions:read`.** The hub adds and reads
  no reactions; there is no `reactions.*` call in the provider. The
  reaction conventions (FR-33) are participant behaviour, not hub
  behaviour.
- **`users:read`.** The hub calls no `users.info`. Attribution uses
  the ids carried by the event payload plus the configured
  `PARTICIPANTS_JSON` / `BOT_PARTICIPANTS_JSON` maps.

## Verification status

The manifest's JSON validity and this repository's test suite are
checked with the change that introduces it. That an app created from
this manifest can be taken through the README Setup end to end is
**not** verified here: that check belongs to the clean-room
deployment rehearsal (Epic #78, stage 1), which exercises this
manifest together with the rest of the deployment path.

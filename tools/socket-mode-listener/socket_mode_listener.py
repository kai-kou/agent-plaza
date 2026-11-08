#!/usr/bin/env python3
"""Socket Mode listener for an agent-plaza participant bot -- Plan B shape.

Recommendation B (2026-11-06, owner-approved staged rollout starting with
verification): a resident Socket Mode listener replaces only the hub +
bridge polling segment. The wake flow after that is unchanged.

Flow per received Slack event:
  1. Acknowledge the envelope immediately.
  2. For ``message`` events in the target channel (TARGET_CHANNEL_ID) only,
     POST to the
     agent-doorbell-mcp ingress (``POST $WORKER_BASE/v1/events``) with
     ``type: doorbell.rang``.
  3. Record the outcome in the same observation log the core-wake hook
     watches (``~/workspace/agent-doorbell-mcp/hidden/bridge-state/
     observations.jsonl``), using the same line shape as the bridge script,
     so ``agent-doorbell-core-wake`` needs no change.

Stable-ID rule (pinned here; the research report left it open): the Slack
``event_id`` is used in all three places, because the wake chain matches
on it end to end:
  * ``idempotencyKey`` of the ingress POST,
  * ``data.hubEventId`` of the ingress payload (the wake worker matches
    pulled events against the hubEventIds from the wake payload),
  * ``eventId`` of the ``posted`` observation line (core-wake extracts
    ``.eventId`` from posted lines as the wake payload's hubEventIds).
If these three diverge, the wake -> pull match breaks.

Tokens:
  * SLACK_BOT_TOKEN (xoxb) and SLACK_APP_TOKEN (xapp) come from the
    environment only, normally via EnvironmentFile
    ``~/.config/agent-plaza/env`` (0600, outside the workspace). They are
    never written to disk or logs by this script.
  * PRODUCER_TOKEN / WORKER_BASE for the ingress POST come from the
    environment, falling back to
    ``~/workspace/agent-doorbell-mcp/hidden/deploy.env`` (the same file
    the bridge script sources). No new owner-supplied secret is needed
    for ingress: the producer token already lives on this VM.
  * Other event types, other channels, and the bot's own bookkeeping
    events are acked and ignored; filtering of own messages stays in the
    wake flow, as with the bridge.

Reference implementation of the agent-plaza VM-resilient operations
method (docs/vm-resilient-operations.md in kai-kou/agent-plaza). The
ingress path is unit-tested with a fake POST (see
test_socket_mode_listener.py). Run with AGENT_PLAZA_DRY_RUN=1 to log
what would be posted without sending anything. Configuration is via
environment variables (see the kit README): TARGET_CHANNEL_ID and
WORKER_BASE have no defaults and must be set.
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error

TARGET_CHANNEL = os.environ.get("TARGET_CHANNEL_ID", "")

DEFAULT_OBS_LOG = os.path.expanduser(
    "~/workspace/agent-doorbell-mcp/hidden/bridge-state/observations.jsonl"
)
DEFAULT_DEPLOY_ENV = os.path.expanduser(
    "~/workspace/agent-doorbell-mcp/hidden/deploy.env"
)
DEFAULT_ENV_FILE = os.path.expanduser("~/.config/agent-plaza/env")

# Phase-0 diagnostics (2026-11-07, gate plan stage 0a): the observation log
# only records successful forwards, and the systemd journal does not
# survive VM replacements, so every envelope outcome and a connection
# heartbeat are also appended to a persistent JSONL file under home.
# Records never contain message text, user ids, or token values.
DEFAULT_DIAG_LOG = os.path.expanduser(
    "~/workspace/agent-plaza/bridge/socket-diagnostics.jsonl"
)
DEFAULT_SDK_LOG = os.path.expanduser(
    "~/workspace/agent-plaza/bridge/socket-listener.log"
)
# Phase-1 (2026-11-07): the supervisor hook reads this small file for
# liveness (heartbeat freshness) and the pidfile for zombie recovery.
DEFAULT_HEARTBEAT_FILE = os.path.expanduser(
    "~/workspace/agent-plaza/bridge/socket-heartbeat.json"
)
DEFAULT_PIDFILE = os.path.expanduser(
    "~/workspace/agent-plaza/bridge/socket-listener.pid"
)
# If the SDK reports not-connected continuously for this long, exit so
# the external restarter (supervisor hook / systemd) revives a fresh
# process. The SDK's own auto-reconnect runs first; this is the last
# resort for a stuck session, and the restarter applies backoff, which
# together form the single restart policy.
WATCHDOG_DISCONNECT_SECS = 45


def write_heartbeat(path, client):
    record = {
        "at": utc_now(),
        "ts_epoch": time.time(),
        "is_connected": bool(client.is_connected()),
        "session_id": client.session_id(),
        "pid": os.getpid(),
    }
    try:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(record, fh, ensure_ascii=False)
        os.replace(tmp, path)
    except OSError:
        pass  # heartbeat must never break forwarding
    return record


def append_diag(log_path, record):
    record = dict(record)
    record.setdefault("at", utc_now())
    try:
        os.makedirs(os.path.dirname(log_path), exist_ok=True)
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError:
        pass  # diagnostics must never break forwarding


def utc_now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def load_deploy_env(path=DEFAULT_DEPLOY_ENV):
    """Read KEY=value lines (no shell evaluation, no logging of values)."""
    values = {}
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                values[key.strip()] = val.strip().strip('"').strip("'")
    except OSError:
        pass
    return values


def build_ingress_payload(payload):
    """Map one Socket Mode envelope payload to the ingress POST body.

    ``payload`` is the whole envelope (``request.payload``): ``event_id``
    at the top level, the message event under ``payload["event"]``.
    Returns (idempotency_key, body_dict).
    """
    event_id = payload.get("event_id") or ""
    inner = payload.get("event") or {}
    channel = inner.get("channel", "")
    ts = inner.get("ts", "")
    return event_id, {
        "type": "doorbell.rang",
        "idempotencyKey": event_id,
        "data": {
            "hubEventId": event_id,
            "hubTs": ts,
            "channel": channel,
            "ts": ts,
            "thread_ts": inner.get("thread_ts"),
            "user": inner.get("user"),
            "source": "socket-mode",
        },
    }


def is_target_message(payload):
    """True only for message events in #agent-plaza.

    Root cause of the phase-0 "0 observations" finding (2026-11-07): the
    Events API payload inside a Socket Mode envelope carries
    ``type: "event_callback"`` -- ``"events_api"`` is the *envelope* type
    (``SocketModeRequest.type``), not a payload field. The original check
    compared the payload against the envelope type, so every real event
    was classified "ignored" and no observation line was ever written.
    Both values are accepted here so synthetic fixtures stay valid.
    """
    if payload.get("type") not in ("event_callback", "events_api"):
        return False
    inner = payload.get("event") or {}
    return (
        inner.get("type") == "message"
        and inner.get("channel") == TARGET_CHANNEL
        and bool(payload.get("event_id"))
    )


def post_ingress(base, producer_token, body, timeout=10):
    """POST one event to the doorbell ingress. Returns (http_status, text)."""
    req = urllib.request.Request(
        base.rstrip("/") + "/v1/events",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": "Bearer " + producer_token,
            "content-type": "application/json",
            # Cloudflare rejects the default Python-urllib UA with 403
            # (found in phase-0 triage, 2026-11-07: every forwarded event
            # failed with http 403 until this header was set).
            "User-Agent": "muse-agent-doorbell/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")
    except OSError as exc:
        return 0, str(exc)


def append_observation(log_path, record):
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    with open(log_path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")


def load_seen_event_ids(log_path):
    """Seed the dedupe set from already-posted observation lines."""
    seen = set()
    try:
        with open(log_path, encoding="utf-8") as fh:
            for line in fh:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if row.get("action") == "posted" and row.get("eventId"):
                    seen.add(row["eventId"])
    except OSError:
        pass
    return seen


class Forwarder:
    """Turns Socket Mode payloads into ingress POSTs + observations."""

    def __init__(self, base, producer_token, log_path=DEFAULT_OBS_LOG,
                 post_fn=None, dry_run=False):
        self.base = base
        self.producer_token = producer_token
        self.log_path = log_path
        self.post_fn = post_fn or post_ingress
        self.dry_run = dry_run
        self.seen = load_seen_event_ids(log_path)

    def handle(self, payload):
        """Handle one Socket Mode envelope payload. Returns an action str."""
        if not is_target_message(payload):
            return "ignored"
        event_id, body = build_ingress_payload(payload)
        if event_id in self.seen:
            return "duplicate"
        ts = (payload.get("event") or {}).get("ts", "")
        if self.dry_run:
            print(json.dumps(
                {"action": "dry_run", "eventId": event_id, "body": body},
                ensure_ascii=False))
            return "dry_run"
        status, text = self.post_fn(self.base, self.producer_token, body)
        self.last_error = None if status == 202 else (text or "")[:300]
        if status == 202:
            self.seen.add(event_id)
            append_observation(self.log_path, {
                "observed_at": utc_now(),
                "eventId": event_id,
                "ts": ts,
                "action": "posted",
                "http": status,
                "source": "socket-mode",
            })
            return "posted"
        append_observation(self.log_path, {
            "observed_at": utc_now(),
            "eventId": event_id,
            "ts": ts,
            "action": "post_failed",
            "http": status,
            "source": "socket-mode",
            "error": self.last_error,
        })
        return "post_failed"


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    dry_run = False
    if "--dry-run" in argv:
        dry_run = True
        argv.remove("--dry-run")
    if os.environ.get("AGENT_PLAZA_DRY_RUN") == "1":
        dry_run = True

    bot_token = os.environ.get("SLACK_BOT_TOKEN")
    app_token = os.environ.get("SLACK_APP_TOKEN")
    if not bot_token or not app_token:
        print("SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set",
              file=sys.stderr)
        return 2
    if not TARGET_CHANNEL:
        print("TARGET_CHANNEL_ID must be set", file=sys.stderr)
        return 2

    deploy = load_deploy_env()
    base = os.environ.get("WORKER_BASE") or deploy.get("WORKER_BASE")
    if not base and not dry_run:
        print("WORKER_BASE not found (env or deploy.env)", file=sys.stderr)
        return 2
    producer_token = os.environ.get("PRODUCER_TOKEN") or \
        deploy.get("PRODUCER_TOKEN")
    if not producer_token and not dry_run:
        print("PRODUCER_TOKEN not found (env or deploy.env)", file=sys.stderr)
        return 2

    # Imports are deferred so the module can be unit-tested without
    # slack_sdk installed.
    from slack_sdk.socket_mode import SocketModeClient
    from slack_sdk.socket_mode.response import SocketModeResponse
    from slack_sdk.web import WebClient

    # Persist SDK logs (INFO+) to a home file: the journal is lost on
    # every VM replacement, which made past connection failures invisible.
    import logging
    diag_path = os.environ.get("AGENT_PLAZA_DIAG_LOG", DEFAULT_DIAG_LOG)
    sdk_log_path = os.environ.get("AGENT_PLAZA_SDK_LOG", DEFAULT_SDK_LOG)
    try:
        os.makedirs(os.path.dirname(sdk_log_path), exist_ok=True)
        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s %(levelname)s %(name)s: %(message)s",
            handlers=[logging.StreamHandler(sys.stderr),
                      logging.FileHandler(sdk_log_path)],
        )
    except OSError:
        logging.basicConfig(level=logging.INFO)

    log_path = os.environ.get("AGENT_PLAZA_OBS_LOG", DEFAULT_OBS_LOG)
    forwarder = Forwarder(base, producer_token, log_path=log_path,
                          dry_run=dry_run)
    client = SocketModeClient(app_token=app_token,
                              web_client=WebClient(token=bot_token))

    def on_request(socket_client, request):
        # Acknowledge every envelope first, then forward the payload.
        socket_client.send_socket_mode_response(
            SocketModeResponse(envelope_id=request.envelope_id))
        payload = request.payload or {}
        inner = payload.get("event") or {}
        try:
            action = forwarder.handle(payload)
        except Exception as exc:  # never let a forward failure kill the loop
            print("forward error: %r" % (exc,), file=sys.stderr)
            append_diag(diag_path, {
                "kind": "envelope", "action": "error",
                "error": repr(exc),
                "payload_type": payload.get("type"),
                "event_id": payload.get("event_id"),
                "event_type": inner.get("type"),
                "channel": inner.get("channel"),
            })
            return
        print(json.dumps({"event_id": payload.get("event_id"),
                          "action": action}, ensure_ascii=False))
        append_diag(diag_path, {
            "kind": "envelope", "action": action,
            "payload_type": payload.get("type"),
            "event_id": payload.get("event_id"),
            "event_type": inner.get("type"),
            "channel": inner.get("channel"),
            "error": getattr(forwarder, "last_error", None),
        })

    client.socket_mode_request_listeners.append(on_request)
    client.connect()
    print("socket mode listener connected (plan B: ingress forwarding); "
          "log: %s" % log_path)
    append_diag(diag_path, {
        "kind": "startup", "dry_run": dry_run,
        "is_connected": client.is_connected(),
        "session_id": client.session_id(),
    })
    heartbeat_path = os.environ.get("AGENT_PLAZA_HEARTBEAT_FILE",
                                    DEFAULT_HEARTBEAT_FILE)
    pidfile_path = os.environ.get("AGENT_PLAZA_PIDFILE", DEFAULT_PIDFILE)
    try:
        with open(pidfile_path, "w", encoding="utf-8") as fh:
            fh.write("%d\n" % os.getpid())
    except OSError:
        pass
    write_heartbeat(heartbeat_path, client)
    disconnected_since = None
    try:
        while True:
            time.sleep(30)
            record = write_heartbeat(heartbeat_path, client)
            append_diag(diag_path, {
                "kind": "heartbeat",
                "is_connected": record["is_connected"],
                "session_id": record["session_id"],
            })
            if record["is_connected"]:
                disconnected_since = None
            else:
                if disconnected_since is None:
                    disconnected_since = time.time()
                elif time.time() - disconnected_since >= \
                        WATCHDOG_DISCONNECT_SECS:
                    append_diag(diag_path, {
                        "kind": "watchdog_exit",
                        "disconnected_secs":
                            int(time.time() - disconnected_since),
                        "session_id": record["session_id"],
                    })
                    print("watchdog: not connected for %ds; exiting for "
                          "external restart" % WATCHDOG_DISCONNECT_SECS,
                          file=sys.stderr)
                    return 3
    except KeyboardInterrupt:
        client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

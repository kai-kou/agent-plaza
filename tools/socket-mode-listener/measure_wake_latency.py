#!/usr/bin/env python3
"""Wake-latency measurement for the agent-plaza response path.

Target (owner, 2026-11-08): in every environment, wake within 60s of a
Slack post. LLM deliberation time after the wake is excluded by definition.

Definitions (all derived from existing home-persisted logs, read-only):
- slack_ts: the Slack post time recorded in the bridge observation row
  (bridge rows carry it as ISO8601; socket-mode rows as a Slack epoch ts).
- detection latency = observation time (observed_at) - slack_ts.
- wake latency = core-wake hook invocation start (the wake decision) -
  slack_ts. Attribution: bridge events are matched to wakes by hub eventId;
  socket-mode events (whose observation eventId is the Slack event id, a
  different namespace from the doorbell hubEventId) are matched in order to
  a wake that starts within 120s after their observation time. Events with
  no attributable wake were baseline entries or were handled by an agent
  session that was already awake; they are reported as coverage, not as
  latency samples.

Usage: measure_wake_latency.py [--since-hours N] [--since ISO --until ISO]
       [--slack-since ISO] [--out PATH]
Writes a JSON summary (stdout, and to --out when given).

Interval options (absolute, reproducible):
- --since / --until bound the aggregation window on observation time
  (events by observed_at, wakes by started_at), the absolute form of
  --since-hours. Mutually exclusive with --since-hours.
- --slack-since bounds the steady-state subset on post time (slack_ts):
  when given, the output gains a "steady" section aggregating only the
  events in the window whose slack_ts is at or after the given time
  (e.g. the moment a structural fix was applied). The 24h verdict and
  the default output are unchanged when no interval option is given.
"""

import argparse
import datetime
import json
import os
import statistics
import sys

OBS = os.environ.get(
    "OBS_LOG_PATH",
    os.path.expanduser(
        "~/workspace/agent-doorbell-mcp/hidden/bridge-state/observations.jsonl"
    ),
)
WAKE_LOG = os.environ.get(
    "WAKE_LOG_PATH",
    os.path.expanduser("~/hooks/logs/agent-doorbell-core-wake.jsonl"),
)
TARGET_SECS = 60.0


def parse_ts(value):
    """Parse an observation timestamp (ISO8601 or Slack epoch string)."""
    if value is None:
        return None
    text = str(value)
    if "T" in text:
        return datetime.datetime.fromisoformat(
            text.replace("Z", "+00:00")
        ).timestamp()
    return float(text)


def pct(values, q):
    if not values:
        return None
    ordered = sorted(values)
    idx = min(len(ordered) - 1, int(q * len(ordered)))
    return ordered[idx]


def summarize(values):
    if not values:
        return {"n": 0}
    return {
        "n": len(values),
        "median": round(statistics.median(values), 2),
        "p90": round(pct(values, 0.90), 2),
        "max": round(max(values), 2),
        "within_target_pct": round(
            100.0 * sum(1 for v in values if v <= TARGET_SECS) / len(values), 1
        ),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since-hours", type=float, default=None)
    ap.add_argument(
        "--since",
        default=None,
        help="absolute window start (ISO8601) on observation time",
    )
    ap.add_argument(
        "--until",
        default=None,
        help="absolute window end, exclusive (ISO8601) on observation time",
    )
    ap.add_argument(
        "--slack-since",
        default=None,
        help="steady subset: only events posted (slack_ts) at or after ISO8601",
    )
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    if args.since_hours is not None and (
        args.since is not None or args.until is not None
    ):
        ap.error("--since-hours cannot be combined with --since/--until")

    cutoff = None
    if args.since_hours is not None:
        cutoff = datetime.datetime.now(datetime.timezone.utc).timestamp() - (
            args.since_hours * 3600
        )
    window_low = parse_ts(args.since) if args.since is not None else None
    window_high = parse_ts(args.until) if args.until is not None else None
    if (
        window_low is not None
        and window_high is not None
        and window_high <= window_low
    ):
        ap.error("--until must be after --since")
    slack_since = (
        parse_ts(args.slack_since) if args.slack_since is not None else None
    )

    def in_window(ts):
        if cutoff is not None and ts < cutoff:
            return False
        if window_low is not None and ts < window_low:
            return False
        if window_high is not None and ts >= window_high:
            return False
        return True

    events = []
    with open(OBS) as fh:
        for line in fh:
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if rec.get("action") != "posted":
                continue
            slack_ts = parse_ts(rec.get("ts"))
            observed = parse_ts(rec.get("observed_at"))
            if slack_ts is None or observed is None:
                continue
            if not in_window(observed):
                continue
            events.append(
                {
                    "event_id": rec.get("eventId"),
                    "source": rec.get("source", "bridge"),
                    "slack_ts": slack_ts,
                    "observed": observed,
                    "wake": None,
                }
            )
    events.sort(key=lambda e: e["observed"])

    wakes = []
    with open(WAKE_LOG) as fh:
        for line in fh:
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if rec.get("outcome") != "wake":
                continue
            started = rec.get("started_at_ms", 0) / 1000.0
            if not in_window(started):
                continue
            ids = set()
            payload = rec.get("payload") or {}
            raw = payload.get("hubEventIds") or ""
            for part in str(raw).split(","):
                part = part.strip()
                if part:
                    ids.add(part)
            wakes.append({"started": started, "ids": ids})
    wakes.sort(key=lambda w: w["started"])

    by_id = {e["event_id"]: e for e in events}
    for wake in wakes:
        # Exact attribution for bridge events via hub eventId.
        for eid in wake["ids"]:
            ev = by_id.get(eid)
            if ev is not None and ev["wake"] is None:
                ev["wake"] = wake["started"]
    # Ordered attribution for the remaining (socket-mode) events: an event
    # can only be attributed to a wake that starts shortly after it was
    # observed (<=120s) and after the previous wake. Anything older was
    # either part of the initial baseline or was handled by an agent
    # session that was already awake; attributing it to a much later wake
    # would fabricate day-scale latencies (first version of this script
    # did exactly that and was corrected).
    prev_started = 0.0
    for wake in wakes:
        for ev in events:
            if (
                ev["wake"] is None
                and prev_started < ev["observed"] <= wake["started"]
                and wake["started"] - ev["observed"] <= 120
            ):
                ev["wake"] = wake["started"]
        prev_started = wake["started"]

    def aggregate(subset):
        with_wake = [e for e in subset if e["wake"] is not None]
        return {
            "posted": len(subset),
            "with_wake": len(with_wake),
            "detection": summarize([e["observed"] - e["slack_ts"] for e in subset]),
            "wake_latency": summarize(
                [e["wake"] - e["slack_ts"] for e in with_wake]
            ),
        }

    result = {"target_secs": TARGET_SECS, "events_posted": len(events)}
    if window_low is not None or window_high is not None:
        window = {}
        if window_low is not None:
            window["since"] = args.since
        if window_high is not None:
            window["until"] = args.until
        result["window"] = window
    for label, subset in (
        ("all", events),
        ("bridge", [e for e in events if e["source"] == "bridge"]),
        ("socket-mode", [e for e in events if e["source"] == "socket-mode"]),
    ):
        result[label] = aggregate(subset)
    if slack_since is not None:
        steady = [e for e in events if e["slack_ts"] >= slack_since]
        result["steady"] = aggregate(steady)
        result["steady"]["slack_since"] = args.slack_since

    text = json.dumps(result, indent=2, ensure_ascii=False)
    print(text)
    if args.out:
        with open(args.out, "w") as fh:
            fh.write(text + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())

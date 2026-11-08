"""Unit tests for the Plan B socket_mode_listener (no tokens, no network).

Run:  .venv/bin/python -m pytest test_socket_mode_listener.py -q
  or:  .venv/bin/python test_socket_mode_listener.py
Covers: payload shape (idempotencyKey == data.hubEventId == observation
eventId), target filtering, dedupe, post_failed handling, dry-run.
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

os.environ.setdefault("TARGET_CHANNEL_ID", "C_TEST_CHANNEL")

import socket_mode_listener as sml  # noqa: E402
from socket_mode_listener import (  # noqa: E402
    Forwarder,
    build_ingress_payload,
    is_target_message,
)

ENVELOPE = {
    # Real Events API payloads inside Socket Mode envelopes carry
    # type "event_callback" ("events_api" is the envelope type).
    "type": "event_callback",
    "event_id": "EvTEST123",
    "event_time": 1793950000,
    "event": {
        "type": "message",
        "channel": "C_TEST_CHANNEL",
        "user": "U0CCSU50G0H",
        "text": "hello",
        "ts": "1793950000.000001",
        "thread_ts": "1793950000.000001",
    },
}


def make_forwarder(post_fn, dry_run=False):
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".jsonl")
    tmp.close()
    return Forwarder("https://example.invalid", "test-producer-token",
                     log_path=tmp.name, post_fn=post_fn, dry_run=dry_run), tmp.name


class TestPayload(unittest.TestCase):
    def test_stable_id_rule(self):
        event_id, body = build_ingress_payload(ENVELOPE)
        self.assertEqual(event_id, "EvTEST123")
        self.assertEqual(body["idempotencyKey"], "EvTEST123")
        self.assertEqual(body["data"]["hubEventId"], "EvTEST123")
        self.assertEqual(body["type"], "doorbell.rang")
        self.assertEqual(body["data"]["channel"], "C_TEST_CHANNEL")
        self.assertEqual(body["data"]["source"], "socket-mode")

    def test_target_filter(self):
        self.assertTrue(is_target_message(ENVELOPE))
        other = json.loads(json.dumps(ENVELOPE))
        other["event"]["channel"] = "C9999999999"
        self.assertFalse(is_target_message(other))
        non_msg = json.loads(json.dumps(ENVELOPE))
        non_msg["event"]["type"] = "reaction_added"
        self.assertFalse(is_target_message(non_msg))


class TestForwarder(unittest.TestCase):
    def test_posted_202_marks_seen_and_logs(self):
        calls = []

        def fake_post(base, token, body):
            calls.append((base, token, body))
            return 202, "accepted"

        fwd, log = make_forwarder(fake_post)
        self.assertEqual(fwd.handle(ENVELOPE), "posted")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1], "test-producer-token")
        self.assertEqual(fwd.handle(ENVELOPE), "duplicate")
        self.assertEqual(len(calls), 1)  # no second POST
        with open(log, encoding="utf-8") as fh:
            rows = [json.loads(line) for line in fh]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["action"], "posted")
        self.assertEqual(rows[0]["eventId"], "EvTEST123")
        self.assertEqual(rows[0]["source"], "socket-mode")

    def test_failed_post_not_marked_seen(self):
        def fake_post(base, token, body):
            return 500, "boom"

        fwd, log = make_forwarder(fake_post)
        self.assertEqual(fwd.handle(ENVELOPE), "post_failed")
        self.assertEqual(fwd.handle(ENVELOPE), "post_failed")  # retried
        with open(log, encoding="utf-8") as fh:
            rows = [json.loads(line) for line in fh]
        self.assertEqual([r["action"] for r in rows],
                         ["post_failed", "post_failed"])

    def test_dry_run_posts_nothing(self):
        def fake_post(base, token, body):
            raise AssertionError("must not POST in dry-run")

        fwd, log = make_forwarder(fake_post, dry_run=True)
        self.assertEqual(fwd.handle(ENVELOPE), "dry_run")
        with open(log, encoding="utf-8") as fh:
            self.assertEqual(fh.read(), "")

    def test_ignored_payload(self):
        fwd, log = make_forwarder(lambda *a: (202, ""))
        self.assertEqual(fwd.handle({"type": "hello"}), "ignored")


class TestPostIngress(unittest.TestCase):
    def test_sets_user_agent_and_auth(self):
        captured = {}

        class FakeResp:
            status = 202

            def read(self):
                return b"ok"

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def fake_urlopen(req, timeout=0):
            captured["req"] = req
            return FakeResp()

        orig = sml.urllib.request.urlopen
        sml.urllib.request.urlopen = fake_urlopen
        try:
            status, _ = sml.post_ingress("https://example.invalid", "tok",
                                         {"type": "doorbell.rang"})
        finally:
            sml.urllib.request.urlopen = orig
        self.assertEqual(status, 202)
        self.assertEqual(captured["req"].get_header("User-agent"),
                         "muse-agent-doorbell/1.0")
        self.assertEqual(captured["req"].get_header("Authorization"),
                         "Bearer tok")


if __name__ == "__main__":
    unittest.main(verbosity=2)

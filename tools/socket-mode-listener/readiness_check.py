#!/usr/bin/env python3
"""Readiness check for the VM-replacement operations method (2026-11-08).

Verifies, from home-persisted state only, that the Slack response path is
in its established configuration:
1. boot-history hook has recorded the current boot (boot_id + btime).
2. supervisor hook is enabled.
3. Socket Mode listener is alive, connected, and its heartbeat is fresh.
4. token env file permissions are 0600.
5. supervisor carries the start-time guard and the 45s stale threshold;
   the listener watchdog is 45s (configuration drift check).
6. attributed wake latency over the last 24h is within the 60s target.

Informational: whether the legacy systemd unit exists under /etc (the
method must not depend on it; absence is the expected state).

Usage: readiness_check.py [--json]
Exit code 0 when every critical check passes.
"""

import json
import os
import subprocess
import sys
import time

HOME = os.path.expanduser("~")
BRIDGE = HOME + "/workspace/agent-plaza/bridge"


def check(name, ok, detail, critical=True):
    return {"name": name, "ok": bool(ok), "critical": critical, "detail": detail}


def main():
    as_json = "--json" in sys.argv
    results = []

    # 1. boot history covers the current boot
    try:
        with open("/proc/sys/kernel/random/boot_id") as fh:
            boot_id = fh.read().strip()
    except OSError:
        boot_id = "unknown"
    last_boot = None
    try:
        with open(BRIDGE + "/boot-history.jsonl") as fh:
            lines = [ln for ln in fh if ln.strip()]
        if lines:
            last_boot = json.loads(lines[-1]).get("boot_id")
    except OSError:
        pass
    results.append(
        check(
            "boot-history records current boot",
            last_boot == boot_id,
            "current=%s recorded=%s" % (boot_id, last_boot),
        )
    )

    # 2. supervisor enabled
    try:
        with open(HOME + "/hooks/definitions/agent-plaza-socket-supervisor.json") as fh:
            sup_enabled = json.load(fh).get("enabled") is True
    except (OSError, json.JSONDecodeError):
        sup_enabled = False
    results.append(check("supervisor hook enabled", sup_enabled, ""))

    # 3. listener alive + connected + heartbeat fresh
    hb_age = None
    connected = False
    try:
        with open(BRIDGE + "/socket-heartbeat.json") as fh:
            hb = json.load(fh)
        hb_age = time.time() - float(hb.get("ts_epoch", 0))
        connected = hb.get("is_connected") is True
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        pass
    pid_alive = False
    try:
        with open(BRIDGE + "/socket-listener.pid") as fh:
            pid = int(fh.read().strip())
        with open("/proc/%d/cmdline" % pid, "rb") as fh:
            pid_alive = b"socket_mode_listener" in fh.read()
    except (OSError, ValueError):
        pass
    results.append(
        check(
            "listener alive, connected, heartbeat fresh (<=60s)",
            pid_alive and connected and hb_age is not None and hb_age <= 60,
            "pid_alive=%s connected=%s hb_age=%s"
            % (pid_alive, connected, None if hb_age is None else round(hb_age, 1)),
        )
    )

    # 4. token env permissions
    import os
    import stat

    try:
        mode = stat.S_IMODE(os.stat(HOME + "/.config/agent-plaza/env").st_mode)
        env_ok = mode == 0o600
        env_detail = oct(mode)
    except OSError:
        env_ok, env_detail = False, "missing"
    results.append(check("token env file is 0600", env_ok, env_detail))

    # 5. configuration drift: guard + thresholds
    try:
        with open(HOME + "/hooks/scripts/agent-plaza-socket-supervisor.sh") as fh:
            sup_src = fh.read()
        guard_ok = "start-time guard" in sup_src and "STALE_SECS=45" in sup_src
    except OSError:
        guard_ok = False
    results.append(
        check("supervisor start-time guard + stale 45s", guard_ok, "")
    )
    try:
        with open(BRIDGE + "/socket_mode_listener.py") as fh:
            lis_src = fh.read()
        wd_ok = "WATCHDOG_DISCONNECT_SECS = 45" in lis_src
    except OSError:
        wd_ok = False
    results.append(check("listener watchdog 45s", wd_ok, ""))

    # 6. wake latency over the last 24h (attributed wakes)
    lat_ok, lat_detail = False, "analyzer failed"
    try:
        out = subprocess.run(
            ["python3", BRIDGE + "/measure_wake_latency.py", "--since-hours", "24"],
            capture_output=True,
            text=True,
            timeout=60,
        )
        summary = json.loads(out.stdout)
        wl = summary["all"]["wake_latency"]
        if wl.get("n", 0) > 0:
            lat_ok = wl["within_target_pct"] == 100.0
            lat_detail = "n=%d median=%ss p90=%ss max=%ss within60=%s%%" % (
                wl["n"],
                wl["median"],
                wl["p90"],
                wl["max"],
                wl["within_target_pct"],
            )
        else:
            lat_detail = "no attributed wakes in 24h"
            lat_ok = True  # nothing to violate; not a failure of the path
    except Exception as exc:  # noqa: BLE001
        lat_detail = "error: %s" % exc
    results.append(check("wake latency 24h within 60s target", lat_ok, lat_detail))

    # informational: legacy systemd unit presence under /etc
    unit_present = os.path.exists(
        "/etc/systemd/system/agent-plaza-socket-listener.service"
    )
    results.append(
        check(
            "legacy systemd unit under /etc (informational; absence expected)",
            True,
            "present=%s" % unit_present,
            critical=False,
        )
    )

    critical_ok = all(r["ok"] for r in results if r["critical"])
    if as_json:
        print(json.dumps({"ok": critical_ok, "checks": results}, indent=2))
    else:
        for r in results:
            mark = "PASS" if r["ok"] else ("FAIL" if r["critical"] else "INFO")
            line = "[%s] %s" % (mark, r["name"])
            if r["detail"]:
                line += " — " + r["detail"]
            print(line)
        print("OVERALL:", "PASS" if critical_ok else "FAIL")
    return 0 if critical_ok else 1


if __name__ == "__main__":
    sys.exit(main())

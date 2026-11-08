#!/usr/bin/env bash
# agent-plaza Socket Mode listener supervisor (phase 1, owner-approved
# 2026-11-07). Poll 5s. Kicks the home-based listener when it is not
# running, and kills it when its heartbeat goes stale (zombie/freeze).
# Priority rule during coexistence: while the systemd unit is active,
# systemd owns the listener and this hook only stands by.
# Normal paths are silent; wake only on a zombie kill or repeated
# launch failures, so the agent can report to the owner.
set -uo pipefail
source "$HATCH_HOOK_RUNTIME"

BRIDGE_DIR="$HOME/workspace/agent-plaza/bridge"
HB="$BRIDGE_DIR/socket-heartbeat.json"
PIDFILE="$BRIDGE_DIR/socket-listener.pid"
LOCK="$BRIDGE_DIR/socket-listener.lock"
STATE_DIR="$HOME/hooks/state/agent-plaza-socket-supervisor"
mkdir -p "$STATE_DIR"
LAUNCH_LOG="$STATE_DIR/launches.log"
DRY="${HATCH_HOOK_DRY_RUN:-0}"
NOW="$(date +%s)"
BOOT_ID="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)"

# Stale threshold: 45s since 2026-11-08 (operations method; wake-within-60s
# target). The listener heartbeat interval is 30s, so 45s is ~1.5 intervals.
# Tightening this is safe only together with the start-time guard below:
# the previous 180s mtime-only rule still false-killed a just-launched
# listener once (2026-11-08, pid 835), because a new process has not yet
# written a fresh heartbeat and the file may predate the current boot.
STALE_SECS=45
if [ -f "$STATE_DIR/stale_secs" ]; then
  STALE_SECS="$(cat "$STATE_DIR/stale_secs")"
fi

# --- Priority rule: systemd owns the listener while it is active. ---
if systemctl is-active --quiet agent-plaza-socket-listener.service 2>/dev/null; then
  silent "systemd listener active; supervisor standing by" '{}'
  exit 0
fi

lock_held() {
  ( exec 8>"$LOCK"; flock -n 8 ) 2>/dev/null
  [ $? -ne 0 ]
}

hb_age() {
  python3 - "$HB" "$NOW" <<'PY' 2>/dev/null || echo 999999
import json, sys
try:
    with open(sys.argv[1]) as fh:
        rec = json.load(fh)
    print(int(float(sys.argv[2]) - float(rec.get("ts_epoch", 0))))
except Exception:
    print(999999)
PY
}

if lock_held; then
  AGE="$(hb_age)"
  if [ "$AGE" -le "$STALE_SECS" ]; then
    silent "listener running; heartbeat ${AGE}s old" '{}'
    exit 0
  fi
  # Stale heartbeat while the lock is held: frozen/zombie holder.
  PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "$PID" ] && [ -r "/proc/$PID/cmdline" ] && tr '\0' ' ' < "/proc/$PID/cmdline" | grep -q socket_mode_listener; then
    # Start-time guard (2026-11-08, operations method): never kill a process
    # younger than the stale threshold. Kill only when the process itself is
    # older than the threshold AND its heartbeat is stale.
    PROC_START="$(python3 - "$PID" <<'PY' 2>/dev/null || echo 0
import sys
pid = sys.argv[1]
try:
    with open("/proc/stat") as fh:
        btime = int([l.split()[1] for l in fh if l.startswith("btime")][0])
    with open("/proc/%s/stat" % pid) as fh:
        starttime = int(fh.read().rsplit(")", 1)[1].split()[19])
    import os
    print(btime + starttime // os.sysconf("SC_CLK_TCK"))
except Exception:
    print(0)
PY
)"
    PROC_AGE=$(( NOW - PROC_START ))
    if [ "$PROC_START" -gt 0 ] && [ "$PROC_AGE" -lt "$STALE_SECS" ]; then
      silent "listener pid $PID is only ${PROC_AGE}s old; stale-kill deferred by start-time guard" '{}'
      exit 0
    fi
    if [ "$DRY" = "1" ]; then
      silent "dry run: would kill stale listener pid $PID (heartbeat ${AGE}s old)" '{}'
      exit 0
    fi
    kill "$PID" 2>/dev/null || true
    sleep 2
    kill -9 "$PID" 2>/dev/null || true
    log "killed stale listener" "{\"pid\":$PID,\"heartbeat_age_s\":$AGE}"
    wake "Socket Mode listener heartbeat stale; killed frozen process" "{\"pid\":$PID,\"heartbeat_age_s\":$AGE}"
    exit 0
  fi
  silent "lock held but holder process unknown; leaving it alone" '{}'
  exit 0
fi

# --- No listener running: crash-loop guard, then launch. ---
# launches.log lines: "<epoch> <boot_id> <result>"
RECENT="$(awk -v now="$NOW" -v boot="$BOOT_ID" '$2==boot && (now-$1)<120 {c++} END {print c+0}' "$LAUNCH_LOG" 2>/dev/null || echo 0)"
if [ "$RECENT" -ge 3 ]; then
  silent "crash-loop guard: $RECENT launches in 120s; backing off" '{}'
  exit 0
fi

if [ "$DRY" = "1" ]; then
  silent "dry run: would launch listener via start-listener.sh" '{}'
  exit 0
fi

setsid nohup "$BRIDGE_DIR/start-listener.sh" >/dev/null 2>&1 &
sleep 3
if lock_held; then
  printf '%s %s ok\n' "$NOW" "$BOOT_ID" >> "$LAUNCH_LOG"
  tail -n 50 "$LAUNCH_LOG" > "$LAUNCH_LOG.tmp" && mv "$LAUNCH_LOG.tmp" "$LAUNCH_LOG"
  log "launched listener" "{\"recent_launches\":$RECENT}"
  silent "listener launched" '{}'
  exit 0
fi

printf '%s %s failed\n' "$NOW" "$BOOT_ID" >> "$LAUNCH_LOG"
tail -n 50 "$LAUNCH_LOG" > "$LAUNCH_LOG.tmp" && mv "$LAUNCH_LOG.tmp" "$LAUNCH_LOG"
FAILED_RECENT="$(awk -v now="$NOW" -v boot="$BOOT_ID" '$2==boot && $3=="failed" && (now-$1)<600 {c++} END {print c+0}' "$LAUNCH_LOG")"
log "listener launch failed" "{\"failed_recent\":$FAILED_RECENT}"
if [ "$FAILED_RECENT" -ge 3 ]; then
  wake "Socket Mode listener launch failed repeatedly" "{\"failed_recent\":$FAILED_RECENT}"
  exit 0
fi
silent "listener launch failed (attempt recorded)" '{}'
exit 0

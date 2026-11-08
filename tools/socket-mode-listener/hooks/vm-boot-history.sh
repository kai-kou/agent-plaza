#!/usr/bin/env bash
# vm-boot-history: records every OS/runtime-cell boot (boot_id + btime) into
# a home-persisted append-only log, so post-replacement diagnosis never again
# depends on systemd journals that die with the previous boot (lesson of the
# systemd era, 2026-11-06/07: 11 listener stops with no boot_id preserved).
# Poll 60s, always silent. Part of the VM-replacement operations method
# established 2026-11-08 (see ~/workspace/research-vm-resilience/OPERATIONS.md).
set -uo pipefail
source "$HATCH_HOOK_RUNTIME"

LOG="$HOME/workspace/agent-plaza/bridge/boot-history.jsonl"
STATE_DIR="$HOME/hooks/state/vm-boot-history"
STATE="$STATE_DIR/last_boot_id"
mkdir -p "$STATE_DIR" "$(dirname "$LOG")"
BOOT_ID="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)"
BTIME="$(awk '/^btime/{print $2}' /proc/stat 2>/dev/null || echo 0)"
DRY="${HATCH_HOOK_DRY_RUN:-0}"

if [ -f "$STATE" ] && [ "$(cat "$STATE" 2>/dev/null)" = "$BOOT_ID" ]; then
  silent "boot unchanged ($BOOT_ID)" '{}'
  exit 0
fi

if [ "$DRY" = "1" ]; then
  silent "dry run: would record boot $BOOT_ID (btime $BTIME)" '{}'
  exit 0
fi

python3 - "$LOG" "$BOOT_ID" "$BTIME" <<'PY'
import datetime
import json
import sys
import time

path, boot_id, btime = sys.argv[1], sys.argv[2], int(sys.argv[3])
now = int(time.time())
rec = {
    "boot_id": boot_id,
    "btime": btime,
    "boot_time_iso": (
        datetime.datetime.fromtimestamp(btime, datetime.timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
        if btime
        else None
    ),
    "first_seen_epoch": now,
    "first_seen_iso": datetime.datetime.fromtimestamp(now, datetime.timezone.utc)
    .isoformat()
    .replace("+00:00", "Z"),
}
with open(path, "a") as fh:
    fh.write(json.dumps(rec) + "\n")
PY
printf '%s' "$BOOT_ID" > "$STATE"
log "boot recorded" "{\"boot_id\":\"$BOOT_ID\",\"btime\":$BTIME}"
silent "boot change recorded ($BOOT_ID)" '{}'
exit 0

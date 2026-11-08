#!/usr/bin/env bash
# Launcher for the Socket Mode listener (phase 1, hook-kick design).
# The supervisor hook runs this detached; this script takes the flock on
# fd 9 and then exec's into the listener, so the lock holder IS the
# listener process itself (verified pattern: fd survives exec, lock is
# released by the kernel when the process dies, including kill -9).
# Exit 42 = another instance already holds the lock.
set -uo pipefail

BRIDGE_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCK="$BRIDGE_DIR/socket-listener.lock"
PIDFILE="$BRIDGE_DIR/socket-listener.pid"
STDOUT_LOG="$BRIDGE_DIR/socket-listener-stdout.log"

exec 9>"$LOCK"
if ! flock -n 9; then
  exit 42
fi

# Tokens come from the 0600 env file, read by this launcher shell only;
# values are never printed. Proxy variables are inherited from the
# caller's environment (the hook runtime provides them), which avoids
# the stale cross-session proxy snapshot that broke the systemd path.
if [ -f "$HOME/.config/agent-plaza/env" ]; then
  set -a
  . "$HOME/.config/agent-plaza/env"
  set +a
fi
# HOME is inherited from the caller (the hook runtime); the listener
# resolves its state files against it. Do not hard-code a home path here.
export PYTHONUNBUFFERED=1

# $$ is this shell's pid; exec preserves the pid, so it stays correct.
printf '%s\n' "$$" > "$PIDFILE"

exec "$BRIDGE_DIR/.venv/bin/python" "$BRIDGE_DIR/socket_mode_listener.py" >>"$STDOUT_LOG" 2>&1

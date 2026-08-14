#!/usr/bin/env bash
# Restart the dsh web GUI (http://127.0.0.1:3080) so the newly added
# dsh-hello-plugin bundle mounts. Run from anywhere; it locates the checkout.
#
# Usage: bash scripts/restart-web.sh
#
# 1. SIGTERM the process currently listening on 127.0.0.1:3080 (the GUI),
# 2. wait for the port to free,
# 3. start `node apps/cli/lib/bin.js web` from the checkout, detached
#    (nohup+setsid), logging to $HOME/.dsh/web-restart.log,
# 4. wait for the port to come back and print the URL line.
set -euo pipefail

CHECKOUT="${DSH_CHECKOUT:-/Users/gswl00001/Me/DeepSeekHarness/deepseek-harness}"
BIN="$CHECKOUT/apps/cli/lib/bin.js"
PORT="${DSH_WEB_PORT:-3080}"
LOG="${DSH_WEB_LOG:-$HOME/.dsh/web-restart.log}"

if [[ ! -f "$BIN" ]]; then
  echo "restart-web: dsh bin not found at $BIN (set DSH_CHECKOUT)" >&2
  exit 1
fi

# Find the PID listening on the port (macOS lsof).
PID="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
if [[ -n "$PID" ]]; then
  echo "restart-web: sending SIGTERM to $PID (port $PORT)"
  kill -TERM "$PID" 2>/dev/null || true
  for _ in $(seq 1 100); do
    if ! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then break; fi
    sleep 0.1
  done
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "restart-web: port $PORT still busy, force killing" >&2
    kill -KILL "$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t | head -1)" 2>/dev/null || true
    sleep 0.5
  fi
else
  echo "restart-web: nothing listening on port $PORT — starting fresh"
fi

cd "$CHECKOUT"
rm -f "$LOG"
# Detached so the server survives this script (and its parent) exiting.
setsid nohup /usr/local/bin/node "$BIN" web >>"$LOG" 2>&1 < /dev/null &
echo "restart-web: launched dsh web (pid $!), log: $LOG"

for _ in $(seq 1 200); do
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "restart-web: dsh web is up on http://127.0.0.1:$PORT"
    exit 0
  fi
  sleep 0.1
done
echo "restart-web: timed out waiting for port $PORT; log tail:" >&2
tail -40 "$LOG" >&2 || true
exit 1

#!/bin/bash
# Restart com.foundry.verify (Mac1 :8803) only in a real gap, never by force. A restart is a deploy: run it only on
# Mohamed's own yes. Everything in flight dies with the process (a request collecting a late job's result, a late
# watcher, a quarantine, a reconciler), so the gap is all of these at once, seen on two looks 10 s apart:
#   - no running job-verify-* in the fabric ledger (newest 500),
#   - no ESTABLISHED connection on :8803 (11-14 20:53Z: two requests collecting finished jobs died, no gate retry),
#   - /health says not busy and nothing quarantined.
# No gap within --max-wait-min (default 120): exit 1, nothing restarted, nothing stopped.
#
#   restart_when_idle.sh [--max-wait-min N]
set -uo pipefail
max_min=120
[ "${1:-}" = "--max-wait-min" ] && max_min=$2
FABRIC=~/fleet/bin/fabric
LABEL=gui/$(id -u)/com.foundry.verify
TOKEN_FILE=~/.config/foundry/verify-token

running() { "$FABRIC" job ls --last 500 2>/dev/null | awk '$1 ~ /^job-verify-/ && $3=="running" {print $1}'; }
inflight() { lsof -nP -iTCP:8803 -sTCP:ESTABLISHED 2>/dev/null | awk 'NR>1 && tolower($1) ~ /python/' | wc -l | tr -d ' '; }
health() { curl -s -m 5 "http://127.0.0.1:8803/$(cat "$TOKEN_FILE")/health"; }
idle() {
  [ -z "$(running)" ] && [ "$(inflight)" = 0 ] || return 1
  health | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if not d.get("busy") and not d.get("quarantined") else 1)'
}

deadline=$(( $(date +%s) + max_min * 60 ))
while :; do
  if idle; then
    sleep 10
    idle && break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "no gap in ${max_min} min (running: $(running | tr '\n' ' ')connections: $(inflight)); not restarted"
    exit 1
  fi
  sleep 10
done

old=$(launchctl print "$LABEL" | awk '/^\tpid =/ {print $3; exit}')
launchctl kickstart -k "$LABEL"
echo "restarted at $(date -u +%H:%M:%SZ) (old pid ${old:-none})"
for _ in $(seq 1 60); do health >/dev/null 2>&1 && break; sleep 5; done   # startup took 2 min on a loaded Mac1 (11-14)
echo "pid $(launchctl print "$LABEL" | awk '/^\tpid =/ {print $3; exit}'), health: $(health || echo unreachable)"

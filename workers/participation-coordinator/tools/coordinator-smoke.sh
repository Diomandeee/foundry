#!/usr/bin/env bash
# Boots the participation coordinator locally in REAL issuer mode (no dev bearer)
# and proves the HTTP contract end-to-end over the exact client route.
#   workers/participation-coordinator/tools/coordinator-smoke.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$PKG/../.." && pwd)"
PORT="${PORT:-8795}"
DB="$(mktemp -t participation-smoke).sqlite"
rm -f "$DB"
SECRET="${COORD_TOKEN_SECRET:-$(cat "$PKG/.token_secret" 2>/dev/null || python3 -c 'import os,base64;print(base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("="))')}"

cleanup() { [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null || true; rm -f "$DB"; }
trap cleanup EXIT

cd "$ROOT"
COORD_DB="$DB" COORD_TOKEN_SECRET="$SECRET" PORT="$PORT" npx tsx "$PKG/src/dev-server.ts" >/tmp/coordinator-smoke.log 2>&1 &
SRV=$!

for _ in $(seq 1 80); do
  if curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
curl -sf "http://localhost:$PORT/health" >/dev/null || { echo "server did not start"; cat /tmp/coordinator-smoke.log; exit 1; }

npx tsx "$PKG/tools/smoke-client.ts" "http://localhost:$PORT"
npx tsx "$PKG/tools/smoke-flow.ts" "http://localhost:$PORT"

#!/usr/bin/env bash
# Subscribe one Artifacts repo's pushes to the env queue.
# The event-subscription API requires repo_name, so every task fork needs
# its own subscription — a namespace-wide sub is rejected. Run this after
# POST /tasks mints a fork (or use setup-env.sh, which covers all repos).
# Usage: bash tools/subscribe-repo.sh staging|production <repo>
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
ENVN="${1:?usage: subscribe-repo.sh staging|production <repo>}"
REPO="${2:?usage: subscribe-repo.sh staging|production <repo>}"
if [ "$ENVN" = "production" ]; then SUF="prod"; else SUF="$ENVN"; fi
NS="foundry-$SUF"
QUEUE="foundry-push-events-$SUF"
ACCT="$(npx wrangler whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -1)"
# Wrangler 4.15x keeps OAuth credentials in the OS keychain and refreshes them there,
# so the oauth_token line in default.toml goes stale; ask wrangler for the live token.
TOK="$(npx wrangler auth token --json 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')"
QID="$(npx wrangler queues info "$QUEUE" 2>/dev/null | grep -i 'queue id' | grep -oE '[0-9a-f]{32}' | head -1)"
NAME="$QUEUE $REPO pushed"
# The list endpoint pages (20 per page by default; 450+ subscriptions by 2026-10-30), so walk every
# page: reading only page 1 missed existing subscriptions and hid the missing ones.
list_subs() {
  TOK="$TOK" ACCT="$ACCT" python3 - <<'PY'
import json, os, urllib.request
acct, tok, page = os.environ["ACCT"], os.environ["TOK"], 1
while True:
    req = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/accounts/{acct}/event_subscriptions/subscriptions?per_page=50&page={page}",
        headers={"Authorization": f"Bearer {tok}"})
    d = json.load(urllib.request.urlopen(req))
    if not d.get("success"):
        raise SystemExit(f"event_subscriptions list failed: {d.get('errors')}")
    for s in d.get("result") or []:
        print(s["id"] + "\t" + s.get("name", ""))
    info = d.get("result_info") or {}
    if page >= (info.get("total_pages") or 1):
        break
    page += 1
PY
}
HAVE="$(list_subs | awk -F'\t' -v n="$NAME" '$2 == n {print $1}')"
if [ -n "$HAVE" ]; then echo "exists: $NAME ($HAVE)"; exit 0; fi
OUT="$(curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCT/event_subscriptions/subscriptions" \
  -H "Authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d "{\"name\":\"$NAME\",\"destination\":{\"type\":\"queues.queue\",\"queue_id\":\"$QID\"},\"source\":{\"type\":\"artifacts.repo\",\"namespace\":\"$NS\",\"repo_name\":\"$REPO\"},\"events\":[\"pushed\"],\"enabled\":true}")"
echo "$OUT" | head -c 160; echo
# A push made before the subscription exists never reaches the gate, so fail loudly here.
echo "$OUT" | grep -q '"success":true' || { echo "subscribe failed for $REPO" >&2; exit 1; }

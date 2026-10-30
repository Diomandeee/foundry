#!/usr/bin/env bash
# Foundry environment setup — staging/production mirror of the dev spike.
# Idempotent: safe to re-run. Usage: bash tools/setup-env.sh staging|production
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
ENVN="${1:?usage: setup-env.sh staging|production}"
if [ "$ENVN" = "production" ]; then SUF="prod"; else SUF="$ENVN"; fi
NS="foundry-$SUF"
D1="foundry-decisions-$SUF"
QUEUE="foundry-push-events-$SUF"
SEED="seed"
say() { printf '\033[1;36m[env:%s]\033[0m %s\n' "$ENVN" "$*"; }

say "seed repo (provisions namespace $NS)"
npx wrangler artifacts repos create "$SEED" --namespace "$NS" 2>&1 | tail -2 || true

say "D1 schema on $D1"
npx wrangler d1 execute "$D1" --remote --file workers/gate/schema.sql 2>&1 | tail -2

say "queue $QUEUE"
npx wrangler queues create "$QUEUE" 2>&1 | tail -1 || true

say "deploy gate/orchestrator/api (-e $ENVN)"
npx wrangler deploy -c workers/gate/wrangler.toml -e "$ENVN" 2>&1 | grep -E "Uploaded|error" | head -2
npx wrangler deploy -c workers/orchestrator/wrangler.toml -e "$ENVN" 2>&1 | grep -E "Uploaded|error" | head -2
npx wrangler deploy -c workers/api/wrangler.toml -e "$ENVN" 2>&1 | grep -E "Uploaded|error" | head -2

say "queue consumer: $QUEUE -> foundry-gate-$ENVN"
npx wrangler queues consumer add "$QUEUE" "foundry-gate-$ENVN" 2>&1 | tail -1

say "event subscriptions: every repo in $NS -> $QUEUE"
# The API requires repo_name (namespace-wide subs are rejected), so each
# repo — seed, base, and every task fork — gets its own subscription.
# A repo without one silently drops its push events at the gate.
ACCT="$(npx wrangler whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -1)"
# Wrangler 4.15x keeps OAuth credentials in the OS keychain and refreshes them there,
# so the oauth_token line in default.toml goes stale; ask wrangler for the live token.
TOK="$(npx wrangler auth token --json 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')"
QID="$(npx wrangler queues info "$QUEUE" 2>/dev/null | grep -i 'queue id' | grep -oE '[0-9a-f]{32}' | head -1)"
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
EXISTING="$(list_subs)"
# Remove the legacy seed-only sub (bare "$QUEUE pushed" name).
while IFS=$'\t' read -r SUBID SUBNAME; do
  [ "$SUBNAME" = "$QUEUE pushed" ] || continue
  curl -s -X DELETE "https://api.cloudflare.com/client/v4/accounts/$ACCT/event_subscriptions/subscriptions/$SUBID" \
    -H "Authorization: Bearer $TOK" >/dev/null && say "   removed legacy seed-only sub $SUBID"
done <<< "$EXISTING"
REPOS="$(npx wrangler artifacts repos list --namespace "$NS" 2>/dev/null | grep -oE '│ [A-Za-z0-9._-]+ ' | awk '{print $2}' | sort -u)"
for REPO in $REPOS; do bash tools/subscribe-repo.sh "$ENVN" "$REPO" 2>&1 | sed 's/^/   /'; done
echo
say "done. Smoke: push to $NS/$SEED, expect reject verdict in $D1."

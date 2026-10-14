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
TOK="$(grep -i oauth_token ~/Library/Preferences/.wrangler/config/default.toml | head -1 | sed 's/.*= *//;s/"//g')"
QID="$(npx wrangler queues info "$QUEUE" 2>/dev/null | grep -i 'queue id' | grep -oE '[0-9a-f]{32}' | head -1)"
EXISTING="$(curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCT/event_subscriptions/subscriptions" \
  -H "Authorization: Bearer $TOK" | python3 -c "import sys,json; print('\n'.join(s['id']+chr(9)+s.get('name','') for s in json.load(sys.stdin).get('result',[])))")"
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

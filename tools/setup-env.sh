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

say "event subscription: $NS/$SEED pushed -> $QUEUE"
ACCT="$(npx wrangler whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -1)"
TOK="$(grep -i oauth_token ~/Library/Preferences/.wrangler/config/default.toml | head -1 | sed 's/.*= *//;s/"//g')"
QID="$(npx wrangler queues info "$QUEUE" 2>/dev/null | grep -i 'queue id' | grep -oE '[0-9a-f]{32}' | head -1)"
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCT/event_subscriptions/subscriptions" \
  -H "Authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d "{\"name\":\"$QUEUE pushed\",\"destination\":{\"type\":\"queues.queue\",\"queue_id\":\"$QID\"},\"source\":{\"type\":\"artifacts.repo\",\"namespace\":\"$NS\",\"repo_name\":\"$SEED\"},\"events\":[\"pushed\"],\"enabled\":true}" | head -c 200
echo
say "done. Smoke: push to $NS/$SEED, expect reject verdict in $D1."

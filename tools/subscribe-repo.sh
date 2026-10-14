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
TOK="$(grep -i oauth_token ~/Library/Preferences/.wrangler/config/default.toml | head -1 | sed 's/.*= *//;s/"//g')"
QID="$(npx wrangler queues info "$QUEUE" 2>/dev/null | grep -i 'queue id' | grep -oE '[0-9a-f]{32}' | head -1)"
NAME="$QUEUE $REPO pushed"
HAVE="$(curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCT/event_subscriptions/subscriptions" \
  -H "Authorization: Bearer $TOK" | python3 -c "import sys,json; print('\n'.join(s['id'] for s in json.load(sys.stdin).get('result',[]) if s.get('name')=='$NAME'))")"
if [ -n "$HAVE" ]; then echo "exists: $NAME ($HAVE)"; exit 0; fi
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCT/event_subscriptions/subscriptions" \
  -H "Authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d "{\"name\":\"$NAME\",\"destination\":{\"type\":\"queues.queue\",\"queue_id\":\"$QID\"},\"source\":{\"type\":\"artifacts.repo\",\"namespace\":\"$NS\",\"repo_name\":\"$REPO\"},\"events\":[\"pushed\"],\"enabled\":true}" | head -c 160
echo

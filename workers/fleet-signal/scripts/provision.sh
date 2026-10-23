#!/usr/bin/env bash
# Generate the fleet-signal owner bearer locally and push ONLY its sha256 digest.
#   bash workers/fleet-signal/scripts/provision.sh staging
# Bearer: ~/.config/foundry/fleet-signal-<env>/owner-bearer (0600, staging-grade,
# readable by Mac1 agents; rotate before production). Never printed.
set -euo pipefail
ENV=${1:?env (staging|production)}
DIR=$HOME/.config/foundry/fleet-signal-$ENV
umask 077; mkdir -p "$DIR"
[[ -s $DIR/owner-bearer ]] || openssl rand -hex 32 > "$DIR/owner-bearer"
DIGEST=$(tr -d '\n' < "$DIR/owner-bearer" | shasum -a 256 | cut -c1-64)
cd "$(dirname "$0")/.."
printf '%s' "$DIGEST" | npx --no-install wrangler secret put FLEET_SIGNAL_OWNER_SHA256 --env "$ENV" >/dev/null
echo "{\"env\":\"$ENV\",\"owner_bearer_sha256\":\"$DIGEST\",\"at\":\"$(date -u +%FT%TZ)\"}" > "$DIR/provision-receipt.json"
echo "provisioned $ENV (owner digest ${DIGEST:0:12}...)"

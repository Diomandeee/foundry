#!/usr/bin/env bash
# Provision the compute authority's secrets for one wrangler environment.
#
#   scripts/provision.sh staging
#
# Generates the issuer identity, an owner bearer and a verifier bearer, stores
# the bearers under ~/.config/foundry/compute-<env>/ (mode 0600; still readable
# by anything running as the login user: a staging-grade store, rotate before
# production) and pushes only the issuer pair plus the bearers' SHA-256 digests
# to Cloudflare with `wrangler secret put`. Nothing secret is printed; the
# receipt carries digests' first 12 hex characters only. Refuses to overwrite
# an existing token directory.
set -euo pipefail
ENV_NAME=${1:?usage: provision.sh <wrangler env>}
[[ $ENV_NAME =~ ^[A-Za-z0-9._-]{1,64}$ ]] || { echo "bad env name" >&2; exit 1; }
cd "$(dirname "$0")/.."
DIR="$HOME/.config/foundry/compute-$ENV_NAME"
[[ -e $DIR ]] && { echo "$DIR exists; rotate explicitly instead of re-provisioning" >&2; exit 1; }
umask 077
mkdir -p "$DIR"
rand() { openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n'; }   # 64 chars of [A-Za-z0-9_-]
digest() { printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1; }

ISSUER_ID="issuer-$ENV_NAME-$(date -u +%Y%m%d)"
ISSUER_KEY=$(rand)
OWNER=$(rand); VERIFIER=$(rand)
printf '%s' "$OWNER" > "$DIR/owner.token"
printf '%s' "$VERIFIER" > "$DIR/verifier.token"
OWNER_D=$(digest "$OWNER"); VERIFIER_D=$(digest "$VERIFIER")
AUTH_CONFIG=$(printf '[{"tokenSha256":"%s","principal":"operator-mac1","role":"owner","environment":"%s"},{"tokenSha256":"%s","principal":"verifier-mac1","role":"verifier","environment":"%s"}]' \
  "$OWNER_D" "$ENV_NAME" "$VERIFIER_D" "$ENV_NAME")
printf '%s' "$AUTH_CONFIG" > "$DIR/auth-config.json"

printf '%s' "$ISSUER_ID"  | npx --no-install wrangler secret put COMPUTE_ISSUER_ID  --env "$ENV_NAME" >/dev/null
printf '%s' "$ISSUER_KEY" | npx --no-install wrangler secret put COMPUTE_ISSUER_KEY --env "$ENV_NAME" >/dev/null
printf '%s' "$AUTH_CONFIG" | npx --no-install wrangler secret put COMPUTE_AUTH_CONFIG --env "$ENV_NAME" >/dev/null
unset ISSUER_KEY OWNER VERIFIER

cat > "$DIR/receipt.json" <<EOF
{"env":"$ENV_NAME","issuerId":"$ISSUER_ID","at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)",
 "owner":{"principal":"operator-mac1","digestPrefix":"${OWNER_D:0:12}"},
 "verifier":{"principal":"verifier-mac1","digestPrefix":"${VERIFIER_D:0:12}"},
 "secrets":["COMPUTE_ISSUER_ID","COMPUTE_ISSUER_KEY","COMPUTE_AUTH_CONFIG"],"store":"$DIR"}
EOF
cat "$DIR/receipt.json"

#!/usr/bin/env bash
# Foundry Paid Spike — IMPLEMENTATION.md §8 checklist, runnable.
# Runs the hour billing is enabled. Idempotent where wrangler allows.
#
#   create foundry-dev namespace -> seed repo -> deploy gate + orchestrator
#   -> create D1 -> attach event subscription -> push -> watch decision in D1
#   -> verify clone/push over https -> flip demo to live
#
# Requires: wrangler logged in (Workers Paid), CF_ACCOUNT_ID optional.
# Usage:  bash tools/paid-spike.sh [--seed-repo NAME] [--seed-file PATH]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NS="foundry-dev"
SEED_REPO="${SEED_REPO:-seed}"
SEED_FILE="${SEED_FILE:-README.md}"
D1_NAME="foundry-decisions"
QUEUE_NAME="foundry-push-events"
LEDGER="${ROOT}/.spike-ledger.json"

say()  { printf '\033[1;36m[spike]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[spike]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[spike]\033[0m %s\n' "$*" >&2; exit 1; }
ledger(){ python3 - "$LEDGER" "$1" "$2" <<'PY'
import json,sys,os
p,k,v=sys.argv[1],sys.argv[2],sys.argv[3]
d=json.load(open(p)) if os.path.exists(p) else {}
d[k]=v; json.dump(d,open(p,'w'),indent=2); print(' ',k,'=',v)
PY
}

# ---------- 0. preflight ----------
say "preflight: wrangler + auth"
command -v npx >/dev/null || die "npx not found"
WHO="$(npx wrangler whoami 2>&1 || true)"
if grep -qi 'not authenticated' <<<"$WHO"; then
  die "wrangler not logged in. Run: npx wrangler login  (then re-run). Paid plan must be active for Artifacts."
fi
grep -qi 'paid' <<<"$WHO" || warn "could not confirm Paid plan in whoami; Artifacts binding will fail without it."
ACCOUNT_ID="$(grep -oE '[0-9a-f]{32}' <<<"$WHO" | head -1 || true)"
[ -n "${ACCOUNT_ID:-}" ] && ledger account_id "$ACCOUNT_ID"

say "preflight: local suite must be green before deploy"
npm run typecheck
npm test

# ---------- 1. Artifacts namespace + seed repo ----------
# Artifacts namespaces are provisioned via the Artifacts API/binding; there is
# no stable wrangler subcommand across versions, so do it with the API and
# fall back to a clear instruction if the endpoint differs.
say "1/8 Artifacts namespace: $NS"
if [ -n "${CF_API_TOKEN:-}" ] && [ -n "${ACCOUNT_ID:-}" ]; then
  code=$(curl -s -o /tmp/spike_ns.json -w '%{http_code}' -X POST \
    "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/artifacts/namespaces" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" -H 'content-type: application/json' \
    -d "{\"name\":\"${NS}\"}" || true)
  case "$code" in
    200|201) say "   namespace created" ;;
    409)     say "   namespace already exists" ;;
    *)       warn "   namespace API returned $code (see /tmp/spike_ns.json). Create '${NS}' in the dashboard if needed." ;;
  esac
else
  warn "   CF_API_TOKEN not set — create namespace '${NS}' in the Artifacts dashboard, then continue."
fi

say "1b/8 seed repo: $SEED_REPO (file $SEED_FILE)"
if [ -n "${CF_API_TOKEN:-}" ] && [ -n "${ACCOUNT_ID:-}" ]; then
  curl -s -o /tmp/spike_repo.json -X POST \
    "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/artifacts/namespaces/${NS}/repos" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" -H 'content-type: application/json' \
    -d "{\"name\":\"${SEED_REPO}\"}" >/dev/null || warn "   seed repo API call failed; create '${SEED_REPO}' manually"
  say "   seed repo requested"
else
  warn "   create seed repo '${SEED_REPO}' manually in namespace '${NS}'"
fi

# ---------- 2. D1 ----------
say "2/8 D1 database: $D1_NAME"
D1_OUT="$(npx wrangler d1 create "$D1_NAME" 2>&1 || true)"
echo "$D1_OUT" | sed 's/^/   /'
D1_ID="$(grep -oE '"database_id": *"[0-9a-f-]{36}"' <<<"$D1_OUT" | grep -oE '[0-9a-f-]{36}' | head -1 || true)"
if [ -z "$D1_ID" ]; then
  D1_ID="$(npx wrangler d1 list --json 2>/dev/null | python3 -c 'import json,sys;d=json.load(sys.stdin);print(next((x["uuid"] for x in d if x["name"]=="'"$D1_NAME"'"),""))' 2>/dev/null || true)"
fi
[ -n "$D1_ID" ] && ledger d1_id "$D1_ID" || warn "could not resolve D1 id; set it in wrangler.toml manually"
if [ -n "$D1_ID" ]; then
  for f in workers/gate/wrangler.toml workers/orchestrator/wrangler.toml; do
    python3 - "$f" "$D1_ID" <<'PY'
import re,sys
p,i=sys.argv[1],sys.argv[2]
s=open(p).read()
s=re.sub(r'database_id = "[0-9a-f-]{36}"', f'database_id = "{i}"', s, count=1)
open(p,'w').write(s)
print('  patched',p)
PY
  done
  say "   applying schema"
  npx wrangler d1 execute "$D1_NAME" --file workers/gate/schema.sql --remote
fi

# ---------- 3. Queues ----------
say "3/8 queue: $QUEUE_NAME"
npx wrangler queues create "$QUEUE_NAME" 2>&1 | sed 's/^/   /' || warn "queue may already exist"

# ---------- 4. deploy gate + orchestrator ----------
say "4/8 deploy gate"
npx wrangler deploy -c workers/gate/wrangler.toml 2>&1 | sed 's/^/   /'
say "4b/8 deploy orchestrator"
npx wrangler deploy -c workers/orchestrator/wrangler.toml 2>&1 | sed 's/^/   /'

# ---------- 5. event subscription ----------
say "5/8 attach event subscription: cf.artifacts.repo.pushed -> gate queue()"
warn "   account-level Artifacts event subscriptions are wired via API/dashboard."
warn "   Target: namespace=${NS}  ->  worker=foundry-gate  consumer=queue()  queue=${QUEUE_NAME}"
warn "   If a wrangler subcommand exists in 4.147+: npx wrangler queues consumer add ${QUEUE_NAME} foundry-gate"

# ---------- 6. push ----------
say "6/8 push to seed repo"
if [ -z "${SEED_CLONE_URL:-}" ]; then
  warn "   set SEED_CLONE_URL=https://<token>@<artifacts-host>/${NS}/${SEED_REPO}.git and re-run step 6,"
  warn "   or push from the dashboard. Skipping live push."
else
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  git clone "$SEED_CLONE_URL" "$TMP/seed"
  echo "spike $(date -u +%FT%TZ)" >> "$TMP/seed/$SEED_FILE"
  git -C "$TMP/seed" commit -am "spike push $(date -u +%FT%TZ)"
  git -C "$TMP/seed" push
  say "   pushed; waiting for gate to record a decision"
  sleep 15
fi

# ---------- 7. verify decision in D1 ----------
say "7/8 decision landed in D1?"
npx wrangler d1 execute "$D1_NAME" --remote \
  --command "SELECT verdict, count(*) FROM decisions GROUP BY verdict;" 2>&1 | sed 's/^/   /'

# ---------- 8. clone/push over https (IsomorphicMerger transport) ----------
say "8/8 https clone/push transport check"
if [ -n "${SEED_CLONE_URL:-}" ]; then
  TMP2="$(mktemp -d)"
  if git clone "$SEED_CLONE_URL" "$TMP2/c" >/dev/null 2>&1; then say "   clone OK"; else warn "   clone FAILED"; fi
  rm -rf "$TMP2"
else
  warn "   skipped (SEED_CLONE_URL unset)"
fi

say "done. Ledger: $LEDGER"
say "flip the demo to live: set PACT_URL + LKG_URL and re-run npm run demo:graphvc against the Artifacts remotes."

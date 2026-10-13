#!/usr/bin/env bash
# Apply rendered SQL to a remote D1 database, one statement at a time.
#
# Why not `wrangler d1 execute --file`? The file-import path on this database
# returns `{"D1_RESET_DO":true}` and never imports. The `--command` path works,
# but only for a single statement per call, so this splits on blank-line blocks,
# collapses continuation indentation, and runs each statement in turn.
#
#   npx tsx tools/bootstrap.ts --sql --reset | bash tools/d1-apply.sh
#   bash tools/d1-apply.sh /path/to/statements.sql
#
# Env: D1_NAME (default: participation), WRANGLER_HOME (default: the real account home)
set -euo pipefail

D1_NAME="${D1_NAME:-participation}"
WRANGLER_HOME="${WRANGLER_HOME:-$HOME}"
if [[ -d /Users/mohameddiomande ]]; then WRANGLER_HOME=/Users/mohameddiomande; fi  # real keychain/prefs

src="${1:-/dev/stdin}"
rendered="$(mktemp)"
awk 'BEGIN{RS=""} {gsub(/\n[ \t]+/," "); print}' "$src" > "$rendered"

n=0
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  n=$((n + 1))
  out="$(HOME="$WRANGLER_HOME" npx wrangler d1 execute "$D1_NAME" --remote --json --command "$line" 2>&1)" || true
  if ! grep -q '"success": true' <<<"$out"; then
    echo "statement $n FAILED:" >&2
    echo "$out" | head -20 >&2
    rm -f "$rendered"
    exit 1
  fi
done < "$rendered"
rm -f "$rendered"
echo "applied $n statement(s) to remote D1 '$D1_NAME'"

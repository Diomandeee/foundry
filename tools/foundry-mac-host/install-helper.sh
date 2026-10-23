#!/bin/bash
# Root: replace the pinned Mac VM host helper with a reviewed rebuild.
# Template: @NEW_SHA@ = sha256 of the signed binary staged at $SRC.
# Keeps the replaced binary under /Library/Foundry/retired/<sha>.mac-vm-host
# (root 0444) so the old capability's pin stays reproducible. Idempotent.
set -euo pipefail
SRC=${SRC:-/Volumes/FoundryBuild/staging/bin/mac-vm-host.v2}
NEW_SHA='@NEW_SHA@'
DST=/Library/Foundry/bin/mac-vm-host
RETIRED=/Library/Foundry/retired
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
echo "== $(date -u +%H:%M:%SZ) install mac-vm-host $NEW_SHA"
[[ $(shasum -a 256 "$SRC" | cut -c1-64) == "$NEW_SHA" ]] || { echo "$SRC does not hash to $NEW_SHA" >&2; exit 1; }
codesign --verify --strict "$SRC"
codesign -d --entitlements - "$SRC" 2>/dev/null | grep -q com.apple.security.virtualization || { echo "missing virtualization entitlement" >&2; exit 1; }
cur=$(shasum -a 256 "$DST" | cut -c1-64)
if [[ $cur != "$NEW_SHA" ]]; then
  install -d -o root -g wheel -m 0755 "$RETIRED"
  [[ -e $RETIRED/$cur.mac-vm-host ]] || install -o root -g wheel -m 0444 "$DST" "$RETIRED/$cur.mac-vm-host"
  install -o root -g wheel -m 0555 "$SRC" "$DST.new"
  mv -f "$DST.new" "$DST"
fi
[[ $(shasum -a 256 "$DST" | cut -c1-64) == "$NEW_SHA" ]] || { echo "install hash mismatch" >&2; exit 1; }
ls -la /Library/Foundry/bin "$RETIRED"

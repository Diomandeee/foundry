#!/usr/bin/env bash
# Install the Mac VM host helpers built in /Volumes/FoundryBuild/staging/bin.
#
#   install-host-helpers.sh <sha256 of mac-vm-host> <sha256 of mac-tree-guard>     (as root, via fleet-authority)
#
# Review H6 (2026-10-22): the staging dir is owned by the login user, and `codesign --verify` accepts any ad-hoc
# signature, so a signature check proves nothing about which bytes are installed. The approved request must
# carry both expected hashes. Each binary is copied into a root-only temp dir first, and the COPY is hashed and
# installed, so a swap in the staging dir after the check cannot reach /Library/Foundry/bin.
#
# The build runtime pins /Library/Foundry/bin/mac-vm-host and /Library/Foundry/bin/mac-tree-guard by path and
# sha256, and the helper walks paths with O_NOFOLLOW, so both live root-owned and non-writable there.
# mac-vm-host carries com.apple.security.virtualization (hardened runtime). Overwrites only these two files.
set -euo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
[[ $EUID -eq 0 ]] || { echo "run as root (stage it through fleet-authority)" >&2; exit 1; }
[[ $# -eq 2 && $1 =~ ^[0-9a-f]{64}$ && $2 =~ ^[0-9a-f]{64}$ ]] || { echo "usage: $0 <sha256 mac-vm-host> <sha256 mac-tree-guard>" >&2; exit 2; }
want() { case $1 in mac-vm-host) echo "$WANT_HOST";; mac-tree-guard) echo "$WANT_GUARD";; esac; }  # bash 3.2: no assoc arrays
WANT_HOST=$1; WANT_GUARD=$2
SRC=/Volumes/FoundryBuild/staging/bin
W=$(mktemp -d /var/root/host-helpers.XXXXXX); chmod 700 "$W"; trap 'rm -rf "$W"' EXIT
for f in mac-vm-host mac-tree-guard; do
  [[ -f $SRC/$f && ! -L $SRC/$f ]] || { echo "missing or symlinked $SRC/$f" >&2; exit 1; }
  cp "$SRC/$f" "$W/$f"
  got=$(shasum -a 256 "$W/$f" | cut -c1-64)
  [[ $got == "$(want $f)" ]] || { echo "REFUSED: $f sha256 $got, approved $(want $f)" >&2; exit 1; }
  codesign --verify --strict "$W/$f"
done
codesign -d --entitlements - "$W/mac-vm-host" 2>/dev/null | grep -q com.apple.security.virtualization \
  || { echo "mac-vm-host lacks the virtualization entitlement" >&2; exit 1; }
install -d -o root -g wheel -m 0755 /Library/Foundry/bin
for f in mac-vm-host mac-tree-guard; do
  install -o root -g wheel -m 0555 "$W/$f" "/Library/Foundry/bin/$f.new"
  mv -f "/Library/Foundry/bin/$f.new" "/Library/Foundry/bin/$f"
done
ls -la /Library/Foundry/bin
shasum -a 256 /Library/Foundry/bin/mac-vm-host /Library/Foundry/bin/mac-tree-guard

#!/usr/bin/env bash
# Install the Mac VM host helpers built in /Volumes/FoundryBuild/staging/bin.
#
#   sudo bash install-host-helpers.sh
#
# The build runtime pins /Library/Foundry/bin/mac-vm-host and
# /Library/Foundry/bin/mac-tree-guard by path and sha256, and the helper walks
# paths with O_NOFOLLOW, so both live root-owned and non-writable there.
# Built and ad-hoc signed on Mac5 (mac-vm-host carries
# com.apple.security.virtualization, hardened runtime). Prints the installed
# hashes for the capability record. Overwrites only these two files.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
SRC=/Volumes/FoundryBuild/staging/bin
for f in mac-vm-host mac-tree-guard; do
  [[ -x $SRC/$f ]] || { echo "missing $SRC/$f (build it first)" >&2; exit 1; }
  codesign --verify --strict "$SRC/$f"
done
codesign -d --entitlements - "$SRC/mac-vm-host" 2>/dev/null | grep -q com.apple.security.virtualization \
  || { echo "mac-vm-host lacks the virtualization entitlement" >&2; exit 1; }
install -d -o root -g wheel -m 0755 /Library/Foundry/bin
for f in mac-vm-host mac-tree-guard; do
  install -o root -g wheel -m 0555 "$SRC/$f" "/Library/Foundry/bin/$f"
done
ls -la /Library/Foundry/bin
shasum -a 256 /Library/Foundry/bin/*

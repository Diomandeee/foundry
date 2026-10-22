#!/bin/bash
# Build fleet-authority for install. Signing explicitly matters: swiftc only leaves a "linker-signed" ad-hoc
# signature, and macOS refuses to keep a Full Disk Access grant for linker-signed binaries (the System Settings
# toggle switches itself back off; found on Mac5 2026-10-22 with 1.4.0). A plain ad-hoc signature with a fixed
# identifier is what 1.0 had and what TCC accepts.
#   build.sh <out-path>     prints the sha256 to pin in the update script
set -euo pipefail
cd "$(dirname "$0")"
OUT=${1:?usage: build.sh <out-path>}
swiftc -O -target arm64-apple-macos14 FleetAuthority.swift -o "$OUT"
# SIGN_IDENTITY: an Apple Development / Developer ID identity gives TCC a stable requirement (team + identifier).
# Ad-hoc (the default "-") was not enough on macOS 27.2: the Full Disk Access toggle still flipped off (Mac5, 1.4.1).
codesign --force --sign "${SIGN_IDENTITY:--}" --identifier fleet-authority --options runtime --timestamp=none "$OUT"
codesign -dv "$OUT" 2>&1 | grep -E "Identifier|flags" >&2
shasum -a 256 "$OUT" | cut -c1-64

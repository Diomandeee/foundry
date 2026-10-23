#!/bin/bash
# Foundry 3: build Coltivare Release (prefetched packages) on image r4 / capability v5.
# Runs only attached files ($FLEET_FILES, root-only, part of the approved fingerprint). Deletes nothing.
set -uo pipefail
LOG=/Library/Foundry/VM/proof-logs/foundry-3-coltivare.log; : > "$LOG"; chmod 0644 "$LOG"
exec > >(/usr/bin/tee -a "$LOG") 2>&1
echo "== build Coltivare"; IMAGE=macos-27.0.1-xcode-27.1-r4 BOOT_SHA=2a0ac712595f2cf573b92ce0f10c670666ab590b0e7395bba45996cead682fea CAP_SHA=a0dc25c813c84b07cdfd937b9382d59110bdfb2703ffdb9fd1cd05040709b3a8 RUNNER_SHA=2182a9ac4523063aa3be1767fd31fdc447df469dde856157d3083a2eba7901b2 ATT=coltivare-f3855fb-d JOB_ID=coltivare-1 SRC_NAME=coltivare-f3855fb-2fb05b2f5804 PROJECT=Coltivare.xcodeproj SCHEME=Coltivare CONFIGURATION=Release OUTPUT_PATH=DerivedData/Build/Products/Release-iphoneos/Coltivare.app TIMEOUT_S=2900 CPU=4 MEM_GIB=6 OUT_DISK_GIB=2 /bin/bash "$FLEET_FILES/build-job.sh"
echo "== foundry-3 done"

#!/bin/bash
# Foundry 1: seal capability v5 (image r4, runner v3, helper 10af1eb5), then build Mo en Movimiento Debug.
# Runs only attached files ($FLEET_FILES, root-only, part of the approved fingerprint). Deletes nothing.
set -uo pipefail
LOG=/Library/Foundry/VM/proof-logs/foundry-1-cap-mo.log; : > "$LOG"; chmod 0644 "$LOG"
exec > >(/usr/bin/tee -a "$LOG") 2>&1
echo "== capability v5"; /bin/bash "$FLEET_FILES/seal-capability-v5.sh" || { echo "!! capability seal FAILED"; exit 1; }
echo "== build Mo en Movimiento"; IMAGE=macos-27.0.1-xcode-27.1-r4 BOOT_SHA=2a0ac712595f2cf573b92ce0f10c670666ab590b0e7395bba45996cead682fea CAP_SHA=a0dc25c813c84b07cdfd937b9382d59110bdfb2703ffdb9fd1cd05040709b3a8 RUNNER_SHA=2182a9ac4523063aa3be1767fd31fdc447df469dde856157d3083a2eba7901b2 ATT=mo-581552c-c JOB_ID=mo-en-movimiento-1 SRC_NAME=mo-en-movimiento-581552c-00ec70402c95 PROJECT=App/MoEnMovimiento.xcodeproj SCHEME=MoEnMovimiento CONFIGURATION=Debug OUTPUT_PATH=DerivedData/Build/Products/Debug-iphoneos/MoEnMovimiento.app TIMEOUT_S=2400 OUT_DISK_GIB=4 /bin/bash "$FLEET_FILES/build-job.sh"
echo "== foundry-1 done"

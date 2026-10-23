#!/bin/bash
# Request 18 on Mac5: build Coltivare (Release, prefetched packages) on image r4. Pinned build-job.sh. Deletes nothing.
LOG=/Library/Foundry/VM/proof-logs/request18.log; : > "$LOG"; chmod 0644 "$LOG"
exec > >(tee -a "$LOG") 2>&1
O=/Users/mohameddiomande/.foundry-obs
pin() { [[ $(shasum -a 256 "$O/$1" | cut -c1-64) == "$2" ]] || { echo "!! PIN MISMATCH $1"; exit 1; }; }
pin build-job.sh 182544cff4b9153c4721da4ccc2f617a3f2235038c2894fb74237a5552b86c7e
echo "== build Coltivare"
IMAGE=macos-27.0.1-xcode-27.1-r4 BOOT_SHA=2a0ac712595f2cf573b92ce0f10c670666ab590b0e7395bba45996cead682fea CAP_SHA=a0dc25c813c84b07cdfd937b9382d59110bdfb2703ffdb9fd1cd05040709b3a8 RUNNER_SHA=2182a9ac4523063aa3be1767fd31fdc447df469dde856157d3083a2eba7901b2 ATT=coltivare-f3855fb-b JOB_ID=coltivare-1 SRC_NAME=coltivare-f3855fb-2fb05b2f5804 PROJECT=Coltivare.xcodeproj SCHEME=Coltivare CONFIGURATION=Release OUTPUT_PATH=DerivedData/Build/Products/Release-iphoneos/Coltivare.app TIMEOUT_S=3300 CPU=4 MEM_GIB=6 OUT_DISK_GIB=2 bash "$O/build-job.sh"
echo "== request 18 done"

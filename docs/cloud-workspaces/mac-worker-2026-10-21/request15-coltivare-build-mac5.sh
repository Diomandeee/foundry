#!/bin/bash
# Request 15 on Mac5: build Coltivare (Release, prefetched packages) on image r3. Pinned build-job.sh. Deletes nothing.
LOG=/Library/Foundry/VM/proof-logs/request15.log; : > "$LOG"; chmod 0644 "$LOG"
exec > >(tee -a "$LOG") 2>&1
O=/Users/mohameddiomande/.foundry-obs
pin() { [[ $(shasum -a 256 "$O/$1" | cut -c1-64) == "$2" ]] || { echo "!! PIN MISMATCH $1"; exit 1; }; }
pin build-job.sh 182544cff4b9153c4721da4ccc2f617a3f2235038c2894fb74237a5552b86c7e
echo "== build Coltivare"
IMAGE=macos-27.0.1-xcode-27.1-r3 BOOT_SHA=f28a18479d250739fbb9019262b1ff506c57f0e3074827e952a6ae3b9936dc2d CAP_SHA=57662850255d3a0100923b956355dbdd661a56e44131e10c12634e787cff1385 RUNNER_SHA=ecd420d1c0e49651e6187789efdd88f047c92aa04d0b8d87568aefbe2ed1822d ATT=coltivare-f3855fb-a JOB_ID=coltivare-1 SRC_NAME=coltivare-f3855fb-2fb05b2f5804 PROJECT=Coltivare.xcodeproj SCHEME=Coltivare CONFIGURATION=Release OUTPUT_PATH=DerivedData/Build/Products/Release-iphoneos/Coltivare.app TIMEOUT_S=3300 CPU=4 MEM_GIB=6 OUT_DISK_GIB=2 bash "$O/build-job.sh"
echo "== request 15 done"

#!/bin/bash
# Request 17 on Mac5: seal capability v5 (image r4 + guest runner v3 + helper 10af1eb5),
# then build Mo en Movimiento and Air Deck from the already-sealed sources
# (results delivered to /Volumes/FoundryBuild/staging/results).
# Every script run here is pinned by sha256 below. Deletes nothing.
LOG=/Library/Foundry/VM/proof-logs/request17.log; : > "$LOG"; chmod 0644 "$LOG"
exec > >(tee -a "$LOG") 2>&1
O=/Users/mohameddiomande/.foundry-obs
pin() { [[ $(shasum -a 256 "$O/$1" | cut -c1-64) == "$2" ]] || { echo "!! PIN MISMATCH $1"; exit 1; }; }
pin airdeck.files 54f3ff8d2d7c0a94035c1c38fb072b60aea0db9f6ac3197c12692724f17ba897
pin build-job.sh 182544cff4b9153c4721da4ccc2f617a3f2235038c2894fb74237a5552b86c7e
pin coltivare.files 2fb05b2f58043fd234781ca41cc72f4324ff5c2d697caa73357deeed9620f355
pin mo.files 00ec70402c95a80e515345aed0f763e1229dfcb3a103e30837736d2a0fa40f8a
pin seal-airdeck-b12322a-54f3ff8d2d7c.sh d96067ebf082172d20937ee22ad14f8b77bb6b36a68e94c3e21193645aaa5d26
pin seal-capability-v5.sh 195aec1f57596067b86c0ba953a3d8ce5c9ef292f7c65d451830e0f33e06f382
pin seal-coltivare-f3855fb-2fb05b2f5804.sh d9209a841c0179d04f15325a2d189983e896f67114dd02bdeeae02e507247ad7
pin seal-mo-en-movimiento-581552c-00ec70402c95.sh 8367b0fcfacbe74d9d1b61949a54124d2d972375790aec1316e63acb6106d083
echo "== capability v4"; bash "$O/seal-capability-v5.sh" || { echo "!! capability seal FAILED"; exit 1; }
echo "== build Mo en Movimiento"
IMAGE=macos-27.0.1-xcode-27.1-r4 BOOT_SHA=2a0ac712595f2cf573b92ce0f10c670666ab590b0e7395bba45996cead682fea CAP_SHA=a0dc25c813c84b07cdfd937b9382d59110bdfb2703ffdb9fd1cd05040709b3a8 RUNNER_SHA=2182a9ac4523063aa3be1767fd31fdc447df469dde856157d3083a2eba7901b2 ATT=mo-581552c-b JOB_ID=mo-en-movimiento-1 SRC_NAME=mo-en-movimiento-581552c-00ec70402c95 PROJECT=App/MoEnMovimiento.xcodeproj SCHEME=MoEnMovimiento CONFIGURATION=Debug OUTPUT_PATH=DerivedData/Build/Products/Debug-iphoneos/MoEnMovimiento.app TIMEOUT_S=2400 OUT_DISK_GIB=4 bash "$O/build-job.sh"
echo "== build Air Deck"
IMAGE=macos-27.0.1-xcode-27.1-r4 BOOT_SHA=2a0ac712595f2cf573b92ce0f10c670666ab590b0e7395bba45996cead682fea CAP_SHA=a0dc25c813c84b07cdfd937b9382d59110bdfb2703ffdb9fd1cd05040709b3a8 RUNNER_SHA=2182a9ac4523063aa3be1767fd31fdc447df469dde856157d3083a2eba7901b2 ATT=airdeck-b12322a-b JOB_ID=airdeck-1 SRC_NAME=airdeck-b12322a-54f3ff8d2d7c PROJECT=AirDeck.xcodeproj SCHEME=AirDeck CONFIGURATION=Debug OUTPUT_PATH=DerivedData/Build/Products/Debug-iphoneos/AirDeck.app TIMEOUT_S=1800 OUT_DISK_GIB=2 bash "$O/build-job.sh"
echo "== request 17 done"

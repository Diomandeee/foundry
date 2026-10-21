#!/bin/bash
# Request 14 on Mac5: seal capability v4 (image r3 + guest runner v2 + helper 10af1eb5),
# seal the Mo en Movimiento, Air Deck and Coltivare sources, then build Mo en
# Movimiento and Air Deck (results delivered to /Volumes/FoundryBuild/staging/results).
# Every script run here is pinned by sha256 below. Deletes nothing.
LOG=/Library/Foundry/VM/proof-logs/request14.log; : > "$LOG"; chmod 0644 "$LOG"
exec > >(tee -a "$LOG") 2>&1
O=/Users/mohameddiomande/.foundry-obs
pin() { [[ $(shasum -a 256 "$O/$1" | cut -c1-64) == "$2" ]] || { echo "!! PIN MISMATCH $1"; exit 1; }; }
pin airdeck.files 54f3ff8d2d7c0a94035c1c38fb072b60aea0db9f6ac3197c12692724f17ba897
pin build-job.sh 182544cff4b9153c4721da4ccc2f617a3f2235038c2894fb74237a5552b86c7e
pin coltivare.files 2fb05b2f58043fd234781ca41cc72f4324ff5c2d697caa73357deeed9620f355
pin mo.files 00ec70402c95a80e515345aed0f763e1229dfcb3a103e30837736d2a0fa40f8a
pin seal-airdeck-b12322a-54f3ff8d2d7c.sh d96067ebf082172d20937ee22ad14f8b77bb6b36a68e94c3e21193645aaa5d26
pin seal-capability-v4.sh f6ec8d662906a1fcbb0cabe48c3089e8ddf11e6482bbe251f0da2411710dd3f3
pin seal-coltivare-f3855fb-2fb05b2f5804.sh d9209a841c0179d04f15325a2d189983e896f67114dd02bdeeae02e507247ad7
pin seal-mo-en-movimiento-581552c-00ec70402c95.sh 8367b0fcfacbe74d9d1b61949a54124d2d972375790aec1316e63acb6106d083
echo "== capability v4"; bash "$O/seal-capability-v4.sh" || { echo "!! capability seal FAILED"; exit 1; }
echo "== source airdeck-b12322a-54f3ff8d2d7c"; bash "$O/seal-airdeck-b12322a-54f3ff8d2d7c.sh" || { echo "!! source seal FAILED seal-airdeck-b12322a-54f3ff8d2d7c.sh"; exit 1; }
echo "== source coltivare-f3855fb-2fb05b2f5804"; bash "$O/seal-coltivare-f3855fb-2fb05b2f5804.sh" || { echo "!! source seal FAILED seal-coltivare-f3855fb-2fb05b2f5804.sh"; exit 1; }
echo "== source mo-en-movimiento-581552c-00ec70402c95"; bash "$O/seal-mo-en-movimiento-581552c-00ec70402c95.sh" || { echo "!! source seal FAILED seal-mo-en-movimiento-581552c-00ec70402c95.sh"; exit 1; }
echo "== build Mo en Movimiento"
IMAGE=macos-27.0.1-xcode-27.1-r3 BOOT_SHA=f28a18479d250739fbb9019262b1ff506c57f0e3074827e952a6ae3b9936dc2d CAP_SHA=57662850255d3a0100923b956355dbdd661a56e44131e10c12634e787cff1385 RUNNER_SHA=ecd420d1c0e49651e6187789efdd88f047c92aa04d0b8d87568aefbe2ed1822d ATT=mo-581552c-a JOB_ID=mo-en-movimiento-1 SRC_NAME=mo-en-movimiento-581552c-00ec70402c95 PROJECT=App/MoEnMovimiento.xcodeproj SCHEME=MoEnMovimiento CONFIGURATION=Debug OUTPUT_PATH=DerivedData/Build/Products/Debug-iphoneos/MoEnMovimiento.app TIMEOUT_S=2400 OUT_DISK_GIB=4 bash "$O/build-job.sh"
echo "== build Air Deck"
IMAGE=macos-27.0.1-xcode-27.1-r3 BOOT_SHA=f28a18479d250739fbb9019262b1ff506c57f0e3074827e952a6ae3b9936dc2d CAP_SHA=57662850255d3a0100923b956355dbdd661a56e44131e10c12634e787cff1385 RUNNER_SHA=ecd420d1c0e49651e6187789efdd88f047c92aa04d0b8d87568aefbe2ed1822d ATT=airdeck-b12322a-a JOB_ID=airdeck-1 SRC_NAME=airdeck-b12322a-54f3ff8d2d7c PROJECT=AirDeck.xcodeproj SCHEME=AirDeck CONFIGURATION=Debug OUTPUT_PATH=DerivedData/Build/Products/Debug-iphoneos/AirDeck.app TIMEOUT_S=1800 OUT_DISK_GIB=2 bash "$O/build-job.sh"
echo "== request 14 done"

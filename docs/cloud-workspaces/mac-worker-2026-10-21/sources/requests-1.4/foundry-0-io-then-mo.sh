#!/bin/bash
# Install the fixed intake tool (MAX_TREE 4 GiB + 128 MiB; the installed one capped intake at 8 MiB, so the
# 912 MB Mo en Movimiento app was refused at 17:27Z), then rebuild Mo en Movimiento so it lands via intake.
# The capability pins helper/guard/runner/boot, not mac-vm-io.py. Attached files only. Deletes nothing.
set -uo pipefail
LOG=/Library/Foundry/VM/proof-logs/foundry-1-cap-mo.log; : > "$LOG"; chmod 0644 "$LOG"
exec > >(/usr/bin/tee -a "$LOG") 2>&1
WANT=9a7687fd3a8e703ad2a8654041a2f413b291f6befd9ac6953712104175c5401b
W=$(/usr/bin/mktemp -d /var/root/io.XXXXXX); /bin/chmod 700 "$W"; /bin/cp "$FLEET_FILES/mac-vm-io.py" "$W/io.py"
[ "$(/usr/bin/shasum -a 256 "$W/io.py" | /usr/bin/cut -c1-64)" = "$WANT" ] || { echo "!! io hash mismatch"; exit 1; }
/bin/cp -p /Library/Foundry/bin/mac-vm-io.py /Library/Foundry/bin/mac-vm-io.py.prev-8MiB 2>/dev/null || true
/usr/bin/install -o root -g wheel -m 0555 "$W/io.py" /Library/Foundry/bin/mac-vm-io.py.new && /bin/mv -f /Library/Foundry/bin/mac-vm-io.py.new /Library/Foundry/bin/mac-vm-io.py
/bin/rm -rf "$W"; echo "== intake tool now $(/usr/bin/shasum -a 256 /Library/Foundry/bin/mac-vm-io.py | /usr/bin/cut -c1-16) (MAX_TREE $(/usr/bin/grep -m1 '^MAX_TREE' /Library/Foundry/bin/mac-vm-io.py))"
echo "== build Mo en Movimiento"; IMAGE=macos-27.0.1-xcode-27.1-r4 BOOT_SHA=2a0ac712595f2cf573b92ce0f10c670666ab590b0e7395bba45996cead682fea CAP_SHA=a0dc25c813c84b07cdfd937b9382d59110bdfb2703ffdb9fd1cd05040709b3a8 RUNNER_SHA=2182a9ac4523063aa3be1767fd31fdc447df469dde856157d3083a2eba7901b2 ATT=mo-581552c-e JOB_ID=mo-en-movimiento-1 SRC_NAME=mo-en-movimiento-581552c-00ec70402c95 PROJECT=App/MoEnMovimiento.xcodeproj SCHEME=MoEnMovimiento CONFIGURATION=Debug OUTPUT_PATH=DerivedData/Build/Products/Debug-iphoneos/MoEnMovimiento.app TIMEOUT_S=2400 OUT_DISK_GIB=4 /bin/bash "$FLEET_FILES/build-job.sh"
echo "== foundry-0 done"

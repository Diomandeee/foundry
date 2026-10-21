#!/bin/bash
# Request 10 on Mac5: why does mac-vm-host's VM start fail as foundrybuild when a
# minimal VM starts fine? Run the helper-identical config (vzmatrix, built from
# /Volumes/FoundryBuild/staging/vzmatrix.swift, sha-locked) as foundrybuild in its
# login session against attempt proof-r2-20261021b's own files, toggling one
# difference at a time: full | noshare | nooutput | cpu2. 5-second boots each.
# Baseline first: the minimal probe that started at 17:34 while the session was
# unlocked; run now with the Foundry Build screen locked.
# Also stops the hung request-9 helper if it is still alive. Deletes nothing.
set -uo pipefail
URL=http://100.84.118.106:9876
LOG=/Library/Foundry/VM/proof-logs/request10.log; : > "$LOG"; chmod 0644 "$LOG"
exec > >(tee -a "$LOG") 2>&1
BIN=/Volumes/FoundryBuild/staging/bin/vzmatrix; SHA=77b6acbd4657308d76e6259ec8419e15e4c5d48defed13e1db25ab64bf120e44
VM=/Library/Foundry/VM; A=$VM/attempts/proof-r2-20261021b; P=$VM/work/vzmatrix
echo "== $(date -u +%H:%M:%SZ) console owner: $(stat -f %Su /dev/console)"
for pid in $(pgrep -u 520 -f '/Library/Foundry/bin/mac-vm-host'); do echo "stopping hung helper $pid"; kill -9 $pid; done
[[ $(shasum -a 256 "$BIN" | cut -c1-64) == "$SHA" ]] || { echo "vzmatrix hash mismatch"; exit 1; }
install -d -o 520 -g 520 -m 0700 "$P"; install -o root -g wheel -m 0555 "$BIN" "$P/vzmatrix"
# The probe needs writable clones of the attempt's disks (the attempt's own stay untouched).
for f in boot.raw outputs.raw auxiliary.bin; do rm -f "$P/$f"; cp -c "$A/$f" "$P/$f"; chown 520:520 "$P/$f"; chmod 0600 "$P/$f"; done
for f in hardware-model.bin machine-identifier.bin; do install -o root -g wheel -m 0444 "$A/$f" "$P/$f"; done
echo "== $(date -u +%H:%M:%SZ) baseline: the minimal probe that STARTED at 17:34 (when the session was unlocked)"
timeout 70 launchctl asuser 520 sudo -u foundrybuild -g foundrybuild -H "$VM/work/vzprobe/vzstart" "$VM/work/vzprobe"; echo "baseline exit $?"
for v in full noshare nooutput cpu2; do
  echo "== $(date -u +%H:%M:%SZ) variant $v"
  timeout 70 launchctl asuser 520 sudo -u foundrybuild -g foundrybuild -H "$P/vzmatrix" "$P" "$P/outputs.raw" "$A/input" "$v"; echo "variant $v exit $?"
done
echo "== $(date -u +%H:%M:%SZ) share target"; ls -led "$A/input"; mount | grep "$A/input"
pkill -9 -u 520 -f vzmatrix 2>/dev/null; echo "== done"

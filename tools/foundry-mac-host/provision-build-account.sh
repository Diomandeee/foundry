#!/bin/bash
# Root request 2 for a Mac build worker host: the dedicated build account, the
# four owner-private runtime roots, and the root-pinned mailbox owner tool.
#
# What packages/build-runtime demands (host.ts canonical/dedicated, plans.ts,
# storage-inventory.ts, native/mac-vm-host.swift):
#   - the worker runs as a dedicated non-root account, uid >= 501, gid != 0;
#   - inputBase, workBase, journalRoot and the liveness cacheRoot are directories
#     owned by that account, mode 0700, every ancestor root- or owner-owned with
#     no group/other write bits, no symlinks, cacheRoot disjoint from workBase;
#   - /Library/Foundry/VM/attempts stays root-owned (vm inventory root);
#   - root I/O per attempt is operator-mediated through native/mac-vm-io.py,
#     which must live root-owned and non-writable next to the other helpers.
#
# Template: @IO_SHA@ is the sha256 of the mac-vm-io.py copy staged by the
# operator at $IO_SRC (the daemon-side copy is verified against it before
# install). Run as root through fleet-authority:
#
#   /usr/local/bin/fleet stage "<description>" --timeout 120 < provision-build-account-<host>.sh
#
# Idempotent. Creates: one hidden service account + group (uid/gid 520, shell
# /usr/bin/false, home /var/empty, no password), four directories, one helper
# file, one log. Deletes nothing. Refuses if uid/gid 520 belong to anyone else.
set -euo pipefail
NAME=_foundrybuild
ID=520
VM=/Library/Foundry/VM
BIN=/Library/Foundry/bin
IO_SRC=/Users/mohameddiomande/.foundry-obs/mac-vm-io.py
IO_SHA='@IO_SHA@'
LOG=$VM/host-provision.log
URL=http://100.84.118.106:9876

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ -d $VM/attempts ]] || { echo "$VM/attempts missing (run mount-vm-volume.sh first)" >&2; exit 1; }
: >> "$LOG"; chmod 0644 "$LOG"
exec > >(tee -a "$LOG" | curl -s --connect-timeout 5 -m 60 -X POST --data-binary @- "$URL/provision" >/dev/null 2>&1) 2>&1
log() { echo "== $(date -u +%H:%M:%SZ) $*"; }
trap 'echo "!! FAILED line $LINENO: $BASH_COMMAND"' ERR
log "provision $NAME on $(hostname) start"

log "account"
if dscl . -read "/Users/$NAME" UniqueID >/dev/null 2>&1; then
  have=$(dscl . -read "/Users/$NAME" UniqueID | awk '{print $2}')
  [[ $have == "$ID" ]] || { echo "$NAME exists with uid $have, expected $ID; refusing" >&2; exit 1; }
  echo "$NAME already exists (uid $ID)"
else
  [[ -z $(dscl . -search /Users UniqueID "$ID" | awk 'NR==1{print $1}') ]] || { echo "uid $ID is taken; refusing" >&2; exit 1; }
  [[ -z $(dscl . -search /Groups PrimaryGroupID "$ID" | awk 'NR==1{print $1}') ]] || { echo "gid $ID is taken; refusing" >&2; exit 1; }
  dscl . -create "/Groups/$NAME"
  dscl . -create "/Groups/$NAME" PrimaryGroupID "$ID"
  dscl . -create "/Groups/$NAME" RealName "Foundry build worker"
  dscl . -create "/Users/$NAME"
  dscl . -create "/Users/$NAME" UniqueID "$ID"
  dscl . -create "/Users/$NAME" PrimaryGroupID "$ID"
  dscl . -create "/Users/$NAME" UserShell /usr/bin/false
  dscl . -create "/Users/$NAME" NFSHomeDirectory /var/empty
  dscl . -create "/Users/$NAME" RealName "Foundry build worker"
  dscl . -create "/Users/$NAME" IsHidden 1
  dscl . -create "/Users/$NAME" Password '*'
  echo "created $NAME uid/gid $ID"
fi
id "$NAME"
[[ $(id -u "$NAME") == "$ID" && $(id -g "$NAME") == "$ID" ]] || { echo "account check failed" >&2; exit 1; }

log "roots"
for d in input work journal cache; do
  install -d -o "$ID" -g "$ID" -m 0700 "$VM/$d"
done
# Ancestors must carry no group/other write bits; the attempts root stays root's.
for p in /Library /Library/Foundry "$VM" "$VM/attempts"; do
  m=$(stat -f '%OLp' "$p"); u=$(stat -f '%u' "$p")
  [[ $u == 0 && $((8#$m & 8#022)) -eq 0 ]] || { echo "$p uid $u mode $m violates the canonical path rule" >&2; exit 1; }
done
ls -la "$VM"

log "mailbox owner tool"
[[ -f $IO_SRC ]] || { echo "$IO_SRC missing" >&2; exit 1; }
[[ $(shasum -a 256 "$IO_SRC" | cut -c1-64) == "$IO_SHA" ]] || { echo "$IO_SRC does not hash to $IO_SHA" >&2; exit 1; }
/usr/bin/python3 -I -m py_compile "$IO_SRC" 2>/dev/null || { echo "$IO_SRC does not compile" >&2; exit 1; }
rm -rf "$(dirname "$IO_SRC")/__pycache__"
install -o root -g wheel -m 0555 "$IO_SRC" "$BIN/mac-vm-io.py"
shasum -a 256 "$BIN"/*
ls -la "$BIN"

log "done: account $NAME ($ID), roots $VM/{input,work,journal,cache} 0700, $BIN/mac-vm-io.py $IO_SHA"

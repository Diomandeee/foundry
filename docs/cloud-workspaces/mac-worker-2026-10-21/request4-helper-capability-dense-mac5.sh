#!/bin/bash
# Request 4 on Mac5: (A) install rebuilt mac-vm-host fe15211a (aux storage limit
# 16 -> 64 MiB), (B) seal capability 0f2a7673 that pins it, (C) dense master
# boot disk for image r2. Each part runs in its own subshell; all output streams
# to the operator listener on Mac1.
URL=http://100.84.118.106:9876
{
echo "== part A"
( # Root: replace the pinned Mac VM host helper with a reviewed rebuild.
# Template: fe15211ac995139dbf81334ccce58fcadedcea20cd3c45771eace24a67dd74f0 = sha256 of the signed binary staged at $SRC.
# Keeps the replaced binary under /Library/Foundry/retired/<sha>.mac-vm-host
# (root 0444) so the old capability's pin stays reproducible. Idempotent.
set -euo pipefail
SRC=/Volumes/FoundryBuild/staging/bin/mac-vm-host.v2
NEW_SHA='fe15211ac995139dbf81334ccce58fcadedcea20cd3c45771eace24a67dd74f0'
DST=/Library/Foundry/bin/mac-vm-host
RETIRED=/Library/Foundry/retired
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
echo "== $(date -u +%H:%M:%SZ) install mac-vm-host $NEW_SHA"
[[ $(shasum -a 256 "$SRC" | cut -c1-64) == "$NEW_SHA" ]] || { echo "$SRC does not hash to $NEW_SHA" >&2; exit 1; }
codesign --verify --strict "$SRC"
codesign -d --entitlements - "$SRC" 2>/dev/null | grep -q com.apple.security.virtualization || { echo "missing virtualization entitlement" >&2; exit 1; }
cur=$(shasum -a 256 "$DST" | cut -c1-64)
if [[ $cur != "$NEW_SHA" ]]; then
  install -d -o root -g wheel -m 0755 "$RETIRED"
  [[ -e $RETIRED/$cur.mac-vm-host ]] || install -o root -g wheel -m 0444 "$DST" "$RETIRED/$cur.mac-vm-host"
  install -o root -g wheel -m 0555 "$SRC" "$DST.new"
  mv -f "$DST.new" "$DST"
fi
[[ $(shasum -a 256 "$DST" | cut -c1-64) == "$NEW_SHA" ]] || { echo "install hash mismatch" >&2; exit 1; }
ls -la /Library/Foundry/bin "$RETIRED"
 ) && echo "PART A OK" || echo "!! PART A FAILED"
echo "== part B"
( # Seal one owner-accepted Mac VM capability record as a persistent
# kernel-read-only tree at /Library/Foundry/VM/capabilities/<sha256>.
#
# Template. Fill the two placeholders from capability-record.ts output
# (sha256 and the exact canonical JSON) and run the result as root, normally by
# staging it on fleet-authority:
#
#   sed -e "s|@CAP_SHA@|$sha|" -e "s|@CAP_JSON@|$canonical|" seal-capability.sh > seal-<sha>.sh
#   /usr/local/bin/fleet stage "<description>" --timeout 300 < seal-<sha>.sh    (on the host)
#
# Mechanism (what the runtime's seal demands, see build-storage FILESYSTEM-REVIEW):
# the tree must sit on a local volume mounted read-only BY ROOT whose mount point
# is an ancestor of (or equal to) the tree path. /Library/Foundry/VM is mounted
# read-write, so each sealed tree gets its own APFS volume in the same container
# (space-sharing, no copy): ownership enabled, populated during a short read-write
# window at a root-private mount point, unmounted, then mounted read-only at the
# tree path. An fstab "ro" line by volume UUID remounts it the same way at boot.
# The last step is the installed mac-tree-guard observing the tree exactly as the
# runtime will (read-only, local, root-mounted, root-owned entries, no ACLs); its
# identity frame is written next to the mount point as <sha>.seal.json (0644) so
# the unprivileged worker config can pin fsid/UUID/device/inode from it.
#
# Every step is appended to <sha>.seal.log (0644) next to the mount point, so the
# unprivileged operator can read what happened even when the run fails; the
# daemon's own stdout capture is root-only.
#
# Idempotent. Creates: one APFS volume, one fstab line (fstab backed up first),
# one mount point directory, one receipt file, one log file. Removes only
# Spotlight/Trash directories macOS may create on the brand-new volume during the
# read-write window; nothing that existed before this script is touched.
set -euo pipefail
CAP_SHA='0f2a7673987b731271bb43ddbee6fd1b9de3cb32e2c1a0beedfed13900b39d7c'
CAP_JSON='{"architecture":"arm64","backend":"apple-vz-macos-v1","bootSha256":"f07f050064ffde6e421bc2a200d21f6039a8ddebcca77b9236632ea0406e361e","developerDir":"/Applications/Xcode.app/Contents/Developer","guestRunnerSha256":"156bf694d52041801cc2bacdf71a3c6cfc2e1f7ee6b960423d82b18886fc34c8","macos":"27.0.1","sdks":["appletvos27.0","appletvsimulator27.0","driverkit27.0","iphoneos27.1","iphonesimulator27.1","macosx27.0","watchos27.0","watchsimulator27.0","xros27.0","xrsimulator27.0"],"treeGuardSha256":"703035a4fd974f1a3b9da67228ad8ef60d0a21847b679bda1d05f771e2a2b898","version":1,"vmHelperSha256":"fe15211ac995139dbf81334ccce58fcadedcea20cd3c45771eace24a67dd74f0","xcodeBuild":"27A9275"}'
VM=/Library/Foundry/VM
GUARD=/Library/Foundry/bin/mac-tree-guard
CAP_DIR=$VM/capabilities/$CAP_SHA
VOL=fcap-${CAP_SHA:0:12}
RECEIPT=$VM/capabilities/$CAP_SHA.seal.json
LOG=$VM/capabilities/$CAP_SHA.seal.log
TMP=/private/var/root/.seal-$CAP_SHA

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ -d $VM/capabilities ]] || { echo "$VM/capabilities missing" >&2; exit 1; }
: >> "$LOG"; chmod 0644 "$LOG"
exec > >(tee -a "$LOG") 2>&1
log() { echo "== $(date -u +%H:%M:%SZ) $*"; }
trap 'echo "!! FAILED line $LINENO: $BASH_COMMAND"' ERR
log "seal $CAP_SHA start"

[[ $CAP_SHA =~ ^[0-9a-f]{64}$ ]] || { echo "bad sha" >&2; exit 1; }
[[ $(printf '%s' "$CAP_JSON" | shasum -a 256 | cut -c1-64) == "$CAP_SHA" ]] || { echo "embedded record does not hash to $CAP_SHA" >&2; exit 1; }
mount | grep -q " on $VM (" || { echo "$VM is not mounted" >&2; exit 1; }
[[ -x $GUARD ]] || { echo "$GUARD missing" >&2; exit 1; }
container=$(diskutil info "$VM" | awk -F': *' '/APFS Container/ {print $2}')
[[ $container == disk* ]] || { echo "cannot find the APFS container of $VM" >&2; exit 1; }
log "container $container"

log "volume $VOL"
if ! diskutil list "$container" | grep -q "APFS Volume $VOL "; then
  diskutil apfs addVolume "$container" APFS "$VOL" -nomount
fi
dev=$(diskutil list "$container" | awk -v n="$VOL" '$0 ~ "APFS Volume "n" " {print $NF; exit}')
[[ $dev =~ ^disk[0-9]+s[0-9]+$ ]] || { echo "cannot resolve volume $VOL (got '$dev')" >&2; exit 1; }
uuid=$(diskutil info "$dev" | awk -F': *' '/Volume UUID/ {print $2}')
[[ $uuid =~ ^[0-9A-F-]{36}$ ]] || { echo "cannot resolve UUID of $dev (got '$uuid')" >&2; exit 1; }
log "$VOL = /dev/$dev uuid $uuid"

mounted_at() { mount | awk -v d="/dev/$1" '$1 == d {print $3; exit}'; }

if [[ $(mounted_at "$dev") != "$CAP_DIR" ]]; then
  cur=$(mounted_at "$dev")
  if [[ -n $cur ]]; then log "unmounting stray mount at $cur"; diskutil unmount "$dev"; fi
  install -d -o root -g wheel -m 0700 "$TMP"

  # Ownership is a per-volume setting in /var/db/volinfo.database and diskutil
  # only accepts it for a MOUNTED volume (a bare device fails). Mount, enable,
  # remount so the read-write window already honours uid/gid. The setting is
  # only reported for a mounted volume too (an unmounted device always shows
  # "Owners: Disabled"), so it is verified on the mount point, never the device.
  log "enable ownership"
  diskutil mount nobrowse -mountPoint "$TMP" "$dev"
  diskutil enableOwnership "$TMP"
  diskutil unmount "$TMP"

  log "populate (read-write window at $TMP)"
  diskutil mount nobrowse -mountPoint "$TMP" "$dev"
  diskutil info "$TMP" | grep -q "Owners: *Enabled" || { echo "ownership not honoured on $TMP" >&2; exit 1; }
  mount | grep "^/dev/$dev on $TMP (" | grep -q noowners && { echo "$TMP mounted with noowners" >&2; exit 1; }
  mdutil -i off "$TMP" >/dev/null 2>&1 || true
  chown root:wheel "$TMP"; chmod 0755 "$TMP"
  if [[ -e $TMP/capability.json ]]; then
    [[ $(shasum -a 256 "$TMP/capability.json" | cut -c1-64) == "$CAP_SHA" ]] || { echo "existing capability.json differs; refusing" >&2; exit 1; }
  else
    printf '%s' "$CAP_JSON" > "$TMP/capability.json"
  fi
  chown root:wheel "$TMP/capability.json"; chmod 0444 "$TMP/capability.json"
  install -d -o root -g wheel -m 0755 "$TMP/.fseventsd"
  [[ -e $TMP/.fseventsd/no_log ]] || : > "$TMP/.fseventsd/no_log"
  chown root:wheel "$TMP/.fseventsd/no_log"; chmod 0444 "$TMP/.fseventsd/no_log"
  for junk in .Spotlight-V100 .Trashes .TemporaryItems .DS_Store; do
    [[ -e $TMP/$junk ]] && { log "removing $junk from the new volume"; rm -rf "${TMP:?}/$junk"; }
  done
  ls -la "$TMP"
  sync
  diskutil unmount "$TMP"
  rmdir "$TMP"

  log "mount read-only at $CAP_DIR"
  install -d -o root -g wheel -m 0755 "$CAP_DIR"
  if ! grep -q "$uuid" /etc/fstab 2>/dev/null; then
    [[ -f /etc/fstab ]] && cp -p /etc/fstab "/etc/fstab.pre-seal-$(date +%Y%m%d%H%M%S)"
    echo "UUID=$uuid $CAP_DIR apfs ro" >> /etc/fstab
  fi
  diskutil mount readOnly nobrowse -mountPoint "$CAP_DIR" "$dev"
fi

log "verify"
mount | grep "^/dev/$dev on $CAP_DIR (" | grep -q 'read-only' || { echo "$CAP_DIR is not a read-only mount" >&2; exit 1; }
mount | grep "^/dev/$dev on $CAP_DIR (" | grep -q noowners && { echo "$CAP_DIR mounted with noowners" >&2; exit 1; }
diskutil info "$CAP_DIR" | grep -q "Owners: *Enabled" || { echo "ownership not honoured on $CAP_DIR" >&2; exit 1; }
[[ $(shasum -a 256 "$CAP_DIR/capability.json" | cut -c1-64) == "$CAP_SHA" ]] || { echo "mounted capability.json hash mismatch" >&2; exit 1; }
guard_sha=$(shasum -a 256 "$GUARD" | cut -c1-64)
frame=$("$GUARD" --describe-readonly-v1 "$GUARD" "$CAP_DIR" "$CAP_DIR")
echo "$frame"
printf '{"capabilitySha256":"%s","volume":"%s","device":"/dev/%s","volumeUuid":"%s","fstab":"UUID=%s %s apfs ro","guard":{"path":"%s","sha256":"%s"},"observed":%s}\n' \
  "$CAP_SHA" "$VOL" "$dev" "$uuid" "$uuid" "$CAP_DIR" "$GUARD" "$guard_sha" "$frame" > "$RECEIPT"
chown root:wheel "$RECEIPT"; chmod 0644 "$RECEIPT"
ls -la "$CAP_DIR"
mount | grep "$CAP_DIR"
log "sealed: $CAP_DIR" ) && echo "PART B OK" || echo "!! PART B FAILED"
echo "== part C"
( # Root, one-time per image: write a FULLY ALLOCATED copy of a master boot.raw.
# mac-vm-host refuses sparse boot disks (lseek SEEK_HOLE must equal size and
# st_blocks must cover size), and Tart/VZ images are sparse. An APFS clone of a
# dense file is dense, so per-attempt boot disks stay instant clones of this one.
# Template: macos-27.0.1-xcode-27.1-r2 = image directory name under /Library/Foundry/VM/images,
# f07f050064ffde6e421bc2a200d21f6039a8ddebcca77b9236632ea0406e361e = its boot.raw sha256 (verified while copying, every byte written).
set -euo pipefail
IMAGE='macos-27.0.1-xcode-27.1-r2'
BOOT_SHA='f07f050064ffde6e421bc2a200d21f6039a8ddebcca77b9236632ea0406e361e'
SRC=/Library/Foundry/VM/images/$IMAGE/boot.raw
DIR=/Library/Foundry/VM/images/$IMAGE-dense
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
echo "== $(date -u +%H:%M:%SZ) dense master for $IMAGE"
if [[ -f $DIR/boot.raw ]]; then echo "$DIR/boot.raw already present"; else
  install -d -o root -g wheel -m 0755 "$DIR"
  /usr/bin/python3 -I - "$SRC" "$DIR/boot.raw.partial" "$BOOT_SHA" <<'PY'
import hashlib, os, sys
src, dst, want = sys.argv[1:4]
CH = 8 * 1024 * 1024
i = os.open(src, os.O_RDONLY | os.O_NOFOLLOW)
o = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
h = hashlib.sha256(); n = 0
size = os.fstat(i).st_size
while True:
    b = os.read(i, CH)
    if not b: break
    h.update(b)
    mv = memoryview(b)
    while mv:
        w = os.write(o, mv); mv = mv[w:]
    n += len(b)
    if n % (10 * 1024**3) < CH: print(f"  {n // 1024**3} GiB", flush=True)
os.fsync(o); os.close(o); os.close(i)
assert n == size, "short copy"
assert h.hexdigest() == want, f"hash {h.hexdigest()} != {want}"
print("copied", n, "bytes, sha256", h.hexdigest(), flush=True)
PY
  chown root:wheel "$DIR/boot.raw.partial"; chmod 0444 "$DIR/boot.raw.partial"
  mv "$DIR/boot.raw.partial" "$DIR/boot.raw"
fi
/usr/bin/python3 -I -c "
import os,sys
fd=os.open('$DIR/boot.raw',os.O_RDONLY);s=os.fstat(fd)
hole=os.lseek(fd,0,os.SEEK_HOLE)
print('size',s.st_size,'blocks',s.st_blocks,'hole_at',hole)
assert hole==s.st_size and s.st_blocks*512>=s.st_size, 'still sparse'
print('dense ok')"
ls -la "$DIR"
 ) && echo "PART C OK" || echo "!! PART C FAILED"
} 2>&1 | curl -s -m 3500 -X POST --data-binary @- "$URL/request4" >/dev/null 2>&1

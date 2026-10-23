#!/bin/bash
# Diagnostic + seal attempt 3. Part 1 posts the execution environment and the
# daemon's captured output of the two earlier seal attempts to the operator's
# listener on Mac1 (read-only apart from two probe files created and removed).
# Part 2 runs the v2 seal script with its output streamed to the same listener.
URL=http://100.84.118.106:9876
{
echo "== date"; date -u
echo "== id"; id
echo "== euid=$EUID bash=$BASH_VERSION pwd=$(pwd)"
echo "== env"; env
echo "== dirs"; ls -ld /Library/Foundry/VM /Library/Foundry/VM/capabilities /private/var/root
echo "== write probes"
touch /Library/Foundry/VM/capabilities/.probe-diag && echo cap-write-ok; rm -f /Library/Foundry/VM/capabilities/.probe-diag
touch /private/var/root/.probe-diag && echo root-home-write-ok; rm -f /private/var/root/.probe-diag
echo "== log dir"; ls -la /Library/FleetAuthority/log/
for id in 0f5554f2842718f5 c1273ccdc7602511 5ced1e824a326d7e; do
  echo "== output of $id"; cat /Library/FleetAuthority/log/$id* 2>&1 | tail -c 4000
done
echo "== receipts mentioning the seal attempts"; grep -E "0f5554f2842718f5|c1273ccdc7602511" /Library/FleetAuthority/log/receipts.jsonl 2>&1 | tail -c 6000
echo "== daemon.err tail"; tail -c 2000 /Library/FleetAuthority/log/daemon.err 2>&1
echo "== volume"; diskutil info disk9s3 | grep -E "Owners|Mounted|Volume UUID"
} 2>&1 | curl -s -m 20 -X POST --data-binary @- "$URL/diag" >/dev/null 2>&1

{
# Seal one owner-accepted Mac VM capability record as a persistent
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
CAP_SHA='d77f046a4cbb0c5adb7e7336bafaedaf3d8dbd759c8ff099f4e183c665a65fd3'
CAP_JSON='{"architecture":"arm64","backend":"apple-vz-macos-v1","bootSha256":"f07f050064ffde6e421bc2a200d21f6039a8ddebcca77b9236632ea0406e361e","developerDir":"/Applications/Xcode.app/Contents/Developer","guestRunnerSha256":"156bf694d52041801cc2bacdf71a3c6cfc2e1f7ee6b960423d82b18886fc34c8","macos":"27.0.1","sdks":["appletvos27.0","appletvsimulator27.0","driverkit27.0","iphoneos27.1","iphonesimulator27.1","macosx27.0","watchos27.0","watchsimulator27.0","xros27.0","xrsimulator27.0"],"treeGuardSha256":"703035a4fd974f1a3b9da67228ad8ef60d0a21847b679bda1d05f771e2a2b898","version":1,"vmHelperSha256":"d202f27517dbcb2f7a17bed0ee3b28717266411291244968c68257efc1598e4b","xcodeBuild":"27A9275"}'
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
log "sealed: $CAP_DIR"
} 2>&1 | curl -s -m 60 -X POST --data-binary @- "$URL/seal" >/dev/null 2>&1

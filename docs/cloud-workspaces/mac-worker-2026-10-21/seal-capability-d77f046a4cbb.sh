#!/bin/bash
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
# Idempotent. Creates: one APFS volume, one fstab line (fstab backed up first),
# one mount point directory, one receipt file. Removes only Spotlight/Trash
# directories macOS may create on the brand-new volume during the read-write
# window; nothing that existed before this script is touched.
set -euo pipefail
CAP_SHA='d77f046a4cbb0c5adb7e7336bafaedaf3d8dbd759c8ff099f4e183c665a65fd3'
CAP_JSON='{"architecture":"arm64","backend":"apple-vz-macos-v1","bootSha256":"f07f050064ffde6e421bc2a200d21f6039a8ddebcca77b9236632ea0406e361e","developerDir":"/Applications/Xcode.app/Contents/Developer","guestRunnerSha256":"156bf694d52041801cc2bacdf71a3c6cfc2e1f7ee6b960423d82b18886fc34c8","macos":"27.0.1","sdks":["appletvos27.0","appletvsimulator27.0","driverkit27.0","iphoneos27.1","iphonesimulator27.1","macosx27.0","watchos27.0","watchsimulator27.0","xros27.0","xrsimulator27.0"],"treeGuardSha256":"703035a4fd974f1a3b9da67228ad8ef60d0a21847b679bda1d05f771e2a2b898","version":1,"vmHelperSha256":"d202f27517dbcb2f7a17bed0ee3b28717266411291244968c68257efc1598e4b","xcodeBuild":"27A9275"}'
VM=/Library/Foundry/VM
GUARD=/Library/Foundry/bin/mac-tree-guard
CAP_DIR=$VM/capabilities/$CAP_SHA
VOL=fcap-${CAP_SHA:0:12}
RECEIPT=$VM/capabilities/$CAP_SHA.seal.json
TMP=/private/var/root/.seal-$CAP_SHA
log() { echo "== $*"; }

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ $CAP_SHA =~ ^[0-9a-f]{64}$ ]] || { echo "bad sha" >&2; exit 1; }
[[ $(printf '%s' "$CAP_JSON" | shasum -a 256 | cut -c1-64) == "$CAP_SHA" ]] || { echo "embedded record does not hash to $CAP_SHA" >&2; exit 1; }
mount | grep -q " on $VM (" || { echo "$VM is not mounted" >&2; exit 1; }
[[ -x $GUARD ]] || { echo "$GUARD missing" >&2; exit 1; }
container=$(diskutil info "$VM" | awk -F': *' '/APFS Container/ {print $2}')
[[ $container == disk* ]] || { echo "cannot find the APFS container of $VM" >&2; exit 1; }

log "volume"
if ! diskutil apfs list "$container" | grep -q "Name: *$VOL "; then
  diskutil apfs addVolume "$container" APFS "$VOL" -nomount >/dev/null
fi
dev=$(diskutil apfs list "$container" | awk -v n="$VOL" '
  /APFS Volume Disk/ { for (i = 1; i <= NF; i++) if ($i ~ /^disk[0-9]+s[0-9]+$/) d = $i }
  $0 ~ "Name: *"n" " { print d; exit }')
uuid=$(diskutil info "$dev" | awk -F': *' '/Volume UUID/ {print $2}')
[[ $dev == disk* && -n $uuid ]] || { echo "cannot resolve volume $VOL" >&2; exit 1; }
diskutil enableOwnership "$dev" >/dev/null
echo "$VOL = /dev/$dev uuid $uuid"

if ! mount | grep -q "^/dev/$dev on $CAP_DIR ("; then
  log "populate (read-write window at $TMP)"
  if mount | grep -q "^/dev/$dev on "; then diskutil unmount "$dev" >/dev/null; fi
  install -d -o root -g wheel -m 0700 "$TMP"
  diskutil mount nobrowse -mountPoint "$TMP" "$dev" >/dev/null
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
    [[ -e $TMP/$junk ]] && rm -rf "${TMP:?}/$junk"
  done
  sync
  diskutil unmount "$TMP" >/dev/null
  rmdir "$TMP"

  log "mount read-only at $CAP_DIR"
  install -d -o root -g wheel -m 0755 "$CAP_DIR"
  if ! grep -q "$uuid" /etc/fstab 2>/dev/null; then
    [[ -f /etc/fstab ]] && cp -p /etc/fstab "/etc/fstab.pre-seal-$(date +%Y%m%d%H%M%S)"
    echo "UUID=$uuid $CAP_DIR apfs ro" >> /etc/fstab
  fi
  diskutil mount readOnly -mountPoint "$CAP_DIR" "$dev" >/dev/null
fi

log "verify"
mount | grep "^/dev/$dev on $CAP_DIR (" | grep -q 'read-only' || { echo "$CAP_DIR is not a read-only mount" >&2; exit 1; }
[[ $(shasum -a 256 "$CAP_DIR/capability.json" | cut -c1-64) == "$CAP_SHA" ]] || { echo "mounted capability.json hash mismatch" >&2; exit 1; }
guard_sha=$(shasum -a 256 "$GUARD" | cut -c1-64)
frame=$("$GUARD" --describe-readonly-v1 "$GUARD" "$CAP_DIR" "$CAP_DIR")
echo "$frame"
printf '{"capabilitySha256":"%s","volume":"%s","device":"/dev/%s","volumeUuid":"%s","fstab":"UUID=%s %s apfs ro","guard":{"path":"%s","sha256":"%s"},"observed":%s}\n' \
  "$CAP_SHA" "$VOL" "$dev" "$uuid" "$uuid" "$CAP_DIR" "$GUARD" "$guard_sha" "$frame" > "$RECEIPT"
chown root:wheel "$RECEIPT"; chmod 0644 "$RECEIPT"
ls -la "$CAP_DIR"
mount | grep "$CAP_DIR"
echo "sealed: $CAP_DIR"

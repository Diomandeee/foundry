#!/bin/bash
# Root request: seal one owner-reviewed project source tree for the Mac VM
# worker as a persistent kernel-read-only tree under /Library/Foundry/VM/sources/.
#
# Template. Placeholders (substitute the assignment lines only):
#   @NAME@    directory name under sources/ (free-form; the worker config binds
#             the published snapshotHash to this tree, the name is not checked)
#   @SRC@     staged copy of the files on this host, readable by root
#   @DIGEST@  sha256 of the FILES text below (binds the request to exact content)
#   @FILES@   one "relative/path sha256 sizeBytes [mode]" line per regular file
#             (mode 644 or 755, octal; recorded for the job, the sealed copy is 0444)
#
# Layout: the APFS volume fsrc-<digest12> is mounted read-only BY ROOT at
#   /Library/Foundry/VM/sources/<NAME>            (mount point)
# and the tree the runtime verifies is
#   /Library/Foundry/VM/sources/<NAME>/tree/...   (root-owned 0555 dirs, 0444 files)
# The tree sits one level below the mount point on purpose: verifyMacVmInput walks
# the WHOLE tree and refuses undeclared directories, and macOS keeps .fseventsd at
# every volume root. mac-vm-staging only requires the tree path to start with
# /Library/Foundry/VM/sources/ and the seal to pin mountPoint as an ancestor.
#
# Same mechanism as seal-capability.sh (ownership on the mounted volume, populate
# in a root-private read-write window, fstab "ro" line, mac-tree-guard frame,
# receipt + operator-readable log). Idempotent. Creates one volume, one fstab
# line, one mount point, one receipt, one log. Copies ONLY the listed files and
# refuses on any hash/size mismatch. Deletes nothing that existed before.
set -euo pipefail
NAME='coltivare-f3855fb-2fb05b2f5804'
SRC='/Volumes/FoundryBuild/staging/sources/coltivare'
CONTENT_DIGEST='2fb05b2f58043fd234781ca41cc72f4324ff5c2d697caa73357deeed9620f355'
# File list kept beside the script on the host; CONTENT_DIGEST pins its exact bytes.
FILES=$(cat /Users/mohameddiomande/.foundry-obs/coltivare.files)
VM=/Library/Foundry/VM
GUARD=/Library/Foundry/bin/mac-tree-guard
MOUNT=$VM/sources/$NAME
TREE=$MOUNT/tree
VOL=fsrc-${CONTENT_DIGEST:0:12}
RECEIPT=$VM/sources/$NAME.seal.json
LOG=$VM/sources/$NAME.seal.log
TMP=/private/var/root/.seal-src-$NAME
URL=http://100.84.118.106:9876

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ -d $VM/sources ]] || { echo "$VM/sources missing" >&2; exit 1; }
: >> "$LOG"; chmod 0644 "$LOG"
exec > >(tee -a "$LOG" | curl -s --connect-timeout 5 -m 60 -X POST --data-binary @- "$URL/source-seal" >/dev/null 2>&1) 2>&1
log() { echo "== $(date -u +%H:%M:%SZ) $*"; }
trap 'echo "!! FAILED line $LINENO: $BASH_COMMAND"' ERR
log "seal source tree $NAME start"

[[ $NAME =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || { echo "bad name" >&2; exit 1; }
[[ $CONTENT_DIGEST =~ ^[0-9a-f]{64}$ ]] || { echo "bad digest" >&2; exit 1; }
[[ $(printf '%s\n' "$FILES" | shasum -a 256 | cut -c1-64) == "$CONTENT_DIGEST" ]] || { echo "FILES text does not hash to $CONTENT_DIGEST" >&2; exit 1; }
[[ -d $SRC ]] || { echo "$SRC missing" >&2; exit 1; }
[[ -x $GUARD ]] || { echo "$GUARD missing" >&2; exit 1; }
mount | grep -q " on $VM (" || { echo "$VM is not mounted" >&2; exit 1; }
container=$(diskutil info "$VM" | awk -F': *' '/APFS Container/ {print $2}')
[[ $container == disk* ]] || { echo "cannot find the APFS container of $VM" >&2; exit 1; }
count=$(printf '%s\n' "$FILES" | grep -c .)
log "container $container, $count files, content digest $CONTENT_DIGEST"

# Source check before touching anything: every listed file exists with the exact bytes.
while read -r path sha size mode; do
  [[ -n $path ]] || continue
  [[ $path != /* && $path != *..* && $sha =~ ^[0-9a-f]{64}$ && $size =~ ^[0-9]+$ && ${mode:-644} =~ ^(644|755)$ ]] || { echo "bad FILES line: $path" >&2; exit 1; }
  [[ -f $SRC/$path && ! -L $SRC/$path ]] || { echo "missing or not a regular file: $SRC/$path" >&2; exit 1; }
  [[ $(stat -f %z "$SRC/$path") == "$size" && $(shasum -a 256 "$SRC/$path" | cut -c1-64) == "$sha" ]] || { echo "content mismatch: $path" >&2; exit 1; }
done <<< "$FILES"
log "source verified at $SRC"

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

if [[ $(mounted_at "$dev") != "$MOUNT" ]]; then
  cur=$(mounted_at "$dev")
  if [[ -n $cur ]]; then log "unmounting stray mount at $cur"; diskutil unmount "$dev"; fi
  install -d -o root -g wheel -m 0700 "$TMP"

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
  install -d -o root -g wheel -m 0755 "$TMP/.fseventsd"
  [[ -e $TMP/.fseventsd/no_log ]] || : > "$TMP/.fseventsd/no_log"
  chown root:wheel "$TMP/.fseventsd/no_log"; chmod 0444 "$TMP/.fseventsd/no_log"
  for junk in .Spotlight-V100 .Trashes .TemporaryItems .DS_Store; do
    [[ -e $TMP/$junk ]] && { log "removing $junk from the new volume"; rm -rf "${TMP:?}/$junk"; }
  done
  if [[ -e $TMP/tree ]]; then
    log "tree already present; verifying it instead of rewriting"
  else
    install -d -o root -g wheel -m 0755 "$TMP/tree"
    while read -r path sha size mode; do
      [[ -n $path ]] || continue
      install -d -o root -g wheel -m 0755 "$TMP/tree/$(dirname "$path")"
      install -o root -g wheel -m 0444 "$SRC/$path" "$TMP/tree/$path"
    done <<< "$FILES"
    # Directories read-only last, deepest first.
    find "$TMP/tree" -type d -depth -exec chmod 0555 {} \;
  fi
  sync
  diskutil unmount "$TMP"
  rmdir "$TMP"

  log "mount read-only at $MOUNT"
  install -d -o root -g wheel -m 0755 "$MOUNT"
  if ! grep -q "$uuid" /etc/fstab 2>/dev/null; then
    [[ -f /etc/fstab ]] && cp -p /etc/fstab "/etc/fstab.pre-seal-$(date +%Y%m%d%H%M%S)"
    echo "UUID=$uuid $MOUNT apfs ro" >> /etc/fstab
  fi
  diskutil mount readOnly nobrowse -mountPoint "$MOUNT" "$dev"
fi

log "verify"
mount | grep "^/dev/$dev on $MOUNT (" | grep -q 'read-only' || { echo "$MOUNT is not a read-only mount" >&2; exit 1; }
mount | grep "^/dev/$dev on $MOUNT (" | grep -q noowners && { echo "$MOUNT mounted with noowners" >&2; exit 1; }
diskutil info "$MOUNT" | grep -q "Owners: *Enabled" || { echo "ownership not honoured on $MOUNT" >&2; exit 1; }
[[ -d $TREE ]] || { echo "$TREE missing" >&2; exit 1; }
# Exact file set, exact bytes, root-owned 0444 files and 0555 directories, nothing else.
actual=$(cd "$TREE" && find . -type f | sed 's|^\./||' | sort)
expected=$(printf '%s\n' "$FILES" | awk '{print $1}' | sort)
[[ $actual == "$expected" ]] || { echo "file set differs from FILES" >&2; diff <(echo "$expected") <(echo "$actual") || true; exit 1; }
[[ -z $(find "$TREE" -not -type f -not -type d) ]] || { echo "non-regular entry in tree" >&2; exit 1; }
[[ -z $(find "$TREE" -type d \( -not -user root -o -not -perm 0555 \)) ]] || { echo "directory owner/mode violation" >&2; exit 1; }
[[ -z $(find "$TREE" -type f \( -not -user root -o -not -perm 0444 -o -links +1 \)) ]] || { echo "file owner/mode/link violation" >&2; exit 1; }
while read -r path sha size mode; do
  [[ -n $path ]] || continue
  [[ $(stat -f %z "$TREE/$path") == "$size" && $(shasum -a 256 "$TREE/$path" | cut -c1-64) == "$sha" ]] || { echo "sealed content mismatch: $path" >&2; exit 1; }
done <<< "$FILES"
guard_sha=$(shasum -a 256 "$GUARD" | cut -c1-64)
frame=$("$GUARD" --describe-readonly-v1 "$GUARD" "$TREE" "$MOUNT")
echo "$frame"
files_json=$(printf '%s\n' "$FILES" | awk 'BEGIN{printf "["} NF>=3{if(n++)printf ","; m=(NF>=4)?$4:"644"; printf "{\"path\":\"%s\",\"sha256\":\"%s\",\"sizeBytes\":%s,\"mode\":%d}",$1,$2,$3,(m=="755")?493:420} END{printf "]"}')
printf '{"name":"%s","contentDigest":"%s","files":%s,"volume":"%s","device":"/dev/%s","volumeUuid":"%s","fstab":"UUID=%s %s apfs ro","guard":{"path":"%s","sha256":"%s"},"observed":%s}\n' \
  "$NAME" "$CONTENT_DIGEST" "$files_json" "$VOL" "$dev" "$uuid" "$uuid" "$MOUNT" "$GUARD" "$guard_sha" "$frame" > "$RECEIPT"
chown root:wheel "$RECEIPT"; chmod 0644 "$RECEIPT"
find "$TREE" | sort
mount | grep "$MOUNT"
log "sealed: $TREE ($count files, digest $CONTENT_DIGEST)"

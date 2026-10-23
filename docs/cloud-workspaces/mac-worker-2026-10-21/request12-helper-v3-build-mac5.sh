#!/bin/bash
# Request 12 on Mac5: (A) install helper 10af1eb5 (hands its disk locks to
# Virtualization.framework before start and verifies VZ holds them; exits on a
# VM error state instead of observing forever), (B) install mac-vm-io.py 9d9a28c8
# (parses hdiutil's plist despite deprecation warnings), (C) seal capability 60eb7360
# pinning the new helper, (D) the build: attempt proof-r2-20261021d.
# Old binaries kept in /Library/Foundry/retired. Deletes nothing.
LOG=/Library/Foundry/VM/proof-logs/request12.log; : > "$LOG"; chmod 0644 "$LOG"
exec > >(tee -a "$LOG") 2>&1
export SRC=/Volumes/FoundryBuild/staging/bin/mac-vm-host.v3
echo "== part A helper"; ( # Root: replace the pinned Mac VM host helper with a reviewed rebuild.
# Template: 10af1eb5d20b792eaa216c680e69e55814e876bbd885d849855fea7b1a0778a2 = sha256 of the signed binary staged at $SRC.
# Keeps the replaced binary under /Library/Foundry/retired/<sha>.mac-vm-host
# (root 0444) so the old capability's pin stays reproducible. Idempotent.
set -euo pipefail
SRC=${SRC:-/Volumes/FoundryBuild/staging/bin/mac-vm-host.v2}
NEW_SHA='10af1eb5d20b792eaa216c680e69e55814e876bbd885d849855fea7b1a0778a2'
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
 ) && echo "PART A OK" || { echo "!! PART A FAILED"; exit 1; }
echo "== part B io tool"; ( set -euo pipefail
SRC=/Users/mohameddiomande/.foundry-obs/mac-vm-io.v2.py; DST=/Library/Foundry/bin/mac-vm-io.py; NEW='9d9a28c8ca76c1fd93ba8e024394038842df4c899b95812386d9c7fe48fb66c3'
[[ $(shasum -a 256 "$SRC" | cut -c1-64) == "$NEW" ]] || { echo "io source hash mismatch"; exit 1; }
cur=$(shasum -a 256 "$DST" | cut -c1-64)
if [[ $cur != "$NEW" ]]; then install -d -o root -g wheel -m 0755 /Library/Foundry/retired
  [[ -e /Library/Foundry/retired/$cur.mac-vm-io.py ]] || install -o root -g wheel -m 0444 "$DST" "/Library/Foundry/retired/$cur.mac-vm-io.py"
  install -o root -g wheel -m 0555 "$SRC" "$DST.new"; mv -f "$DST.new" "$DST"; fi
shasum -a 256 "$DST" ) && echo "PART B OK" || { echo "!! PART B FAILED"; exit 1; }
echo "== part C capability"; ( # Seal one owner-accepted Mac VM capability record as a persistent
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
CAP_SHA='60eb73607f3c9cff84ea2af41097fc04f6f04c77d0008ba1ba6c42b772a3ed74'
CAP_JSON='{"architecture":"arm64","backend":"apple-vz-macos-v1","bootSha256":"f07f050064ffde6e421bc2a200d21f6039a8ddebcca77b9236632ea0406e361e","developerDir":"/Applications/Xcode.app/Contents/Developer","guestRunnerSha256":"156bf694d52041801cc2bacdf71a3c6cfc2e1f7ee6b960423d82b18886fc34c8","macos":"27.0.1","sdks":["appletvos27.0","appletvsimulator27.0","driverkit27.0","iphoneos27.1","iphonesimulator27.1","macosx27.0","watchos27.0","watchsimulator27.0","xros27.0","xrsimulator27.0"],"treeGuardSha256":"703035a4fd974f1a3b9da67228ad8ef60d0a21847b679bda1d05f771e2a2b898","version":1,"vmHelperSha256":"10af1eb5d20b792eaa216c680e69e55814e876bbd885d849855fea7b1a0778a2","xcodeBuild":"27A9275"}'
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
log "sealed: $CAP_DIR" ) && echo "PART C OK" || { echo "!! PART C FAILED"; exit 1; }
echo "== part D build"
export LAUNCH="launchctl asuser 520 sudo -u foundrybuild -g foundrybuild -H"
( # Root request: direct mac-vm-host proof on a Mac build worker host, without the
# controller or the compute authority. Exercises every real host component in
# the order the MacVmAdapter uses them:
#   1. attempt directory under /Library/Foundry/VM/attempts/<id> (root 0755),
#      boot.raw = APFS clone of the dense master (helper uid, 0600),
#      auxiliary.bin copy (helper uid, 0600), hardware-model/machine-identifier
#      (root 0444), outputs.raw = fully allocated 1 GiB GPT/APFS "FoundryOutputs"
#      with a root 0700 volume root (what the guest runner demands);
#   2. root I/O tool `mac-vm-io.py stage`: job.json + source copied from the
#      sealed source tree into a read-only image mounted at <attempt>/input;
#   3. the pinned helper run AS THE BUILD ACCOUNT, driven over its stdin/stdout
#      challenge/permit protocol by a small driver (the role mac-vm.ts plays);
#   4. `mac-vm-io.py intake`: root copy of the stopped outputs.raw, read-only
#      mount, result envelope check; result.json + build.log tail reported.
# The job is labelled a proof: profileHash is the sha256 of a fixed proof label,
# not a server profile, and sourceHash is the sealed tree's content digest
# because no published snapshot exists yet.
#
# Leaves the attempt directory, its mounts and evidence in place (cleanup is a
# separate gate). Deletes nothing. Refuses if the attempt id already exists.
set -euo pipefail
ATT='proof-r2-20261021d'
# The build account must have a GUI login session (VZ refuses sessionless users);
# launchctl asuser joins that session, sudo then drops to the account.
LAUNCH=${LAUNCH:-launchctl asuser 520 sudo -u foundrybuild -g foundrybuild -H}
DENSE=/Library/Foundry/VM/images/macos-27.0.1-xcode-27.1-r2-dense/boot.raw
IMG=/Library/Foundry/VM/images/macos-27.0.1-xcode-27.1-r2
BOOT_SHA=f07f050064ffde6e421bc2a200d21f6039a8ddebcca77b9236632ea0406e361e
CAP_SHA=60eb73607f3c9cff84ea2af41097fc04f6f04c77d0008ba1ba6c42b772a3ed74
RUNNER_SHA=156bf694d52041801cc2bacdf71a3c6cfc2e1f7ee6b960423d82b18886fc34c8
SRC_NAME=xcode-agent-test-a14e9efb379d
SRC_DIGEST=a14e9efb379d9faa23a32f880e46d89f132a0b6f3f82c022b6dc1d673f7225b5
HELPER=/Library/Foundry/bin/mac-vm-host
GUARD=/Library/Foundry/bin/mac-tree-guard
IO=/Library/Foundry/bin/mac-vm-io.py
UID_B=520
# Xcode's python directly: the /usr/bin/python3 shim consults the caller's HOME,
# and the build account's home is /var/empty.
PYX=/Applications/Xcode.app/Contents/Developer/usr/bin/python3
VM=/Library/Foundry/VM
BASE=$VM/attempts/$ATT
PRIV=/private/var/root/.foundry-proof-$ATT
log() { echo "== $(date -u +%H:%M:%SZ) $*"; }
# mac-vm-io.py hides every error behind "refused"; run its main() with the
# traceback visible. Same file, same pinned path, same root; diagnostic only.
io_run() { /usr/bin/python3 -I -c 'import runpy,sys,traceback
sys.argv=[sys.argv[1],sys.argv[2]]
m=runpy.run_path(sys.argv[0],run_name="mac_vm_io")
try: m["main"]()
except BaseException: traceback.print_exc(); sys.exit(1)' "$IO" "$1"; }
trap 'echo "!! FAILED line $LINENO: $BASH_COMMAND"' ERR
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ $ATT =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || { echo "bad attempt id" >&2; exit 1; }
[[ ! -e $BASE ]] || { echo "$BASE already exists; refusing to reuse an attempt" >&2; exit 1; }
[[ -f $DENSE && -x $HELPER && -x $GUARD && -f $IO ]] || { echo "missing dense master, helper, guard or io tool" >&2; exit 1; }
[[ $(id -u foundrybuild) == "$UID_B" ]] || { echo "build account missing" >&2; exit 1; }
log "proof $ATT start; helper $(shasum -a 256 $HELPER | cut -c1-64)"

log "1. attempt directory"
install -d -o root -g wheel -m 0755 "$BASE" "$BASE/receipts"
cp -c "$DENSE" "$BASE/boot.raw"
chown $UID_B:$UID_B "$BASE/boot.raw"; chmod 0600 "$BASE/boot.raw"
cp "$IMG/auxiliary.bin" "$BASE/auxiliary.bin"
chown $UID_B:$UID_B "$BASE/auxiliary.bin"; chmod 0600 "$BASE/auxiliary.bin"
for f in hardware-model.bin machine-identifier.bin; do
  cp "$IMG/$f" "$BASE/$f"; chown root:wheel "$BASE/$f"; chmod 0444 "$BASE/$f"
done
mkfile 1g "$BASE/outputs.raw"
dev=$(hdiutil attach -nomount -imagekey diskimage-class=CRawDiskImage "$BASE/outputs.raw" | awk 'NR==1{print $1}')
[[ $dev == /dev/disk* ]] || { echo "could not attach outputs.raw" >&2; exit 1; }
diskutil partitionDisk "$dev" GPT APFS FoundryOutputs 100% >/dev/null
omnt=$(mount | awk '$3 ~ "^/Volumes/FoundryOutputs" {print $3; exit}')
[[ -n $omnt ]] || { echo "FoundryOutputs did not mount for preparation" >&2; exit 1; }
chown root:wheel "$omnt"; chmod 0700 "$omnt"
mdutil -i off "$omnt" >/dev/null 2>&1 || true
rm -rf "${omnt:?}/.Spotlight-V100" "${omnt:?}/.Trashes" 2>/dev/null || true
hdiutil detach "$dev" >/dev/null
chown $UID_B:$UID_B "$BASE/outputs.raw"; chmod 0600 "$BASE/outputs.raw"
/usr/bin/python3 -I - "$BASE" <<'PY'
import os, sys
for name in ('boot.raw', 'outputs.raw'):
    fd = os.open(os.path.join(sys.argv[1], name), os.O_RDONLY); s = os.fstat(fd)
    hole = os.lseek(fd, 0, os.SEEK_HOLE); os.close(fd)
    print(name, 'size', s.st_size, 'blocks', s.st_blocks, 'hole_at', hole)
    assert hole == s.st_size and s.st_blocks * 512 >= s.st_size, name + ' is sparse'
PY
ls -la "$BASE"

log "2. stage input from the sealed source tree"
install -d -o root -g wheel -m 0700 "$PRIV"
GUARD_SHA=$(shasum -a 256 "$GUARD" | cut -c1-64)
FRAME=$("$GUARD" --describe-readonly-v1 "$GUARD" "$VM/sources/$SRC_NAME/tree" "$VM/sources/$SRC_NAME")
/usr/bin/python3 -I - "$PRIV" "$ATT" "$CAP_SHA" "$RUNNER_SHA" "$SRC_DIGEST" "$GUARD_SHA" "$FRAME" "$BOOT_SHA" "$UID_B" <<'PY'
import hashlib, json, os, sys
priv, att, cap, runner, src, guard, frame, boot, uid = sys.argv[1:10]
canon = lambda v: json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
sha = lambda b: hashlib.sha256(b).hexdigest()
job_id = 'direct-proof-1'
profile = sha(b'foundry direct mac-vm-host proof 2026-10-21 (not a server profile)')
identity = 'vm:' + sha(json.dumps([job_id, att, profile], separators=(',', ':')).encode())
files = [
  {'path': 'XcodeAgentTest/XcodeAgentTest.xcodeproj/project.pbxproj', 'sha256': '5e76cff202431cb8730fb420b04f087feb9007f5161c2122c811685a9ad2ec1d', 'sizeBytes': 7587, 'mode': 420},
  {'path': 'XcodeAgentTest/XcodeAgentTest/ContentView.swift', 'sha256': 'c9f4840bf6fd9e045f6e2c739a5a97669670ef3cba279deb4bad109d94721eea', 'sizeBytes': 444, 'mode': 420},
  {'path': 'XcodeAgentTest/XcodeAgentTest/XcodeAgentTestApp.swift', 'sha256': '504d6ae3a6722167eff7ae3b849a07e0bb7f83316b2ff25ce50aaa03ad111970', 'sizeBytes': 147, 'mode': 420},
]
job = {'version': 2, 'identity': identity, 'attemptId': att, 'jobId': job_id, 'profileHash': profile,
       'sourceHash': src, 'guestCapabilityHash': cap, 'guestRunnerSha256': runner,
       'recipe': {'developerDir': '/Applications/Xcode.app/Contents/Developer', 'project': 'XcodeAgentTest/XcodeAgentTest.xcodeproj',
                  'scheme': 'XcodeAgentTest', 'sdk': 'iphoneos27.1', 'destination': 'generic/platform=iOS', 'configuration': 'Release',
                  'xcodeBuild': '27A9275', 'macos': '27.0.1',
                  'outputPaths': ['DerivedData/Build/Products/Release-iphoneos/XcodeAgentTest.app']},
       'limits': {'cpu': 4, 'timeoutMs': 1200000, 'maxOutputBytes': 7340032}, 'files': files}
job_sha = sha(canon(job))
source = {k: json.loads(frame)[k] for k in ('path', 'mountPoint', 'filesystem', 'fsid', 'mountSource', 'volumeUuid', 'rootDevice', 'rootInode')}
req = canon({'version': 1, 'kind': 'stage', 'attemptId': att, 'guardSha256': guard, 'job': job, 'jobSha256': job_sha, 'source': source})
open(os.path.join(priv, 'stage-request.json'), 'wb').write(req)
base = f'/Library/Foundry/VM/attempts/{att}'
config = {'version': 2, 'attemptId': att, 'profileHash': profile, 'jobId': job_id, 'identity': identity, 'guestJobSha256': job_sha,
          'bootSha256': boot, 'helperUID': int(uid), 'cpuCount': 4, 'memoryBytes': 4 * 1024**3, 'maxBootBytes': 107374182400,
          'maxOutputBytes': 1073741824, 'maxRunSeconds': 1200, 'bootDisk': base + '/boot.raw', 'outputDisk': base + '/outputs.raw',
          'auxiliaryStorage': base + '/auxiliary.bin', 'hardwareModel': base + '/hardware-model.bin',
          'machineIdentifier': base + '/machine-identifier.bin', 'inputDirectory': base + '/input'}
open(os.path.join(priv, 'helper-config.json'), 'w').write(json.dumps(config, separators=(',', ':')))
json.dump({'jobSha256': job_sha, 'identity': identity, 'stageRequestSha256': sha(req)}, open(os.path.join(priv, 'ids.json'), 'w'))
print('job', job_sha, 'identity', identity, 'stage request', sha(req))
PY
STAGE_HASH=$(/usr/bin/python3 -I -c "import json;print(json.load(open('$PRIV/ids.json'))['stageRequestSha256'])")
JOB_SHA=$(/usr/bin/python3 -I -c "import json;print(json.load(open('$PRIV/ids.json'))['jobSha256'])")
io_run "$STAGE_HASH" < "$PRIV/stage-request.json" || { mount | grep -q " on $BASE/input " && echo "stage tool refused AFTER mounting the input (known receipt bug); continuing with the mounted input" || { echo "stage failed before mounting"; exit 1; }; }
mount | grep "$BASE/input"
ls -la "$BASE" "$BASE/receipts"

log "3. helper run as foundrybuild"
# The build account reads its config and driver from a root-written 0444 copy in
# its own private work root; nothing else of root's is visible to it.
install -d -o $UID_B -g $UID_B -m 0700 "$VM/work/$ATT"
install -o root -g wheel -m 0444 "$PRIV/helper-config.json" "$VM/work/$ATT/helper-config.json"
cat > "$VM/work/$ATT/driver.py" <<'PY'
import json, os, select, subprocess, sys, threading, time
config = open(sys.argv[1], 'rb').read().strip()
identity = json.loads(config)['identity']
limit = int(sys.argv[2]) if len(sys.argv) > 2 else 1500
p = subprocess.Popen(['/Library/Foundry/bin/mac-vm-host'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                     env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C', 'HOME': os.environ.get('HOME', '/var/empty')})
start = time.monotonic()
def note(e): print(f'{time.monotonic() - start:7.1f}s {e}', flush=True)
def drain_err():
    for line in iter(p.stderr.readline, b''): note('helper stderr: ' + line.decode(errors='replace').strip()[:200])
threading.Thread(target=drain_err, daemon=True).start()
p.stdin.write(config + b'\n'); p.stdin.flush()
deadline = start + limit; buf = b''; permits = 0; out_open = True; stdin_open = True; beat = start
while out_open and time.monotonic() < deadline:
    if time.monotonic() - beat >= 30: note(f'heartbeat: permits {permits}'); beat = time.monotonic()
    r, _, _ = select.select([p.stdout], [], [], 1.0)
    if not r: continue
    chunk = os.read(p.stdout.fileno(), 65536)
    if not chunk: out_open = False; break
    buf += chunk
    while b'\n' in buf:
        line, buf = buf.split(b'\n', 1)
        row = json.loads(line); ev = row.get('event')
        if ev == 'challenge':
            if stdin_open:
                p.stdin.write(json.dumps({'event': 'permit', 'identity': identity, 'nonce': row['nonce'], 'validForMs': 1000}).encode() + b'\n')
                p.stdin.flush(); permits += 1
                if permits == 1: note('first challenge answered (boot image digest verified, VM configured)')
        elif ev == 'started': note(f'STARTED after {permits} permits')
        elif ev == 'stopped': note('STOPPED'); p.stdin.close(); stdin_open = False
        else: note('unexpected ' + line.decode()[:200])
if out_open:
    note(f'driver deadline after {permits} permits: sending stop')
    if stdin_open:
        try: p.stdin.write(json.dumps({'event': 'stop', 'identity': identity}).encode() + b'\n'); p.stdin.close()
        except OSError: pass
try: code = p.wait(timeout=30)
except subprocess.TimeoutExpired:
    note('helper did not exit 30 s after stop: SIGKILL (no stop evidence; attempt is quarantined)'); p.kill(); code = p.wait()
note(f'helper exit {code}, permits {permits}')
sys.exit(0 if code == 0 else 1)
PY
chown root:wheel "$VM/work/$ATT/driver.py"; chmod 0444 "$VM/work/$ATT/driver.py"
set +e
$LAUNCH "$PYX" -I "$VM/work/$ATT/driver.py" "$VM/work/$ATT/helper-config.json" 900
HELPER_RC=$?
set -e
log "helper driver exit $HELPER_RC"

log "4. intake"
/usr/bin/python3 -I - "$PRIV" "$ATT" "$GUARD_SHA" "$JOB_SHA" "$UID_B" <<'PY'
import hashlib, json, os, sys
priv, att, guard, job_sha, uid = sys.argv[1:6]
path = f'/Library/Foundry/VM/attempts/{att}/outputs.raw'
s = os.stat(path, follow_symlinks=False)
h = hashlib.sha256()
with open(path, 'rb') as f:
    for b in iter(lambda: f.read(8 * 1024 * 1024), b''): h.update(b)
canon = lambda v: json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
req = canon({'version': 1, 'kind': 'intake', 'attemptId': att, 'guardSha256': guard, 'jobSha256': job_sha,
             'output': {'path': path, 'device': str(s.st_dev), 'inode': str(s.st_ino), 'uid': int(uid), 'sizeBytes': s.st_size},
             'rawSha256': h.hexdigest()})
open(os.path.join(priv, 'intake-request.json'), 'wb').write(req)
open(os.path.join(priv, 'intake-hash'), 'w').write(hashlib.sha256(req).hexdigest())
print('outputs.raw sha256', h.hexdigest())
PY
if io_run "$(cat "$PRIV/intake-hash")" < "$PRIV/intake-request.json"; then T=$BASE/io-intake/tree
else
  log "intake refused; reading a root copy of outputs.raw directly (diagnostic only, not intake evidence)"
  cp "$BASE/outputs.raw" "$PRIV/outputs-copy.raw"; M=$PRIV/outmnt; mkdir -p "$M"
  hdiutil attach -readonly -nobrowse -imagekey diskimage-class=CRawDiskImage -mountpoint "$M" "$PRIV/outputs-copy.raw" | tail -1
  T=$M
fi
echo "--- result.json"; cat "$T/result.json" 2>/dev/null || cat "$T/failure.json" 2>/dev/null || ls -la "$T"
echo; echo "--- build.log tail"; tail -15 "$T/build.log" 2>/dev/null || true
echo "--- files"; find "$T/files" -maxdepth 4 2>/dev/null | head -20 || true
log "proof $ATT done (helper rc $HELPER_RC)"
 )

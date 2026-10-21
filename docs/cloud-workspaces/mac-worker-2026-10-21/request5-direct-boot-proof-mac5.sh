#!/bin/bash
# Request 5 on Mac5: direct mac-vm-host boot proof (tools/foundry-mac-host/direct-boot-proof.sh, attempt proof-r2-20261021a). Output streams to the Mac1 listener.
URL=http://100.84.118.106:9876
{
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
ATT='proof-r2-20261021a'
DENSE=/Library/Foundry/VM/images/macos-27.0.1-xcode-27.1-r2-dense/boot.raw
IMG=/Library/Foundry/VM/images/macos-27.0.1-xcode-27.1-r2
BOOT_SHA=f07f050064ffde6e421bc2a200d21f6039a8ddebcca77b9236632ea0406e361e
CAP_SHA=0f2a7673987b731271bb43ddbee6fd1b9de3cb32e2c1a0beedfed13900b39d7c
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
trap 'echo "!! FAILED line $LINENO: $BASH_COMMAND"' ERR
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ $ATT =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || { echo "bad attempt id" >&2; exit 1; }
[[ ! -e $BASE ]] || { echo "$BASE already exists; refusing to reuse an attempt" >&2; exit 1; }
[[ -f $DENSE && -x $HELPER && -x $GUARD && -f $IO ]] || { echo "missing dense master, helper, guard or io tool" >&2; exit 1; }
[[ $(id -u _foundrybuild) == "$UID_B" ]] || { echo "build account missing" >&2; exit 1; }
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
/usr/bin/python3 -I "$IO" "$STAGE_HASH" < "$PRIV/stage-request.json"
mount | grep "$BASE/input"
ls -la "$BASE" "$BASE/receipts"

log "3. helper run as _foundrybuild"
# The build account reads its config and driver from a root-written 0444 copy in
# its own private work root; nothing else of root's is visible to it.
install -d -o $UID_B -g $UID_B -m 0700 "$VM/work/$ATT"
install -o root -g wheel -m 0444 "$PRIV/helper-config.json" "$VM/work/$ATT/helper-config.json"
cat > "$VM/work/$ATT/driver.py" <<'PY'
import json, os, select, subprocess, sys, time
config = open(sys.argv[1], 'rb').read().strip()
identity = json.loads(config)['identity']
p = subprocess.Popen(['/Library/Foundry/bin/mac-vm-host'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                     env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'})
p.stdin.write(config + b'\n'); p.stdin.flush()
start = time.monotonic(); deadline = start + 1500
buf = b''; err = b''; permits = 0; events = []; out_open = True; stdin_open = True
def note(e):
    events.append(f'{time.monotonic() - start:7.1f}s {e}'); print(events[-1], flush=True)
while out_open and time.monotonic() < deadline:
    r, _, _ = select.select([p.stdout, p.stderr], [], [], 1.0)
    for fd in r:
        chunk = os.read(fd.fileno(), 65536)
        if fd is p.stderr:
            err += chunk; continue
        if not chunk:
            out_open = False; break
        buf += chunk
        while b'\n' in buf:
            line, buf = buf.split(b'\n', 1)
            row = json.loads(line)
            ev = row.get('event')
            if ev == 'challenge':
                if stdin_open:
                    p.stdin.write(json.dumps({'event': 'permit', 'identity': identity, 'nonce': row['nonce'], 'validForMs': 1000}).encode() + b'\n')
                    p.stdin.flush(); permits += 1
                    if permits == 1: note('first challenge answered (boot image digest verified, VM configured)')
            elif ev == 'started':
                note('started')
            elif ev == 'stopped':
                note('stopped'); p.stdin.close(); stdin_open = False
            else:
                note('unexpected ' + line.decode()[:200])
if time.monotonic() >= deadline:
    note('driver deadline: sending stop')
    if stdin_open:
        p.stdin.write(json.dumps({'event': 'stop', 'identity': identity}).encode() + b'\n'); p.stdin.close()
code = p.wait(timeout=60)
err += p.stderr.read() or b''
note(f'helper exit {code}, permits {permits}, stderr {err.decode(errors="replace").strip()[:500]!r}')
sys.exit(0 if code == 0 else 1)
PY
chown root:wheel "$VM/work/$ATT/driver.py"; chmod 0444 "$VM/work/$ATT/driver.py"
set +e
sudo -u _foundrybuild -g _foundrybuild "$PYX" -I "$VM/work/$ATT/driver.py" "$VM/work/$ATT/helper-config.json"
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
/usr/bin/python3 -I "$IO" "$(cat "$PRIV/intake-hash")" < "$PRIV/intake-request.json"
T=$BASE/io-intake/tree
echo "--- result.json"; cat "$T/result.json" 2>/dev/null || cat "$T/failure.json" 2>/dev/null || ls -la "$T"
echo; echo "--- build.log tail"; tail -15 "$T/build.log" 2>/dev/null || true
echo "--- files"; find "$T/files" -maxdepth 4 2>/dev/null | head -20
log "proof $ATT done (helper rc $HELPER_RC)"
 ) && echo "REQUEST 5 OK" || echo "!! REQUEST 5 FAILED"
} 2>&1 | curl -s -m 3500 -X POST --data-binary @- "$URL/request5" >/dev/null 2>&1

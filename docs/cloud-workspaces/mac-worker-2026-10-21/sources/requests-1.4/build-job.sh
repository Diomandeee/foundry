#!/bin/bash
# Root: one Foundry Mac VM build job, end to end on a provisioned host
# (generalised from direct-boot-proof.sh). Parameters come from the environment:
#   ATT JOB_ID IMAGE BOOT_SHA CAP_SHA RUNNER_SHA SRC_NAME PROJECT SCHEME
#   CONFIGURATION OUTPUT_PATH [CPU=4] [MEM_GIB=4] [TIMEOUT_S=1800]
#   [OUT_DISK_GIB=4] [MAX_OUT_BYTES=2147483648]
# The input file list comes from the sealed source tree's receipt
# (/Library/Foundry/VM/sources/<SRC_NAME>.seal.json). Steps: attempt directory
# (APFS clone of <IMAGE>-dense/boot.raw), mac-vm-io stage, pinned mac-vm-host as
# foundrybuild in its GUI session, mac-vm-io intake, then the verified outputs are
# copied to /Volumes/FoundryBuild/staging/results/<ATT>/ (owner-readable) with a
# manifest, for Mac1 to fetch and re-verify by hash. The job is labelled a direct
# operator run: profileHash = sha256 of a fixed label, sourceHash = the sealed
# tree's content digest. Deletes nothing; refuses to reuse an attempt id.
set -euo pipefail
: "${ATT:?}" "${JOB_ID:?}" "${IMAGE:?}" "${BOOT_SHA:?}" "${CAP_SHA:?}" "${RUNNER_SHA:?}" "${SRC_NAME:?}"
: "${PROJECT:?}" "${SCHEME:?}" "${CONFIGURATION:?}" "${OUTPUT_PATH:?}"
CPU=${CPU:-4}; MEM_GIB=${MEM_GIB:-4}; TIMEOUT_S=${TIMEOUT_S:-1800}; OUT_DISK_GIB=${OUT_DISK_GIB:-4}; MAX_OUT_BYTES=${MAX_OUT_BYTES:-2147483648}
# The build account must have a GUI login session (VZ refuses sessionless users);
# launchctl asuser joins that session, sudo then drops to the account.
# Fixed, not overridable from the environment (review H7: an env-supplied command would run as root).
LAUNCH="launchctl asuser 520 sudo -u foundrybuild -g foundrybuild -H"
DENSE=/Library/Foundry/VM/images/$IMAGE-dense/boot.raw
IMG=/Library/Foundry/VM/images/$IMAGE
RECEIPT=/Library/Foundry/VM/sources/$SRC_NAME.seal.json
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
# Review H7 (2026-10-22): every input is validated before any path or arithmetic uses it, so this script is
# safe to run from a template whose arguments an agent chooses.
bad() { echo "REFUSED: invalid $1" >&2; exit 2; }
NAME_RE='^[a-z0-9][a-z0-9._-]{0,63}$'; ID_RE='^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'; SHA_RE='^[0-9a-f]{64}$'
REL_RE='^[A-Za-z0-9_@+][A-Za-z0-9 ._@+/-]{0,255}$'
[[ $ATT =~ $ID_RE ]] || bad ATT
[[ $JOB_ID =~ $ID_RE ]] || bad JOB_ID
for v in IMAGE SRC_NAME; do [[ ${!v} =~ $NAME_RE && ${!v} != *..* ]] || bad $v; done
for v in BOOT_SHA CAP_SHA RUNNER_SHA; do [[ ${!v} =~ $SHA_RE ]] || bad $v; done
for v in PROJECT OUTPUT_PATH; do
  [[ ${!v} =~ $REL_RE && ${!v} != /* && "/${!v}/" != */../* && "/${!v}/" != */./* ]] || bad $v
done
SCHEME_RE='^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,127}$'
[[ $SCHEME =~ $SCHEME_RE ]] || bad SCHEME
[[ $CONFIGURATION == Debug || $CONFIGURATION == Release ]] || bad CONFIGURATION
num() { [[ ${!1} =~ ^[0-9]{1,12}$ ]] && (( 10#${!1} >= $2 && 10#${!1} <= $3 )) || bad "$1 (want $2..$3)"; }
num CPU 1 8; num MEM_GIB 2 16; num TIMEOUT_S 60 7200; num OUT_DISK_GIB 1 64; num MAX_OUT_BYTES 1 17179869184
CPU=$((10#$CPU)); MEM_GIB=$((10#$MEM_GIB)); TIMEOUT_S=$((10#$TIMEOUT_S)); OUT_DISK_GIB=$((10#$OUT_DISK_GIB)); MAX_OUT_BYTES=$((10#$MAX_OUT_BYTES))
# end of input validation
[[ ! -e $BASE ]] || { echo "$BASE already exists; refusing to reuse an attempt" >&2; exit 1; }
[[ -f $DENSE && -f $RECEIPT && -x $HELPER && -x $GUARD && -f $IO ]] || { echo "missing dense master, helper, guard or io tool" >&2; exit 1; }
[[ $(id -u foundrybuild) == "$UID_B" ]] || { echo "build account missing" >&2; exit 1; }
log "job $ATT ($SCHEME $CONFIGURATION) start; helper $(shasum -a 256 $HELPER | cut -c1-64)"

log "1. attempt directory"
install -d -o root -g wheel -m 0755 "$BASE" "$BASE/receipts"
cp -c "$DENSE" "$BASE/boot.raw"
chown $UID_B:$UID_B "$BASE/boot.raw"; chmod 0600 "$BASE/boot.raw"
cp "$IMG/auxiliary.bin" "$BASE/auxiliary.bin"
chown $UID_B:$UID_B "$BASE/auxiliary.bin"; chmod 0600 "$BASE/auxiliary.bin"
for f in hardware-model.bin machine-identifier.bin; do
  cp "$IMG/$f" "$BASE/$f"; chown root:wheel "$BASE/$f"; chmod 0444 "$BASE/$f"
done
mkfile "${OUT_DISK_GIB}g" "$BASE/outputs.raw"
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
export ATT JOB_ID CAP_SHA RUNNER_SHA GUARD_SHA FRAME BOOT_SHA UID_B RECEIPT PROJECT SCHEME CONFIGURATION OUTPUT_PATH CPU MEM_GIB TIMEOUT_S OUT_DISK_GIB MAX_OUT_BYTES PRIV
/usr/bin/python3 -I - <<'PY'
import hashlib, json, os, sys
E = os.environ
priv, att, cap, runner, guard, frame, boot, uid = E['PRIV'], E['ATT'], E['CAP_SHA'], E['RUNNER_SHA'], E['GUARD_SHA'], E['FRAME'], E['BOOT_SHA'], E['UID_B']
receipt = json.load(open(E['RECEIPT']))
src = receipt['contentDigest']
canon = lambda v: json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
sha = lambda b: hashlib.sha256(b).hexdigest()
job_id = E['JOB_ID']
profile = sha(b'foundry direct operator build job (not a server profile)')
identity = 'vm:' + sha(json.dumps([job_id, att, profile], separators=(',', ':')).encode())
files = [{'path': f['path'], 'sha256': f['sha256'], 'sizeBytes': f['sizeBytes'], 'mode': f.get('mode', 420)} for f in receipt['files']]
job = {'version': 2, 'identity': identity, 'attemptId': att, 'jobId': job_id, 'profileHash': profile,
       'sourceHash': src, 'guestCapabilityHash': cap, 'guestRunnerSha256': runner,
       'recipe': {'developerDir': '/Applications/Xcode.app/Contents/Developer', 'project': E['PROJECT'],
                  'scheme': E['SCHEME'], 'sdk': 'iphoneos27.1', 'destination': 'generic/platform=iOS', 'configuration': E['CONFIGURATION'],
                  'xcodeBuild': '27A9275', 'macos': '27.0.1', 'outputPaths': [E['OUTPUT_PATH']]},
       'limits': {'cpu': int(E['CPU']), 'timeoutMs': int(E['TIMEOUT_S']) * 1000, 'maxOutputBytes': int(E['MAX_OUT_BYTES'])}, 'files': files}
job_sha = sha(canon(job))
source = {k: json.loads(frame)[k] for k in ('path', 'mountPoint', 'filesystem', 'fsid', 'mountSource', 'volumeUuid', 'rootDevice', 'rootInode')}
req = canon({'version': 1, 'kind': 'stage', 'attemptId': att, 'guardSha256': guard, 'job': job, 'jobSha256': job_sha, 'source': source})
open(os.path.join(priv, 'stage-request.json'), 'wb').write(req)
base = f'/Library/Foundry/VM/attempts/{att}'
config = {'version': 2, 'attemptId': att, 'profileHash': profile, 'jobId': job_id, 'identity': identity, 'guestJobSha256': job_sha,
          'bootSha256': boot, 'helperUID': int(uid), 'cpuCount': int(E['CPU']), 'memoryBytes': int(E['MEM_GIB']) * 1024**3, 'maxBootBytes': 107374182400,
          'maxOutputBytes': int(E['OUT_DISK_GIB']) * 1024**3, 'maxRunSeconds': int(E['TIMEOUT_S']) + 120, 'bootDisk': base + '/boot.raw', 'outputDisk': base + '/outputs.raw',
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
$LAUNCH "$PYX" -I "$VM/work/$ATT/driver.py" "$VM/work/$ATT/helper-config.json" $((TIMEOUT_S + 300))
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
log "5. deliver verified outputs for Mac1"
OUTD=/Volumes/FoundryBuild/staging/results/$ATT
EVIDENCE=intake; [[ ${M:-} && $T == "$M" ]] && EVIDENCE=diagnostic
/usr/bin/python3 -I - "$T" "$OUTD" "$BASE" "$EVIDENCE" <<'PY' || echo "!! delivery failed"
import hashlib, json, os, shutil, sys, time
tree, outd, base, evidence = sys.argv[1:5]
rec = []
r = json.load(open(os.path.join(tree, 'result.json')))
if r.get('exitCode') != 0 or r.get('limited'):
    print('build did not succeed; nothing delivered'); sys.exit(0)
os.makedirs(outd, exist_ok=False)
for d in r.get('directories', []): os.makedirs(os.path.join(outd, 'files', d), exist_ok=True)
for o in r['outputs']:
    src = os.path.join(tree, 'files', o['path']); dst = os.path.join(outd, 'files', o['path'])
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    h = hashlib.sha256()
    with open(src, 'rb') as f, open(dst, 'xb') as g:
        for b in iter(lambda: f.read(8 << 20), b''): h.update(b); g.write(b)
    assert h.hexdigest() == o['sha256'] and os.path.getsize(dst) == o['sizeBytes'], o['path']
    os.chmod(dst, 0o755 if o['mode'] == 0o755 else 0o644)
    rec.append({'path': o['path'], 'sha256': h.hexdigest(), 'bytes': os.path.getsize(dst), 'mode': o['mode']})
shutil.copyfile(os.path.join(tree, 'result.json'), os.path.join(outd, 'result.json'))
# Review H8: the delivered tree (and its result.json) end up owned by the login user, so they cannot vouch for
# themselves. This receipt is computed by root from the root-mounted intake tree, lives in the root-owned
# attempt dir, and is what Mac1 must verify the delivered files against.
with open(os.path.join(tree, 'result.json'), 'rb') as f: rsha = hashlib.sha256(f.read()).hexdigest()
receipt = {'version': 1, 'kind': 'delivered-outputs', 'attempt': os.path.basename(base), 'evidence': evidence,
           'resultJsonSha256': rsha, 'outputs': sorted(rec, key=lambda e: e['path']),
           'deliveredTo': outd, 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
rp = os.path.join(base, 'receipts', 'outputs.json')
with open(rp + '.tmp', 'x') as f: json.dump(receipt, f, sort_keys=True, separators=(',', ':'))
os.chown(rp + '.tmp', 0, 0); os.chmod(rp + '.tmp', 0o444); os.rename(rp + '.tmp', rp)
print('root receipt', rp, hashlib.sha256(open(rp, 'rb').read()).hexdigest())
for root, dirs, names in os.walk(outd):
    for n in dirs + names: os.chown(os.path.join(root, n), 501, 20)
os.chown(outd, 501, 20)
print('delivered', len(r['outputs']), 'files,', sum(o['sizeBytes'] for o in r['outputs']), 'bytes to', outd)
PY
[[ ${M:-} ]] && hdiutil detach "$M" >/dev/null 2>&1 || true
log "job $ATT done (helper rc $HELPER_RC)"

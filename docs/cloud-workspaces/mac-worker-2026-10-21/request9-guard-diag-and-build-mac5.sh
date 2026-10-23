#!/bin/bash
URL=http://100.84.118.106:9876
( bash -s ) <<'REQ9' 2>&1 | curl -s -m 3500 -X POST --data-binary @- "$URL/request9" >/dev/null 2>&1
# Request 9 on Mac5. Attempt proof-r2-20261021b: input already staged and mounted
# read-only; mac-vm-io.py refused after the mount (its tree guard describe).
#  A. diagnose: run mac-tree-guard on the input mount and on the sealed
#     capability tree, plus a Python replica of the guard's checks (statfs owner
#     and flags, volume UUID, mount table, per-entry owner/mode/links/ACL).
#  B. run the build anyway: the helper (as foundrybuild in its login session)
#     does its own read-only-input checks. Then intake via mac-vm-io; if that
#     refuses too, mount a root copy of outputs.raw read-only and print result.json.
# Deletes nothing. Live log /Library/Foundry/VM/proof-logs/request9.log
set -uo pipefail
LOG=/Library/Foundry/VM/proof-logs/request9.log; : > "$LOG"; chmod 0644 "$LOG"
exec > >(tee -a "$LOG") 2>&1
log() { echo "== $(date -u +%H:%M:%SZ) $*"; }
VM=/Library/Foundry/VM; ATT=proof-r2-20261021b; BASE=$VM/attempts/$ATT; IN=$BASE/input
GUARD=/Library/Foundry/bin/mac-tree-guard; IO=/Library/Foundry/bin/mac-vm-io.py
PRIV=/private/var/root/.foundry-proof-$ATT; UID_B=520
PYX=/Applications/Xcode.app/Contents/Developer/usr/bin/python3
LAUNCH="launchctl asuser 520 sudo -u foundrybuild -g foundrybuild -H"

log "A. guard runs as root"
"$GUARD" --describe-readonly-v1 "$GUARD" "$IN" "$IN"; echo "guard on input: exit $?"
C=$VM/capabilities/0f2a7673987b731271bb43ddbee6fd1b9de3cb32e2c1a0beedfed13900b39d7c
"$GUARD" --describe-readonly-v1 "$GUARD" "$C" "$C" >/dev/null; echo "guard on capability tree: exit $?"
log "A. replica checks"
/usr/bin/python3 -I - "$IN" <<'PY'
import ctypes, os, stat, subprocess, sys
P = sys.argv[1]
class statfs(ctypes.Structure):
    _fields_ = [('f_bsize', ctypes.c_uint32), ('f_iosize', ctypes.c_int32), ('f_blocks', ctypes.c_uint64), ('f_bfree', ctypes.c_uint64),
                ('f_bavail', ctypes.c_uint64), ('f_files', ctypes.c_uint64), ('f_ffree', ctypes.c_uint64), ('f_fsid', ctypes.c_int32 * 2),
                ('f_owner', ctypes.c_uint32), ('f_type', ctypes.c_uint32), ('f_flags', ctypes.c_uint32), ('f_fssubtype', ctypes.c_uint32),
                ('f_fstypename', ctypes.c_char * 16), ('f_mntonname', ctypes.c_char * 1024), ('f_mntfromname', ctypes.c_char * 1024),
                ('f_flags_ext', ctypes.c_uint32), ('f_reserved', ctypes.c_uint32 * 7)]
libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
fn = libc['statfs$INODE64']; fn.argtypes = [ctypes.c_char_p, ctypes.POINTER(statfs)]
def sf(p):
    s = statfs(); r = fn(p.encode(), ctypes.byref(s)); return s if r == 0 else None
MNT_RDONLY, MNT_LOCAL = 0x1, 0x1000
cur = '/'
for part in [''] + P.strip('/').split('/'):
    if part: cur = os.path.join(cur, part)
    st = os.lstat(cur); s = sf(cur)
    acl = subprocess.run(['/bin/ls', '-lde', cur], capture_output=True, text=True).stdout.strip().split('\n')
    print(f'{cur}: uid {st.st_uid} mode {oct(stat.S_IMODE(st.st_mode))} dir {stat.S_ISDIR(st.st_mode)} | fs owner {s.f_owner} local {bool(s.f_flags & MNT_LOCAL)} ro {bool(s.f_flags & MNT_RDONLY)} type {s.f_fstypename.decode()} on {s.f_mntonname.decode()} from {s.f_mntfromname.decode()} | acl lines {len(acl) - 1}')
print('-- entries under input')
for root, dirs, files in os.walk(P):
    for n in dirs + files:
        p = os.path.join(root, n); st = os.lstat(p)
        acl = subprocess.run(['/bin/ls', '-lde', p], capture_output=True, text=True).stdout.strip().split('\n')
        print(f'{p[len(P):]}: uid {st.st_uid} mode {oct(stat.S_IMODE(st.st_mode))} nlink {st.st_nlink} dev {st.st_dev} acl lines {len(acl) - 1}')
print('-- raw root listing incl. hidden:', os.listdir(P))
PY
diskutil info "$IN" | grep -E "Volume UUID|Owners|Personality"

log "B. helper run (build) as foundrybuild in its login session"
[[ -f $PRIV/helper-config.json ]] || { echo "missing $PRIV/helper-config.json"; exit 1; }
WD=$VM/work/$ATT
install -d -o $UID_B -g $UID_B -m 0700 "$WD"
install -o root -g wheel -m 0444 "$PRIV/helper-config.json" "$WD/helper-config.json"
cat > "$WD/driver.py" <<'PY'
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
chown root:wheel "$WD/driver.py"; chmod 0444 "$WD/driver.py"
$LAUNCH "$PYX" -I "$WD/driver.py" "$WD/helper-config.json" 1500; HELPER_RC=$?
log "helper driver exit $HELPER_RC"

log "C. intake via mac-vm-io"
JOB_SHA=$(/usr/bin/python3 -I -c "import json;print(json.load(open('$PRIV/ids.json'))['jobSha256'])")
GUARD_SHA=$(shasum -a 256 "$GUARD" | cut -c1-64)
/usr/bin/python3 -I - "$PRIV" "$ATT" "$GUARD_SHA" "$JOB_SHA" "$UID_B" <<'PY'
import hashlib, json, os, sys
priv, att, guard, job_sha, uid = sys.argv[1:6]
path = f'/Library/Foundry/VM/attempts/{att}/outputs.raw'
s = os.stat(path, follow_symlinks=False); h = hashlib.sha256()
with open(path, 'rb') as f:
    for b in iter(lambda: f.read(8 * 1024 * 1024), b''): h.update(b)
canon = lambda v: json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
req = canon({'version': 1, 'kind': 'intake', 'attemptId': att, 'guardSha256': guard, 'jobSha256': job_sha,
             'output': {'path': path, 'device': str(s.st_dev), 'inode': str(s.st_ino), 'uid': int(uid), 'sizeBytes': s.st_size}, 'rawSha256': h.hexdigest()})
open(os.path.join(priv, 'intake-request.json'), 'wb').write(req); open(os.path.join(priv, 'intake-hash'), 'w').write(hashlib.sha256(req).hexdigest())
print('outputs.raw sha256', h.hexdigest())
PY
if /usr/bin/python3 -I "$IO" "$(cat "$PRIV/intake-hash")" < "$PRIV/intake-request.json"; then
  T=$BASE/io-intake/tree
else
  log "intake refused; reading a root copy of outputs.raw directly (diagnostic only, not intake evidence)"
  cp "$BASE/outputs.raw" "$PRIV/outputs-copy.raw"; M=$PRIV/outmnt; mkdir -p "$M"
  hdiutil attach -readonly -nobrowse -imagekey diskimage-class=CRawDiskImage -mountpoint "$M" "$PRIV/outputs-copy.raw" | tail -1
  T=$M
fi
echo "--- result.json"; cat "$T/result.json" 2>/dev/null || cat "$T/failure.json" 2>/dev/null || ls -la "$T"
echo; echo "--- build.log tail"; tail -12 "$T/build.log" 2>/dev/null
echo "--- files"; find "$T/files" -maxdepth 5 2>/dev/null | head -20
[[ ${M:-} ]] && hdiutil detach "$M" >/dev/null 2>&1
log "request 9 done (helper rc $HELPER_RC)"
REQ9

#!/usr/bin/python3 -I
# Pilot controller for one Linux isolated attempt. Speaks the broker's framed
# JSON protocol (packages/build-runtime/native/linux-isolation.py) directly
# over /run/foundry-linux/broker.sock, as the controller user:
#
#   sudo -u foundry-ctl /usr/bin/python3 -I -S run-attempt.py \
#        --input DIR --out DIR --attempt-id ID --profile profile.json --profile-hash H
#
# The production controller is LinuxIsolatedRuntimeAdapter (TypeScript); this
# script exists so the host can run and receipt its first job before the
# Cloudflare compute route is deployed. It streams the input tree, seals it,
# starts, keeps admission alive, captures, verifies every returned hash and
# writes out/receipt.json plus the log and outputs. Stdlib only.
import argparse, base64, hashlib, json, os, socket, struct, sys, time

SOCKET = '/run/foundry-linux/broker.sock'
FRAME = 1450000
CHUNK = 1048576
PATH_RE = __import__('re').compile('[A-Za-z0-9_./-]{1,240}')

def canonical(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=True, sort_keys=True)

def encoded(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=True).encode()

def digest(b):
    return hashlib.sha256(b).hexdigest()

class Broker:
    def __init__(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(180)
        self.sock.connect(SOCKET)
        self.sent = 0

    def request(self, value, timeout=180):
        b = encoded(value)
        assert 1 <= len(b) <= FRAME
        self.sock.settimeout(timeout)
        self.sock.sendall(struct.pack('!I', len(b)) + b)
        self.sent += 1
        header = self.take(4)
        n = struct.unpack('!I', header)[0]
        assert 1 <= n <= FRAME
        return json.loads(self.take(n))

    def take(self, n):
        b = bytearray()
        while len(b) < n:
            p = self.sock.recv(n - len(b))
            if not p:
                raise RuntimeError('broker closed the connection')
            b.extend(p)
        return bytes(b)

def manifest(root):
    entries = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root)
            st = os.lstat(full)
            if not __import__('stat').S_ISREG(st.st_mode):
                sys.exit('refusing non-regular input file: %s' % rel)
            if not PATH_RE.fullmatch(rel) or rel.startswith(('/', '-')) or len(rel.split('/')) > 32 \
               or any(p in ('', '.', '..') for p in rel.split('/')):
                sys.exit('input path not accepted by the broker: %s' % rel)
            with open(full, 'rb') as f:
                sha = digest(f.read())
            mode = 0o755 if st.st_mode & 0o111 else 0o644
            entries.append({'path': rel, 'sha256': sha, 'sizeBytes': st.st_size, 'mode': mode})
    if not entries:
        sys.exit('empty input tree')
    return entries

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--attempt-id', required=True)
    ap.add_argument('--profile', required=True)
    ap.add_argument('--profile-hash', required=True)
    a = ap.parse_args()
    if os.geteuid() == 0:
        sys.exit('run as the controller user, not root')
    with open(a.profile) as f:
        profile = json.load(f)
    os.makedirs(a.out, exist_ok=False)
    t0 = time.monotonic()
    entries = manifest(a.input)
    tuples = [[e[k] for k in ('path', 'sha256', 'sizeBytes', 'mode')] for e in entries]
    files_hash = digest(encoded(tuples))
    # Tree hash of the input content, independent of modes and sizes.
    input_hash = digest(''.join(e['path'] + '\0' + e['sha256'] + '\n' for e in entries).encode())
    total = sum(e['sizeBytes'] for e in entries)
    receipt = {'version': 1, 'attemptId': a.attempt_id, 'profileHash': a.profile_hash, 'inputHash': input_hash,
               'filesHash': files_hash, 'files': len(entries), 'bytes': total, 'startedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
               'timingsSec': {}, 'manifest': entries}
    broker = Broker()
    begin = broker.request({'op': 'begin', 'attemptId': a.attempt_id, 'profileHash': a.profile_hash, 'inputHash': input_hash,
                            'filesHash': files_hash, 'bytes': total, 'files': len(entries)}, timeout=600)
    receipt['timingsSec']['begin'] = round(time.monotonic() - t0, 2)
    expected = digest(encoded([a.attempt_id, a.profile_hash, input_hash, files_hash]))
    if begin['identity'] != expected:
        sys.exit('identity mismatch: broker %s expected %s' % (begin['identity'], expected))
    if canonical(begin['profile']) != canonical(profile):
        sys.exit('broker profile differs from the submitted profile')
    receipt.update({'identity': begin['identity'], 'helperSha256': begin['helperSha256'], 'pythonSha256': begin['pythonSha256']})
    print('begin ok identity=%s' % begin['identity'][:16], flush=True)
    for e in entries:
        broker.request({'op': 'file', 'path': e['path'], 'sha256': e['sha256'], 'sizeBytes': e['sizeBytes'], 'mode': e['mode']})
        offset = 0
        with open(os.path.join(a.input, e['path']), 'rb') as f:
            while True:
                b = f.read(CHUNK)
                if not b:
                    break
                broker.request({'op': 'append', 'offset': offset, 'data': base64.b64encode(b).decode()})
                offset += len(b)
        broker.request({'op': 'end'})
    sealed = broker.request({'op': 'seal'})
    receipt['timingsSec']['sealed'] = round(time.monotonic() - t0, 2)
    print('sealed %d files %d bytes' % (len(entries), total), flush=True)

    def runway():
        return str(time.monotonic_ns() + 30 * 10**9)
    reply = broker.request({'op': 'start', 'expiresAtNs': runway()}, timeout=120)
    receipt['timingsSec']['started'] = round(time.monotonic() - t0, 2)
    print('started', flush=True)
    last_pulse = time.monotonic()
    while not reply['terminal']:
        time.sleep(1.5)
        if time.monotonic() - last_pulse >= 10:
            reply = broker.request({'op': 'pulse', 'expiresAtNs': runway()})
            last_pulse = time.monotonic()
        else:
            reply = broker.request({'op': 'status'})
    receipt['timingsSec']['terminal'] = round(time.monotonic() - t0, 2)
    receipt['final'] = reply
    print('terminal success=%s exitCode=%s logBytes=%s' % (reply['success'], reply['exitCode'], reply['log']['sizeBytes']), flush=True)
    if not reply['success']:
        receipt['result'] = 'FAILED'
        with open(os.path.join(a.out, 'receipt.json'), 'w') as f:
            json.dump(receipt, f, indent=1)
        sys.exit(2)
    captured = broker.request({'op': 'capture'}, timeout=600)
    receipt['timingsSec']['captured'] = round(time.monotonic() - t0, 2)
    receipt['captured'] = captured

    def fetch(index, size, expect_sha, dest):
        h = hashlib.sha256(); got = 0
        with open(dest, 'wb') as f:
            while got < size:
                r = broker.request({'op': 'read', 'index': index, 'offset': got})
                b = base64.b64decode(r['data'], validate=True)
                if not b:
                    break
                f.write(b); h.update(b); got += len(b)
        if got != size or h.hexdigest() != expect_sha:
            sys.exit('captured item %s failed verification (%d/%d bytes)' % (index, got, size))
    fetch(-1, captured['log']['sizeBytes'], captured['log']['sha256'], os.path.join(a.out, 'log'))
    for index, o in enumerate(captured['outputs']):
        dest = os.path.join(a.out, 'outputs', o['path'])
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        fetch(index, o['sizeBytes'], o['sha256'], dest)
    receipt['timingsSec']['fetched'] = round(time.monotonic() - t0, 2)
    receipt['result'] = 'PASS'
    receipt['requests'] = broker.sent
    with open(os.path.join(a.out, 'receipt.json'), 'w') as f:
        json.dump(receipt, f, indent=1)
    print('PASS outputs=%s log=%s' % ([o['path'] for o in captured['outputs']], captured['log']['sizeBytes']), flush=True)

if __name__ == '__main__':
    main()

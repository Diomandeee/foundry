"""SOURCE ONLY. Explicitly installed/started root CAS service; never auto-started.
Run with owner-approved isolated Python (-I -S). No installer, sudo, mounts,
commands, deletion, remote access, arbitrary paths, or writable-tree capability.
Root/administrators and the installed runtime are trusted; job code is not.
"""
import base64
import ctypes
import errno
import hashlib
import json
import os
import re
import socket
import stat
import struct
import sys
import time

BASE = '/Library/Foundry/CAS'
SOCKET = BASE + '/run/store.sock'
CONFIG = BASE + '/policy.json'
MAX_OBJECT = 1048576
MAX_FRAME = 1450000
MAX_SCAN_ENTRIES = 270000  # 200,000 objects plus the bounded shard directories.
MAX_SCAN_SECONDS = 2
MAX_SAFE_INTEGER = 2**53-1
LIB = None


def need(value, code):
    if not value:
        raise ValueError(code)


def no_acl(fd):
    security = LIB.filesec_init()
    need(security, 'security')
    acl = ctypes.c_void_p()
    try:
        present = ctypes.c_int()
        observed = ctypes.create_string_buffer(4096)
        need(LIB.fstatx_np(fd, observed, security) == 0 and
             LIB.filesec_query_property(security, 5, ctypes.byref(present)) == 0, 'security-read')
        if not present.value:
            return
        need(LIB.filesec_get_property(security, 5, ctypes.byref(acl)) == 0 and
             acl.value and acl.value != 1, 'acl-read')
        entry = ctypes.c_void_p()
        ctypes.set_errno(0)
        found = LIB.acl_get_entry(acl, 0, ctypes.byref(entry))
        need(found == -1 and ctypes.get_errno() == errno.EINVAL, 'acl-present')
    finally:
        if acl.value and acl.value != 1:
            LIB.acl_free(acl)
        LIB.filesec_free(security)


def root_fd(path, file=False):
    need(path.startswith('/') and '//' not in path and all(p not in ('.', '..') for p in path.split('/')), 'path')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        parts = path.split('/')[1:]
        for i, part in enumerate([''] + parts):
            leaf = i == len(parts)
            if part:
                flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
                if not (leaf and file):
                    flags |= os.O_DIRECTORY
                child = os.open(part, flags, dir_fd=fd)
                os.close(fd)
                fd = child
            s = os.fstat(fd)
            need(s.st_uid == 0 and s.st_mode & 0o022 == 0, 'root-owner')
            need(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 if leaf and file else stat.S_ISDIR(s.st_mode), 'root-type')
            no_acl(fd)
        return fd
    except BaseException:
        os.close(fd)
        raise


def exact(value, fields):
    need(type(value) is dict and set(value) == set(fields), 'shape')


def unique(pairs):
    out = {}
    for k, v in pairs:
        need(k not in out, 'duplicate-key')
        out[k] = v
    return out


def decode(raw):
    need(0 < len(raw) <= MAX_FRAME, 'frame')
    return json.loads(raw.decode('utf-8'), object_pairs_hook=unique)


def encode(obj):
    return json.dumps(obj, separators=(',', ':'), sort_keys=True).encode('utf-8')


def recv_exact(conn, count, deadline):
    data = bytearray()
    while len(data) < count:
        remaining = deadline-time.monotonic()
        need(remaining > 0, 'deadline')
        conn.settimeout(remaining)
        chunk = conn.recv(min(65536, count-len(data)))
        need(chunk, 'short-frame')
        data.extend(chunk)
    return bytes(data)


def receive(conn, deadline):
    length = struct.unpack('!I', recv_exact(conn, 4, deadline))[0]
    need(0 < length <= MAX_FRAME, 'frame-bound')
    return recv_exact(conn, length, deadline)


def send(conn, raw, deadline):
    need(0 < len(raw) <= MAX_FRAME and deadline > time.monotonic(), 'response-bound')
    conn.settimeout(deadline-time.monotonic())
    conn.sendall(struct.pack('!I', len(raw))+raw)


def peer_uid(conn):
    uid, gid = ctypes.c_uint(), ctypes.c_uint()
    need(LIB.getpeereid(conn.fileno(), ctypes.byref(uid), ctypes.byref(gid)) == 0, 'peer-identity')
    return uid.value


def ref(digest, size):
    return {'kind': 'local-cas', 'sha256': digest, 'sizeBytes': size,
            'relativePath': 'sha256/'+digest[:2]+'/'+digest[2:4]+'/sha256-'+digest}


def validate(r):
    need(type(r) is dict and r.get('op') in ('put', 'read', 'census'), 'operation')
    if r['op'] == 'census':
        exact(r, ['version', 'op', 'nonce'])
        need(type(r['version']) is int and r['version'] == 1 and type(r['nonce']) is str and
             re.fullmatch('[a-f0-9]{32}', r['nonce']), 'census-identity')
        return None
    exact(r, ['version', 'op', 'sha256', 'sizeBytes'] + (['data'] if r['op'] == 'put' else []))
    need(type(r['version']) is int and r['version'] == 1 and type(r['sha256']) is str and
         re.fullmatch('[a-f0-9]{64}', r['sha256']) and type(r['sizeBytes']) is int and
         0 < r['sizeBytes'] <= MAX_OBJECT, 'identity')
    if r['op'] == 'put':
        need(type(r['data']) is str and len(r['data']) <= 1398104, 'data')
        data = base64.b64decode(r['data'], validate=True)
        need(base64.b64encode(data).decode('ascii') == r['data'] and len(data) == r['sizeBytes'] and
             hashlib.sha256(data).hexdigest() == r['sha256'], 'digest')
        return data
    return None


class Store:
    def __init__(self, policy, runtime):
        self.policy = policy
        self.runtime = runtime
        self.fd = root_fd(BASE+'/objects')  # Must be provisioned; no mkdir of trust root.
        need(stat.S_IMODE(os.fstat(self.fd).st_mode) == 0o700, 'private-root')
        self.device = os.fstat(self.fd).st_dev
        self.bytes, self.count = 0, 0
        # Include incomplete creates in durable quota reconstruction; never erase
        # or discount them after a crash. Fail on unknown entries and oversize trees.
        totals = {'bytes': 0, 'count': 0, 'entries': 0}
        self.inventory(self.fd, 0, '', totals)
        self.bytes, self.count = totals['bytes'], totals['count']

    def child(self, parent, name, create=False):
        if create:
            try:
                os.mkdir(name, 0o700, dir_fd=parent)
                os.fsync(parent)
            except FileExistsError:
                pass
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            s = os.fstat(fd)
            need(s.st_uid == 0 and s.st_dev == self.device and stat.S_IMODE(s.st_mode) == 0o700, 'private-shard')
            no_acl(fd)
            return fd
        except BaseException:
            os.close(fd)
            raise

    def inventory(self, fd, depth, prefix, totals, deadline=None):
        # scandir(fd) is streaming, not an unbounded listdir allocation.
        before = os.fstat(fd)
        with os.scandir(fd) as entries:
            n = 0
            for e in entries:
                need(deadline is None or time.monotonic() < deadline, 'census-deadline')
                totals['entries'] += 1
                need(totals['entries'] <= MAX_SCAN_ENTRIES, 'inventory-bound')
                n += 1
                need(n <= (1 if depth == 0 else 256 if depth < 3 else 4096), 'shard-bound')
                if depth < 3:
                    need(e.name == 'sha256' if depth == 0 else re.fullmatch('[a-f0-9]{2}', e.name), 'shard-name')
                    child = self.child(fd, e.name)
                    try:
                        self.inventory(child, depth+1, prefix+(e.name if depth else ''), totals, deadline)
                    finally:
                        os.close(child)
                else:
                    need(re.fullmatch('sha256-'+prefix+'[a-f0-9]{60}', e.name), 'object-name')
                    obj = os.open(e.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                    try:
                        s = os.fstat(obj)
                        need(stat.S_ISREG(s.st_mode) and s.st_uid == 0 and s.st_dev == self.device and
                             s.st_nlink == 1 and stat.S_IMODE(s.st_mode) == 0o400 and 0 <= s.st_size <= MAX_OBJECT, 'object-entry')
                        no_acl(obj)
                        totals['count'] += 1
                        totals['bytes'] += s.st_size
                        need(totals['count'] <= self.policy['maxObjects'] and totals['bytes'] <= self.policy['maxBytes'], 'quota')
                    finally:
                        os.close(obj)
        after = os.fstat(fd)
        need((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
             (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'inventory-changed')
        need(deadline is None or time.monotonic() < deadline, 'census-deadline')

    def census(self, nonce):
        # This is a fresh scan, not the quota debit (which can conservatively
        # include unwritten bytes after a failed create). Requests are serialized
        # with writes by serve(). A scan never lowers that admission debit.
        deadline = time.monotonic()+MAX_SCAN_SECONDS
        fd = root_fd(BASE+'/objects')
        try:
            s, held = os.fstat(fd), os.fstat(self.fd)
            need(stat.S_IMODE(s.st_mode) == 0o700 and (s.st_dev, s.st_ino) ==
                 (held.st_dev, held.st_ino), 'census-root-changed')
            totals = {'bytes': 0, 'count': 0, 'entries': 0}
            self.inventory(fd, 0, '', totals, deadline)
            space = os.fstatvfs(fd)
            free = space.f_bavail*space.f_frsize
            need(0 <= free <= MAX_SAFE_INTEGER and time.monotonic() < deadline, 'census-space-or-deadline')
            return {'version': 1, 'ok': True, 'nonce': nonce, 'root': BASE+'/objects',
                    'complete': True, 'cacheBytes': totals['bytes'], 'objectCount': totals['count'],
                    'freeBytes': free, **self.runtime}
        finally:
            os.close(fd)

    def read(self, parent, name, digest, size):
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            s = os.fstat(fd)
            need(stat.S_ISREG(s.st_mode) and s.st_uid == 0 and s.st_dev == self.device and s.st_nlink == 1 and
                 stat.S_IMODE(s.st_mode) == 0o400 and s.st_size == size, 'object-metadata')
            no_acl(fd)
            data = bytearray()
            while len(data) < size:
                b = os.read(fd, min(65536, size-len(data)))
                need(b, 'short-object')
                data.extend(b)
            need(not os.read(fd, 1) and hashlib.sha256(data).hexdigest() == digest, 'object-integrity')
            return bytes(data)
        finally:
            os.close(fd)

    def operation(self, r):
        data = validate(r)
        if r['op'] == 'census':
            return self.census(r['nonce'])
        digest, size = r['sha256'], r['sizeBytes']
        parent = os.dup(self.fd)
        try:
            if data is not None:
                space = os.fstatvfs(self.fd)
                need(space.f_bavail*space.f_frsize-size-65536 >= self.policy['reserveBytes'], 'disk-reserve-with-shards')
            for name in ('sha256', digest[:2], digest[2:4]):
                child = self.child(parent, name, data is not None)
                os.close(parent)
                parent = child
            name = 'sha256-'+digest
            if data is not None:
                try:
                    existing = os.stat(name, dir_fd=parent, follow_symlinks=False)
                except FileNotFoundError:
                    existing = None
                if existing is None:
                    with os.scandir(parent) as siblings:
                        for number, _ in enumerate(siblings, 1):
                            need(number < 4096, 'shard-full')
                    need(self.count+1 <= self.policy['maxObjects'] and self.bytes+size <= self.policy['maxBytes'], 'quota')
                    space = os.fstatvfs(self.fd)
                    need(space.f_bavail*space.f_frsize-size >= self.policy['reserveBytes'], 'disk-reserve')
                    # Debit before creation. Failed write stays counted until restart
                    # reconstructs actual retained size; it cannot be overwritten.
                    self.count += 1
                    self.bytes += size
                    out = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400, dir_fd=parent)
                    try:
                        offset = 0
                        while offset < size:
                            n = os.write(out, data[offset:])
                            need(n > 0, 'write-progress')
                            offset += n
                        os.fsync(out)
                    finally:
                        os.close(out)
                    os.fsync(parent)
            verified = self.read(parent, name, digest, size)
            result = {'version': 1, 'ok': True, 'ref': ref(digest, size)}
            if r['op'] == 'read':
                result['data'] = base64.b64encode(verified).decode('ascii')
            return result
        finally:
            os.close(parent)


def policy_read():
    fd = root_fd(CONFIG, file=True)
    try:
        need(os.fstat(fd).st_size <= 4096, 'policy-bound')
        policy = decode(os.read(fd, 4097))
    finally:
        os.close(fd)
    exact(policy, ['version', 'workerUid', 'workerGid', 'maxBytes', 'maxObjects', 'reserveBytes'])
    need(all(type(v) is int for v in policy.values()) and policy['version'] == 1 and
         501 <= policy['workerUid'] < 2**31 and 501 <= policy['workerGid'] < 2**31 and
         MAX_OBJECT <= policy['maxBytes'] <= 20*1024**3 and 1 <= policy['maxObjects'] <= 200000 and
         50*1024**3 <= policy['reserveBytes'] <= 1024**4, 'policy')
    return policy


def installed_digest(path):
    fd = root_fd(path, file=True)
    try:
        size = os.fstat(fd).st_size
        need(0 < size <= 64*1048576, 'runtime-size')
        digest = hashlib.sha256()
        remaining = size
        while remaining:
            data = os.read(fd, min(remaining, 65536))
            need(data, 'runtime-short')
            digest.update(data)
            remaining -= len(data)
        need(not os.read(fd, 1), 'runtime-grown')
        return digest.hexdigest()
    finally:
        os.close(fd)


def serve():
    need(os.getuid() == 0 and os.geteuid() == 0, 'root-service-required')
    need(os.path.abspath(sys.executable) == '/Library/Foundry/bin/cas-python' and
         os.path.abspath(__file__) == '/Library/Foundry/bin/mac-cas.py', 'installed-service-runtime-required')
    policy = policy_read()
    run = root_fd(BASE+'/run')
    need(stat.S_IMODE(os.fstat(run).st_mode) == 0o755, 'socket-directory')
    # No stale-socket removal. An existing name requires owner reconciliation;
    # reboot/restart cannot silently replace another service's endpoint.
    # Capture the owner-installed identity at service startup; a new client pin
    # cannot silently treat an older running service as the new implementation.
    runtime = {'pythonSha256': installed_digest('/Library/Foundry/bin/cas-python'),
               'helperSha256': installed_digest('/Library/Foundry/bin/mac-cas.py')}
    store = Store(policy, runtime)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
        server.bind(SOCKET)
        os.chown(SOCKET, 0, policy['workerGid'])
        os.chmod(SOCKET, 0o660)
        os.fsync(run)
        server.listen(4)
        while True:
            conn, _ = server.accept()
            with conn:
                deadline = time.monotonic()+15
                try:
                    need(peer_uid(conn) == policy['workerUid'], 'unauthorized-peer')
                    r = decode(receive(conn, deadline))
                    reply = store.operation(r)
                    send(conn, encode(reply), deadline)
                except Exception:
                    try:
                        send(conn, encode({'version': 1, 'ok': False}), deadline)
                    except Exception:
                        pass
    os.close(run)


def client():
    need(os.getuid() >= 501 and os.getuid() == os.geteuid() and os.getgid() == os.getegid(), 'unprivileged-client')
    for path in ('/Library/Foundry/bin/cas-python', '/Library/Foundry/bin/mac-cas.py'):
        fd = root_fd(path, file=True)
        os.close(fd)
    fd = root_fd(BASE+'/run')
    try:
        s = os.stat('store.sock', dir_fd=fd, follow_symlinks=False)
        need(stat.S_ISSOCK(s.st_mode) and s.st_uid == 0 and stat.S_IMODE(s.st_mode) == 0o660, 'socket-owner')
        # Parent is root-only writable and ACL-free. Kernel peer credentials bind
        # the connection to root, independent of a process-supplied READY string.
        raw = sys.stdin.buffer.read(MAX_FRAME+1)
        validate(decode(raw))
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
            deadline = time.monotonic()+15
            conn.settimeout(15)
            conn.connect(SOCKET)
            need(peer_uid(conn) == 0, 'root-peer-required')
            send(conn, raw, deadline)
            reply = receive(conn, deadline)
            # The Node consumer verifies exact reference and actual content hash.
            sys.stdout.buffer.write(reply)
    finally:
        os.close(fd)


def main():
    global LIB
    need(sys.platform == 'darwin' and sys.flags.isolated and sys.flags.no_site, 'isolated-darwin-python-required')
    need(len(sys.argv) == 2 and sys.argv[1] in ('client', 'serve'), 'mode')
    LIB = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
    LIB.filesec_init.restype = ctypes.c_void_p
    LIB.filesec_free.argtypes = [ctypes.c_void_p]
    LIB.filesec_free.restype = None
    LIB.fstatx_np.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p]
    LIB.filesec_query_property.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
    LIB.filesec_get_property.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
    LIB.acl_get_entry.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
    LIB.acl_free.argtypes = [ctypes.c_void_p]
    LIB.getpeereid.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint)]
    os.umask(0o077)
    if sys.argv[1] == 'serve':
        serve()
    else:
        client()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # No object contents, request bytes, policy values, or raw exceptions.
        sys.stderr.write('foundry-cas: refused\n')
        sys.exit(1)

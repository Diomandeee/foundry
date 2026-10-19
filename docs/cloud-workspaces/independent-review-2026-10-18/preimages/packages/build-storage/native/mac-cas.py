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
    need(type(r) is dict and r.get('op') in ('put', 'read'), 'operation')
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
    def __init__(self, policy):
        self.policy = policy
        self.fd = root_fd(BASE+'/objects')  # Must be provisioned; no mkdir of trust root.
        need(stat.S_IMODE(os.fstat(self.fd).st_mode) == 0o700, 'private-root')
        self.device = os.fstat(self.fd).st_dev
        self.bytes, self.count = 0, 0
        # Include incomplete creates in durable quota reconstruction; never erase
        # or discount them after a crash. Fail on unknown entries and oversize trees.
        self.inventory(self.fd, 0, '')

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

    def inventory(self, fd, depth, prefix):
        # scandir(fd) is streaming, not an unbounded listdir allocation.
        with os.scandir(fd) as entries:
            n = 0
            for e in entries:
                n += 1
                need(n <= (1 if depth == 0 else 256 if depth < 3 else 4096), 'shard-bound')
                if depth < 3:
                    need(e.name == 'sha256' if depth == 0 else re.fullmatch('[a-f0-9]{2}', e.name), 'shard-name')
                    child = self.child(fd, e.name)
                    try:
                        self.inventory(child, depth+1, prefix+(e.name if depth else ''))
                    finally:
                        os.close(child)
                else:
                    need(re.fullmatch('sha256-'+prefix+'[a-f0-9]{60}', e.name), 'object-name')
                    s = e.stat(follow_symlinks=False)
                    need(stat.S_ISREG(s.st_mode) and s.st_uid == 0 and s.st_dev == self.device and
                         s.st_nlink == 1 and stat.S_IMODE(s.st_mode) == 0o400 and 0 <= s.st_size <= MAX_OBJECT, 'object-entry')
                    self.count += 1
                    self.bytes += s.st_size
                    need(self.count <= self.policy['maxObjects'] and self.bytes <= self.policy['maxBytes'], 'quota')

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


def serve():
    need(os.getuid() == 0 and os.geteuid() == 0, 'root-service-required')
    policy = policy_read()
    run = root_fd(BASE+'/run')
    need(stat.S_IMODE(os.fstat(run).st_mode) == 0o755, 'socket-directory')
    # No stale-socket removal. An existing name requires owner reconciliation;
    # reboot/restart cannot silently replace another service's endpoint.
    store = Store(policy)
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

"""Offline owner-invoked Mac VM image assembler. SOURCE ONLY; no installer.

Read one bounded request on stdin. Root must approve the exact request hash before
invocation. This is NOT a setuid program, daemon, network service or sudo policy.
No arbitrary commands/destinations, overwrite, replay, retry, detach or deletion.
On any error retain partial images/mounts and quarantine the attempt for review.
"""
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import selectors
import stat
import subprocess
import sys
import time

BASE = Path('/Library/Foundry/VM/attempts')
GUARD = '/Library/Foundry/bin/mac-tree-guard'
ENV = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LANG': 'C', 'LC_ALL': 'C', 'HOME': '/var/root'}
MAX_RAW = 16 * 1024**3
MAX_TREE = 8 * 1024**2
DEADLINE = None
LIB = None


def need(value, code):
    if not value:
        raise ValueError(code)


def tick():
    need(DEADLINE is not None and time.monotonic() < DEADLINE, 'deadline')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        need(key not in result, 'duplicate-json-key')
        result[key] = value
    return result


def decode(data):
    return json.loads(data.decode('utf-8'), object_pairs_hook=unique_object)


def read_request():
    fd = sys.stdin.fileno()
    mode = os.fstat(fd).st_mode
    need(stat.S_ISREG(mode) or stat.S_ISFIFO(mode), 'request-file-or-pipe-required')
    poller = None
    data = bytearray()
    try:
        if stat.S_ISFIFO(mode):
            os.set_blocking(fd, False)
            poller = selectors.DefaultSelector()
            poller.register(fd, selectors.EVENT_READ)
        while True:
            tick()
            if poller is not None and not poller.select(0.1):
                continue
            chunk = os.read(fd, min(65536, 524289-len(data)))
            if not chunk:
                break
            data.extend(chunk)
            need(len(data) <= 524288, 'request-byte-budget')
        return bytes(data)
    finally:
        if poller is not None:
            poller.close()


def no_acl(fd):
    # Darwin FILESEC_ACL=5, ACL_FIRST_ENTRY=0. Use the OS security API,
    # never ls text or an xattr heuristic. fstatx's stat buffer is not interpreted.
    security = LIB.filesec_init()
    need(security, 'filesec-init')
    acl = ctypes.c_void_p()
    try:
        present = ctypes.c_int()
        observed = ctypes.create_string_buffer(4096)
        need(LIB.fstatx_np(fd, observed, security) == 0 and
             LIB.filesec_query_property(security, 5, ctypes.byref(present)) == 0, 'acl-observation')
        if not present.value:
            return
        need(LIB.filesec_get_property(security, 5, ctypes.byref(acl)) == 0 and acl.value
             and acl.value != 1, 'acl-read')  # Darwin _FILESEC_REMOVE_ACL
        entry = ctypes.c_void_p()
        ctypes.set_errno(0)
        found = LIB.acl_get_entry(acl, 0, ctypes.byref(entry))
        need(found == -1 and ctypes.get_errno() == errno.EINVAL, 'acl-present')
    finally:
        if acl.value and acl.value != 1:
            LIB.acl_free(acl)
        LIB.filesec_free(security)


def secure(path, file=False):
    """Root-controlled, ACL-free namespace, no links at any component."""
    p = Path(path)
    need(p.is_absolute() and str(p) == str(path) and '..' not in p.parts, 'absolute-path')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for index, part in enumerate(('',) + p.parts[1:]):
            if part:
                flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
                if not (file and index == len(p.parts)-1):
                    flags |= os.O_DIRECTORY
                child = os.open(part, flags, dir_fd=fd)
                os.close(fd)
                fd = child
            s = os.fstat(fd)
            need(s.st_uid == 0 and not s.st_mode & 0o022, 'root-namespace')
            no_acl(fd)
            if file and index == len(p.parts)-1:
                need(stat.S_ISREG(s.st_mode) and s.st_nlink == 1, 'root-file')
            else:
                need(stat.S_ISDIR(s.st_mode), 'root-directory')
        return fd
    except BaseException:
        os.close(fd)
        raise


def relative(value):
    need(isinstance(value, str) and 0 < len(value.encode()) <= 4096 and not value.startswith('/')
         and len(value.split('/')) <= 64 and all(p not in ('', '.', '..') and len(p.encode()) <= 255
         and not any(ord(c) < 32 or ord(c) == 127 for c in p) for p in value.split('/')), 'relative-path')
    return value


def beneath(root, path, directory=False):
    relative(path)
    fd = os.dup(root)
    device = os.fstat(fd).st_dev
    try:
        parts = path.split('/')
        for i, part in enumerate(parts):
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            if i < len(parts)-1 or directory:
                flags |= os.O_DIRECTORY
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
            need(os.fstat(fd).st_dev == device, 'nested-mount')
        return fd
    except BaseException:
        os.close(fd)
        raise


def unchanged(a, b):
    return (a.st_dev, a.st_ino, a.st_uid, a.st_mode, a.st_nlink, a.st_size, a.st_mtime_ns, a.st_ctime_ns) == (
        b.st_dev, b.st_ino, b.st_uid, b.st_mode, b.st_nlink, b.st_size, b.st_mtime_ns, b.st_ctime_ns)


def write_new(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        view = memoryview(data)
        while view:
            tick()
            n = os.write(fd, view)
            need(n > 0, 'write-short')
            view = view[n:]
        os.fchmod(fd, 0o444)
        os.fsync(fd)
    finally:
        os.close(fd)
    sync_dir(path.parent)


def sync_dir(path):
    fd = secure(path)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def mkdir_parent(root, relative_path):
    path = root
    for part in relative(relative_path).split('/')[:-1]:
        path = path / part
        try:
            path.mkdir(mode=0o700)
        except FileExistsError:
            pass
        fd = secure(path)
        os.close(fd)
    return root / relative_path


def copy_fd(src, destination, maximum, expected=None, executable=False):
    tick()
    before = os.fstat(src)
    need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 <= before.st_size <= maximum, 'copy-file-budget')
    dest = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    h, size = hashlib.sha256(), 0
    try:
        while size < before.st_size:
            tick()
            chunk = os.read(src, min(1048576, before.st_size-size))
            need(chunk, 'copy-short')
            size += len(chunk)
            h.update(chunk)
            view = memoryview(chunk)
            while view:
                tick()
                n = os.write(dest, view)
                need(n > 0, 'copy-write-short')
                view = view[n:]
        need(not os.read(src, 1) and unchanged(before, os.fstat(src)), 'copy-changed')
        actual = h.hexdigest()
        if expected is not None:
            need((actual, size) == expected, 'copy-digest')
        os.fchmod(dest, 0o555 if executable else 0o444)
        os.fsync(dest)
        return actual, size
    finally:
        os.close(dest)


def hash_fd(fd, maximum):
    before = os.fstat(fd)
    need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 < before.st_size <= maximum, 'hash-budget')
    os.lseek(fd, 0, os.SEEK_SET)
    h, count = hashlib.sha256(), 0
    while count < before.st_size:
        tick()
        data = os.read(fd, min(1048576, before.st_size-count))
        need(data, 'hash-short')
        h.update(data)
        count += len(data)
    need(not os.read(fd, 1) and unchanged(before, os.fstat(fd)), 'hash-changed')
    return h.hexdigest()


def command(argv, maximum=131072):
    tick()
    fd = secure(argv[0], file=True)
    need(os.fstat(fd).st_mode & 0o111 and not os.fstat(fd).st_mode & 0o6000, 'executable')
    os.close(fd)
    p = subprocess.Popen(argv, env=ENV, cwd='/', stdin=subprocess.DEVNULL,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    content = bytearray()
    selector = selectors.DefaultSelector()
    selector.register(p.stdout, selectors.EVENT_READ)
    os.set_blocking(p.stdout.fileno(), False)
    try:
        while selector.get_map():
            tick()
            for key, _ in selector.select(0.1):
                data = os.read(key.fd, min(65536, maximum+1-len(content)))
                if not data:
                    selector.unregister(key.fileobj)
                else:
                    content.extend(data)
                    need(len(content) <= maximum, 'command-output-budget')
        need(p.wait(timeout=max(0.1, DEADLINE-time.monotonic())) == 0, 'command-failed')
        return bytes(content)
    finally:
        selector.close()
        if p.poll() is None:
            p.kill()  # Observation failure; mounts/children remain quarantined.
        p.stdout.close()


def describe(path, mount):
    row = decode(command([GUARD, '--describe-readonly-v1', GUARD, str(path), str(mount)]))
    need(row['event'] == 'observed' and row['readonly'] is True and row['mountOwner'] == 0, 'readonly-description')
    return {key: row[key] for key in ('path', 'mountPoint', 'filesystem', 'fsid', 'mountSource', 'volumeUuid', 'rootDevice', 'rootInode')}


def freeze_tree(root):
    # This is a newly created root-only namespace. Never chmod original content.
    for parent, dirs, files in os.walk(root, topdown=False, followlinks=False):
        tick()
        for name in files:
            fd = secure(Path(parent)/name, file=True)
            try:
                os.fchmod(fd, 0o555 if os.fstat(fd).st_mode & 0o111 else 0o444)
                os.fsync(fd)
            finally:
                os.close(fd)
        fd = secure(parent)
        try:
            os.fchmod(fd, 0o555)
            os.fsync(fd)
        finally:
            os.close(fd)


def attach(image, mount, raw=False):
    mount.mkdir(mode=0o755)  # Exclusive; never reuse an existing mountpoint.
    args = ['/usr/bin/hdiutil', 'attach', str(image), '-readonly', '-nobrowse', '-noautoopen',
            '-owners', 'on', '-mountpoint', str(mount), '-plist']
    if raw:
        args += ['-imagekey', 'diskimage-class=CRawDiskImage']
    data = plistlib.loads(command(args))
    entities = data.get('system-entities', [])
    mounted = [e for e in entities if 'mount-point' in e]
    need(len(mounted) == 1 and mounted[0]['mount-point'] == str(mount)
         and os.path.ismount(mount) and os.statvfs(mount).f_flag & os.ST_RDONLY, 'attached-volume')


def image_tree(work, tree, mount):
    freeze_tree(tree)
    image = work / 'sealed.dmg'
    command(['/usr/bin/hdiutil', 'create', '-srcfolder', str(tree), '-format', 'UDRO', '-fs', 'HFS+',
             '-uid', '0', '-gid', '0', '-mode', '0555', '-noscrub', '-nocrossdev', str(image)])
    fd = secure(image, file=True)
    try:
        os.fchmod(fd, 0o444)
        os.fsync(fd)
        image_hash = hash_fd(fd, 4*1024**3)
    finally:
        os.close(fd)
    attach(image, mount)
    tree_identity = describe(mount, mount)
    return image_hash, tree_identity


def stage(r, request_hash, attempt, work):
    job = r['job']
    need(job['attemptId'] == r['attemptId'] and digest(canonical(job)) == r['jobSha256'], 'job-binding')
    need(0 < len(job['files']) <= 1024 and len(canonical(job)) <= 262144, 'job-budget')
    need(sum(f['sizeBytes'] for f in job['files'])+len(canonical(job))+4096 <= 2*1024**3, 'staged-tree-byte-budget')
    source = r['source']
    need(source['path'].startswith('/Library/Foundry/VM/sources/') and describe(source['path'], source['mountPoint']) == source, 'source-identity')
    tree = work / 'tree'
    tree.mkdir(mode=0o700)
    write_new(tree/'job.json', canonical(job))
    write_new(tree/'provenance.json', canonical({'version': 1, 'kind': 'stage', 'requestSha256': request_hash, 'jobSha256': r['jobSha256']}))
    root = secure(source['path'])
    try:
        total, names = 0, set()
        for file in job['files']:
            p = relative(file['path'])
            need(p.casefold() not in names and type(file['sizeBytes']) is int and 0 <= file['sizeBytes'] <= 64*1024**2, 'source-file')
            names.add(p.casefold())
            total += file['sizeBytes']
            need(total <= 2*1024**3, 'source-budget')
            fd = beneath(root, p)
            try:
                copy_fd(fd, mkdir_parent(tree, 'source/'+p), file['sizeBytes'], (file['sha256'], file['sizeBytes']))
            finally:
                os.close(fd)
    finally:
        os.close(root)
    need(describe(source['path'], source['mountPoint']) == source, 'source-postflight')
    return image_tree(work, tree, attempt/'input')


def intake(r, request_hash, attempt, work):
    output = r['output']
    need(output['path'] == str(attempt/'outputs.raw') and type(output['sizeBytes']) is int
         and 0 < output['sizeBytes'] <= MAX_RAW, 'raw-output-path-budget')
    # Ancestors are root-controlled; leaf belongs to the dedicated VM helper UID.
    fd = os.open(output['path'], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        s = os.fstat(fd)
        no_acl(fd)
        need(str(s.st_dev) == output['device'] and str(s.st_ino) == output['inode']
             and s.st_uid == output['uid'] and stat.S_IMODE(s.st_mode) == 0o600 and s.st_size == output['sizeBytes'], 'stopped-output-identity')
        raw_hash, _ = copy_fd(fd, work/'stopped.raw', MAX_RAW, (r['rawSha256'], output['sizeBytes']))
    finally:
        os.close(fd)
    # Never mount the live writable backing disk. This root-owned byte-for-byte
    # copy is immutable to the VM account and its digest is bound to stop intake.
    mounted = work/'raw'
    sync_dir(work)
    attach(work/'stopped.raw', mounted, raw=True)
    root = os.open(mounted, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    tree = work/'tree'
    tree.mkdir(mode=0o700)
    try:
        names = set()
        with os.scandir(root) as entries:
            for e in entries:
                need(len(names) < 16, 'raw-root-count')
                names.add(e.name)
        # These OS metadata names are outside the result envelope. Never traverse,
        # copy or execute their contents. All other undeclared root names refuse.
        required = {'files', 'result.json', 'build.log'}
        metadata_dirs = {'.fseventsd', '.Trashes', '.Spotlight-V100', '.TemporaryItems', '.DocumentRevisions-V100'}
        metadata_files = {'.metadata_never_index', '.DS_Store'}
        need(required <= names and names <= required | metadata_dirs | metadata_files, 'raw-root-shape')
        for name in names-required:
            info = os.stat(name, dir_fd=root, follow_symlinks=False)
            need(info.st_dev == os.fstat(root).st_dev and
                 (stat.S_ISDIR(info.st_mode) if name in metadata_dirs else stat.S_ISREG(info.st_mode) and info.st_nlink == 1), 'raw-metadata-type')
        pending = [('files', 0), ('result.json', 0), ('build.log', 0)]
        total, count = 0, 0
        while pending:
            p, depth = pending.pop()
            tick()
            count += 1
            need(count <= 20000 and depth <= 64, 'intake-entry-budget')
            fd = beneath(root, p)
            try:
                s = os.fstat(fd)
                target = 'payload/'+p[6:] if p.startswith('files/') else (
                    'payload' if p == 'files' else 'payload/.foundry-vm.log' if p == 'build.log' else p)
                if stat.S_ISDIR(s.st_mode):
                    need(p == 'files' or p.startswith('files/'), 'unexpected-directory')
                    # A placeholder path creates just the parents; no placeholder file.
                    mkdir_parent(tree, target+'/.unused')
                    with os.scandir(fd) as entries:
                        for e in entries:
                            need(len(pending)+count < 20000, 'intake-queue-budget')
                            pending.append((relative(p+'/'+e.name), depth+1))
                else:
                    need(p != 'files' and stat.S_ISREG(s.st_mode), 'intake-type')
                    _, size = copy_fd(fd, mkdir_parent(tree, target), min(MAX_TREE-total, 1048576 if p == 'result.json' else MAX_TREE),
                                      executable=p.startswith('files/') and bool(s.st_mode & 0o111))
                    total += size
                    need(total <= MAX_TREE, 'intake-byte-budget')
            finally:
                os.close(fd)
    finally:
        os.close(root)
    write_new(tree/'provenance.json', canonical({'version': 1, 'kind': 'intake', 'requestSha256': request_hash,
        'jobSha256': r['jobSha256'], 'rawSha256': raw_hash, 'output': output}))
    # Rehash the protected raw copy after extraction; no unprivileged writer can
    # alter it or rename the root-owned ancestors between these observations.
    fd = secure(work/'stopped.raw', file=True)
    try:
        need(hash_fd(fd, MAX_RAW) == raw_hash, 'raw-postflight')
    finally:
        os.close(fd)
    return image_tree(work, tree, attempt/'intake')


def main():
    global DEADLINE, LIB
    need(os.uname().sysname == 'Darwin' and os.getuid() == 0 and os.geteuid() == 0, 'owner-root-only')
    need(len(sys.argv) == 2 and re.fullmatch('[a-f0-9]{64}', sys.argv[1]), 'explicit-owner-request-hash-required')
    DEADLINE = time.monotonic()+1800
    LIB = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
    LIB.filesec_init.restype = ctypes.c_void_p
    LIB.filesec_free.argtypes = [ctypes.c_void_p]
    LIB.filesec_free.restype = None
    LIB.fstatx_np.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p]
    LIB.filesec_query_property.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
    LIB.filesec_get_property.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
    LIB.acl_get_entry.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
    LIB.acl_free.argtypes = [ctypes.c_void_p]
    os.umask(0o077)
    raw = read_request()
    need(0 < len(raw) <= 524288 and digest(raw) == sys.argv[1], 'request-hash-budget')
    r = decode(raw)
    common = {'version', 'kind', 'attemptId', 'guardSha256', 'jobSha256'}
    need(r['kind'] in ('stage', 'intake') and r['version'] == 1 and set(r) == common | (
        {'source', 'job'} if r['kind'] == 'stage' else {'output', 'rawSha256'}), 'request-shape')
    need(re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,63}', r['attemptId']), 'attempt-id')
    fd = secure(GUARD, file=True)
    try:
        need(hash_fd(fd, 32*1048576) == r['guardSha256'], 'guard-pin')
    finally:
        os.close(fd)
    attempt = BASE/r['attemptId']
    fd = secure(attempt)
    try:
        fs = os.fstatvfs(fd)
        extra = (r['output']['sizeBytes']+64*1048576) if r['kind'] == 'intake' else (
            sum(f['sizeBytes'] for f in r['job']['files'])*3+256*1048576)
        need(fs.f_bavail*fs.f_frsize >= 50*1024**3+extra, 'disk-headroom')
    finally:
        os.close(fd)
    # Persistent one-shot reservation BEFORE copying/mounting. Failed requests may
    # not be retried against the same attempt by silently overwriting evidence.
    work = attempt/('io-'+r['kind'])
    work.mkdir(mode=0o700)
    sync_dir(attempt)
    write_new(work/'request.json', raw)
    image_hash, tree = (stage if r['kind'] == 'stage' else intake)(r, digest(raw), attempt, work)
    receipt = canonical({'version': 1, 'kind': r['kind'], 'requestSha256': digest(raw), 'imageSha256': image_hash, 'tree': tree})
    write_new(work/'receipt.json', receipt)
    sync_dir(work)
    freeze_tree(work/'tree')
    # Dedicated worker may read only the public receipt; intermediate/raw tree
    # stays root-private. Provision this 0755 root-owned directory separately.
    receipts = attempt/'receipts'
    fd = secure(receipts)
    os.close(fd)
    temporary = receipts/(r['kind']+'.pending')
    write_new(temporary, receipt)
    # Atomic exclusive publication: a reader never sees a half-written receipt.
    LIB.renamex_np.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    LIB.renamex_np.restype = ctypes.c_int
    need(LIB.renamex_np(os.fsencode(temporary), os.fsencode(receipts/(r['kind']+'.json')), 0x00000004) == 0, 'receipt-exclusive-publish')
    sync_dir(receipts)
    # Keep raw mount and intermediate evidence. Cleanup is an independent gate.
    sys.stdout.buffer.write(receipt+b'\n')


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        sys.stderr.write('mac-vm-io: refused; retain attempt and mounts for owner review\n')
        sys.exit(1)

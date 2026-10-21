"""One-shot macOS guest boot runner. SOURCE ONLY; no installer or host execution.
Run only inside an owner-provisioned, secret-free, offline Foundry VM image.
The host must stop the entire VM before trusting any output for intake.
"""
import errno
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import selectors
import signal
import stat
import subprocess
import sys
import time

INPUT = Path('/Volumes/My Shared Files')
OUTPUT = Path('/Volumes/FoundryOutputs')
WORK = Path('/private/var/foundry/work')
BUILD_USER = 'foundry-build'
MAX_FILES = 8192
MAX_INPUT = 4 * 1024 ** 3
MAX_RESULT = 7 * 1024 ** 2


def require(ok, code):
    if not ok:
        raise ValueError(code)


def relative(value):
    require(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_./-]{1,240}', value)
            and not value.startswith(('/', '-')) and all(p not in ('', '.', '..') for p in value.split('/')), 'relative-path')
    return value


def token(value):
    require(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', value), 'recipe-token')
    return value


def input_read_only(path):
    """The input share must be read-only to the guest.

    The host shares it with VZSharedDirectory(readOnly: true), but a macOS 27
    guest does not report ST_RDONLY for that virtio-fs mount (observed
    2026-10-20: f_flag 2, writes refused with EPERM). So accept either the flag
    or proof by refusal: an exclusive create must fail with a write-protection
    error. If the probe is ever created, the share is writable: remove the
    probe and fail closed.
    """
    if os.statvfs(path).f_flag & os.ST_RDONLY:
        return True
    probe = path / ('.foundry-readonly-probe-' + os.urandom(8).hex())
    try:
        fd = os.open(probe, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except OSError as e:
        return e.errno in (errno.EROFS, errno.EPERM, errno.EACCES)
    os.close(fd)
    try:
        os.unlink(probe)
    except OSError:
        pass
    return False


def deadline_check(deadline):
    require(time.monotonic() < deadline, 'guest-deadline')


def open_directory(path):
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in Path(path).parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def open_beneath(root, path, directory=False):
    require(isinstance(path, str) and not path.startswith('/')
            and all(p not in ('', '.', '..') for p in path.split('/')), 'descriptor-path')
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
            require(os.fstat(fd).st_dev == device, 'nested-mount')
        return fd
    except BaseException:
        os.close(fd)
        raise


def stable(a, b):
    return (a.st_dev, a.st_ino, a.st_mode, a.st_nlink, a.st_size, a.st_mtime_ns, a.st_ctime_ns) == (
        b.st_dev, b.st_ino, b.st_mode, b.st_nlink, b.st_size, b.st_mtime_ns, b.st_ctime_ns)


def read_regular(root, path, maximum, deadline):
    fd = open_beneath(root, path)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
                and 0 <= before.st_size <= maximum, 'regular-file-budget')
        content = bytearray()
        while len(content) < before.st_size:
            deadline_check(deadline)
            chunk = os.read(fd, min(65536, before.st_size-len(content)))
            require(chunk, 'file-shrank')
            content.extend(chunk)
        require(not os.read(fd, 1) and stable(before, os.fstat(fd)), 'file-changed')
        return bytes(content)
    finally:
        os.close(fd)


def destination_parent(root, path):
    fd = os.dup(root)
    try:
        for part in path.split('/')[:-1]:
            try:
                os.mkdir(part, mode=0o700, dir_fd=fd)
            except FileExistsError:
                pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            st = os.fstat(child)
            require(st.st_uid == 0 and st.st_mode & 0o077 == 0, 'destination-owner')
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def copy_regular(source_root, path, destination_root, dest_path, maximum, deadline, expected=None, mode=0o600):
    src = open_beneath(source_root, path)
    parent = -1
    dest = -1
    try:
        before = os.fstat(src)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
                and 0 <= before.st_size <= maximum, 'copy-regular-budget')
        parent = destination_parent(destination_root, dest_path)
        dest = os.open(dest_path.split('/')[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=parent)
        digest = hashlib.sha256()
        copied = 0
        while copied < before.st_size:
            deadline_check(deadline)
            chunk = os.read(src, min(1024*1024, before.st_size-copied))
            require(chunk and copied+len(chunk) <= maximum, 'copy-size')
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                deadline_check(deadline)
                count = os.write(dest, view)
                require(count > 0, 'copy-write')
                view = view[count:]
            copied += len(chunk)
        require(not os.read(src, 1) and stable(before, os.fstat(src)), 'copy-source-changed')
        value = digest.hexdigest()
        if expected is not None:
            require((value, copied) == expected, 'copy-expected-content')
        os.fsync(dest)
        os.fsync(parent)
        deadline_check(deadline)
        return value, copied
    finally:
        os.close(src)
        if dest >= 0:
            os.close(dest)
        if parent >= 0:
            os.close(parent)


def capture(argv, cwd, env, deadline, maximum, preexec=None):
    deadline_check(deadline)
    proc = subprocess.Popen(argv, env=env, cwd=cwd, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True, preexec_fn=preexec)
    content, limited = bytearray(), False
    poller = selectors.DefaultSelector()
    poller.register(proc.stdout, selectors.EVENT_READ)
    os.set_blocking(proc.stdout.fileno(), False)
    try:
        while poller.get_map():
            if time.monotonic() >= deadline or len(content) >= maximum:
                limited = True
                break
            for key, _ in poller.select(min(0.1, max(0, deadline-time.monotonic()))):
                chunk = os.read(key.fd, min(65536, maximum-len(content)))
                if chunk:
                    content.extend(chunk)
                else:
                    poller.unregister(key.fileobj)
        if limited:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            code = proc.wait(timeout=max(0.1, deadline-time.monotonic()))
        except subprocess.TimeoutExpired:
            limited = True
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            code = proc.wait(timeout=10)
        return code, bytes(content), limited
    finally:
        poller.close()
        proc.stdout.close()


def fixed_command(exe, args, env, deadline):
    code, output, limited = capture([exe]+args, WORK, env, min(deadline, time.monotonic()+30), 65536)
    require(code == 0 and not limited, 'toolchain-observation')
    return output.decode('utf-8', errors='strict')


def write_json(path, data):
    payload = json.dumps(data, sort_keys=True, separators=(',', ':')).encode()
    require(len(payload) <= 1024 * 1024, 'receipt-budget')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as f:
            f.write(payload)
            f.flush()
            os.fsync(fd)
    finally:
        os.close(fd)
    parent = os.open(path.parent, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)


def run():
    started = time.monotonic()
    deadline = started + 3600
    require(os.getuid() == 0 and os.uname().machine == 'arm64', 'guest-root-arm64-only')
    require(INPUT.is_mount() and OUTPUT.is_mount() and input_read_only(INPUT), 'guest-volumes-required')
    require(not WORK.exists() and not (OUTPUT / 'result.json').exists(), 'guest-never-replay')
    input_fd = open_directory(INPUT)
    output_fd = open_directory(OUTPUT)
    output_stat = os.fstat(output_fd)
    require(output_stat.st_uid == 0 and output_stat.st_mode & 0o077 == 0, 'guest-output-private-root')
    raw = read_regular(input_fd, 'job.json', 262144, deadline)
    job = json.loads(raw)
    require(set(job) == {'version', 'identity', 'attemptId', 'jobId', 'profileHash', 'sourceHash', 'guestCapabilityHash', 'guestRunnerSha256', 'recipe', 'limits', 'files'}, 'job-shape')
    require(job['version'] == 2 and re.fullmatch(r'vm:[a-f0-9]{64}', job['identity']), 'job-version')
    for key in ('attemptId', 'jobId'):
        token(job[key])
    for key in ('profileHash', 'sourceHash', 'guestCapabilityHash', 'guestRunnerSha256'):
        require(re.fullmatch(r'[a-f0-9]{64}', job[key]), 'job-digest')
    runner_parent = open_directory(Path(__file__).resolve().parent)
    try:
        runner_sha = hashlib.sha256(read_regular(runner_parent, Path(__file__).name, 1048576, deadline)).hexdigest()
    finally:
        os.close(runner_parent)
    require(runner_sha == job['guestRunnerSha256'], 'guest-runner-pin')
    binding = json.dumps([job['jobId'], job['attemptId'], job['profileHash']], separators=(',', ':')).encode()
    require(job['identity'] == 'vm:'+hashlib.sha256(binding).hexdigest(), 'job-identity-binding')
    r, limits, files = job['recipe'], job['limits'], job['files']
    require(set(r) == {'developerDir', 'project', 'scheme', 'sdk', 'destination', 'configuration', 'xcodeBuild', 'macos', 'outputPaths'}, 'recipe-shape')
    require(set(limits) == {'cpu', 'timeoutMs', 'maxOutputBytes'}, 'limits-shape')
    require(type(limits['cpu']) is int and 1 <= limits['cpu'] <= 64
            and type(limits['timeoutMs']) is int and 1 <= limits['timeoutMs'] <= 3600000
            and type(limits['maxOutputBytes']) is int and 1 <= limits['maxOutputBytes'] <= MAX_RESULT, 'limits')
    deadline = min(deadline, started + limits['timeoutMs']/1000)
    require(isinstance(files, list) and 0 < len(files) <= MAX_FILES, 'input-count')
    require(r['configuration'] in ('Debug', 'Release')
            and re.fullmatch(r'/Applications/Xcode[^/]*\.app/Contents/Developer', r['developerDir'])
            and re.fullmatch(r'\d+(\.\d+){1,2}', r['macos']), 'guest-toolchain')
    for key in ('scheme', 'sdk', 'xcodeBuild'):
        token(r[key])
    require(re.fullmatch(r'(generic/platform=(iOS|macOS|iOS Simulator)|platform=macOS,arch=arm64)', r['destination']), 'guest-destination')
    relative(r['project'])
    require(r['project'].endswith(('.xcodeproj', '.xcworkspace')), 'project-kind')
    require(isinstance(r['outputPaths'], list) and 0 < len(r['outputPaths']) <= 24, 'outputs')
    for path in r['outputPaths']:
        relative(path)
    require(len(set(r['outputPaths'])) == len(r['outputPaths']), 'duplicate-output')
    user = pwd.getpwnam(BUILD_USER)
    require(user.pw_uid > 0 and user.pw_gid > 0, 'guest-build-user')
    WORK.mkdir(mode=0o700)
    for name in ('source', 'home', 'tmp', 'DerivedData', 'dependencies', 'modules', 'swift-modules'):
        p = WORK / name
        p.mkdir(mode=0o700)
    work_fd = open_directory(WORK)
    seen, total = set(), 0
    for entry in files:
        require(set(entry) == {'path', 'sha256', 'sizeBytes', 'mode'}, 'input-shape')
        path = relative(entry['path'])
        key = path.casefold()
        require(key not in seen and re.fullmatch(r'[a-f0-9]{64}', entry['sha256'])
                and type(entry['sizeBytes']) is int and 0 <= entry['sizeBytes'] <= 64 * 1024 ** 2
                and entry['mode'] in (0o600, 0o644, 0o700, 0o755), 'input-metadata')
        seen.add(key)
        total += entry['sizeBytes']
        require(total <= MAX_INPUT, 'input-total')
        copy_regular(input_fd, 'source/'+path, work_fd, 'source/'+path, entry['sizeBytes'], deadline,
                     (entry['sha256'], entry['sizeBytes']), entry['mode'])
    for parent, dirs, names in os.walk(WORK, followlinks=False):
        os.chown(parent, user.pw_uid, user.pw_gid)
        for name in names:
            os.chown(Path(parent) / name, user.pw_uid, user.pw_gid)
    env = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C', 'HOME': str(WORK / 'home'),
           'TMPDIR': str(WORK / 'tmp'), 'DEVELOPER_DIR': r['developerDir'],
           'CLANG_MODULE_CACHE_PATH': str(WORK / 'modules'), 'SWIFT_MODULECACHE_PATH': str(WORK / 'swift-modules')}
    exe = r['developerDir'] + '/usr/bin/xcodebuild'
    require('Build version ' + r['xcodeBuild'] in fixed_command(exe, ['-version'], env, deadline).splitlines(), 'xcode-build')
    sdks = fixed_command(exe, ['-showsdks'], env, deadline)
    require(r['sdk'] in re.findall(r'-sdk\s+([A-Za-z0-9_.-]+)', sdks), 'sdk')
    require(fixed_command('/usr/bin/sw_vers', ['-productVersion'], env, deadline).strip() == r['macos'], 'guest-macos')
    argv = [exe, '-workspace' if r['project'].endswith('.xcworkspace') else '-project', str(WORK / 'source' / r['project']),
            '-scheme', r['scheme'], '-configuration', r['configuration'], '-sdk', r['sdk'], '-destination', r['destination'],
            '-derivedDataPath', str(WORK / 'DerivedData'), '-clonedSourcePackagesDirPath', str(WORK / 'dependencies'),
            '-disableAutomaticPackageResolution', '-onlyUsePackageVersionsFromResolvedFile', '-skipPackageUpdates',
            '-jobs', str(limits['cpu']), 'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', 'CODE_SIGN_IDENTITY=',
            'DEVELOPMENT_TEAM=', 'COMPILER_INDEX_STORE_ENABLE=NO', 'build']
    def drop():
        os.setgroups([])
        os.setgid(user.pw_gid)
        os.setuid(user.pw_uid)
    code, log, limited = capture(argv, WORK / 'source', env, deadline, limits['maxOutputBytes'], drop)
    # Root collection is descriptor-relative, bounded, and never reopens checked
    # files by pathname. Descendants may still mutate guest data; reject unstable
    # bytes. Only host VZ whole-VM stop can close their execution lifetime.
    output_files, output_directories, used, visited, metadata_bytes = [], [], len(log), 0, 0
    for selected in r['outputPaths'] if code == 0 and not limited else []:
        pending = [(relative(selected), 0)]
        while pending:
            deadline_check(deadline)
            path, depth = pending.pop()
            visited += 1
            require(visited <= 20000 and depth <= 64 and len(path.encode()) <= 4096, 'output-tree-budget')
            fd = open_beneath(work_fd, path)
            try:
                st = os.fstat(fd)
                if stat.S_ISDIR(st.st_mode):
                    metadata_bytes += len(json.dumps(path).encode()) + 1
                    require(metadata_bytes <= 900*1024, 'receipt-metadata-budget')
                    output_directories.append(path)
                    # Preserve empty approved bundles/directories too. No marker
                    # file is written; parent creation is descriptor-relative.
                    created = destination_parent(output_fd, 'files/'+path+'/.unused')
                    os.close(created)
                    with os.scandir(fd) as entries:
                        for entry in entries:
                            deadline_check(deadline)
                            require(len(pending)+visited < 20000, 'output-entry-budget')
                            name = entry.name
                            require(name not in ('.', '..') and not any(ord(c) < 32 for c in name)
                                    and len(name.encode()) <= 255, 'output-name')
                            pending.append((path+'/'+name, depth+1))
                    continue
                require(stat.S_ISREG(st.st_mode) and st.st_nlink == 1, 'output-type')
            finally:
                os.close(fd)
            # Admit encoded receipt metadata BEFORE copying or retaining a row.
            # A 64-hex digest and maximum numeric size bound the eventual record.
            row_bound = len(json.dumps({'path': path, 'sha256': '0'*64, 'sizeBytes': MAX_RESULT, 'mode': 0o755},
                                       sort_keys=True, separators=(',', ':')).encode()) + 1
            require(metadata_bytes+row_bound <= 900*1024, 'receipt-metadata-budget')
            metadata_bytes += row_bound
            # Reopening through the anchored no-follow chain is safe even if a
            # directory changed: the checked/copy descriptor itself sets limits.
            file_mode = 0o755 if st.st_mode & 0o111 else 0o644
            actual, size = copy_regular(work_fd, path, output_fd, 'files/'+path,
                                        limits['maxOutputBytes']-used, deadline, mode=0o700 if file_mode == 0o755 else 0o600)
            used += size
            require(used <= limits['maxOutputBytes'], 'result-total')
            output_files.append({'path': path, 'sha256': actual, 'sizeBytes': size, 'mode': file_mode})
    deadline_check(deadline)
    with open(OUTPUT / 'build.log', 'xb') as f:
        f.write(log)
        f.flush()
        os.fsync(f.fileno())
    deadline_check(deadline)
    write_json(OUTPUT / 'result.json', {'version': 3, 'guestCapabilityHash': job['guestCapabilityHash'], 'guestRunnerSha256': runner_sha, 'identity': job['identity'], 'attemptId': job['attemptId'],
               'jobId': job['jobId'], 'profileHash': job['profileHash'], 'sourceHash': job['sourceHash'],
               'guestMacos': r['macos'], 'xcodeBuild': r['xcodeBuild'], 'exitCode': code, 'limited': limited,
               'outputs': output_files, 'directories': output_directories,
               'logSha256': hashlib.sha256(log).hexdigest(), 'logBytes': len(log)})
    os.close(work_fd)
    os.close(output_fd)
    os.close(input_fd)


def describe_capability(developer_dir):
    """Explicit later-approval guest inventory; never infer this from host Xcode.
    Owner combines these observed fields with the OFFLINE boot-image digest and
    reviewed installed host-helper digests into capability.json. No activation.
    """
    require(os.uname().sysname == 'Darwin' and os.uname().machine == 'arm64', 'guest-capability-platform')
    require(re.fullmatch(r'/Applications/Xcode[^/]*\.app/Contents/Developer', developer_dir), 'guest-capability-directory')
    env = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C', 'DEVELOPER_DIR': developer_dir}
    deadline = time.monotonic()+90
    def observe(exe, args):
        code, output, limited = capture([exe]+args, Path('/'), env, min(deadline, time.monotonic()+30), 65536)
        require(code == 0 and not limited, 'guest-capability-observation')
        return output.decode('utf-8', errors='strict')
    exe = developer_dir+'/usr/bin/xcodebuild'
    builds = re.findall(r'^Build version ([A-Za-z0-9_.-]+)$', observe(exe, ['-version']), re.M)
    require(len(builds) == 1, 'guest-capability-build')
    sdks = sorted(set(re.findall(r'-sdk\s+([A-Za-z0-9_.-]+)', observe(exe, ['-showsdks']))))
    require(0 < len(sdks) <= 64, 'guest-capability-sdks')
    macos = observe('/usr/bin/sw_vers', ['-productVersion']).strip()
    require(re.fullmatch(r'\d+(\.\d+){1,2}', macos), 'guest-capability-macos')
    parent = open_directory(Path(__file__).resolve().parent)
    try:
        runner_sha = hashlib.sha256(read_regular(parent, Path(__file__).name, 1048576, deadline)).hexdigest()
    finally:
        os.close(parent)
    return {'version': 1, 'kind': 'foundry-guest-observation', 'architecture': 'arm64', 'macos': macos,
            'developerDir': developer_dir, 'xcodeBuild': builds[0], 'sdks': sdks, 'guestRunnerSha256': runner_sha}


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--describe-capability':
        sys.stdout.write(json.dumps(describe_capability(sys.argv[2]), sort_keys=True, separators=(',', ':'))+'\n')
        sys.exit(0)
    require(len(sys.argv) == 1, 'guest-runner-arguments')
    try:
        run()
    except BaseException:
        # No exception/path/argv/source output: diagnostics never expose job content.
        try:
            write_json(OUTPUT / 'failure.json', {'version': 1, 'failure': 'guest-job-incomplete'})
        except BaseException:
            pass
    finally:
        subprocess.run(['/sbin/shutdown', '-h', 'now'], env={'PATH': '/usr/bin:/bin'},
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=False)

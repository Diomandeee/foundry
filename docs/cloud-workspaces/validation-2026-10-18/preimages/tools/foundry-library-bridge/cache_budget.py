"""Bounded metadata-only cache inventory and serialized admission; no deletion."""
import hashlib
import os
import re
import stat
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
try:
    import fcntl
except ImportError:
    fcntl = None

DEFAULT_CACHE_LIMIT = 20 * 1024**3
MAX_FILES = 4096
MAX_FILE_BYTES = 4 * 1024**3
ENTRY_ALLOWANCE = 4096
DISK_MARGIN = 64 * 1024**2
MANAGED_NAME = re.compile(r"(?:[0-9a-f]{64}\.tar\.gz|\.download-[a-z0-9_]{8})")


class CacheBudgetError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__("cache admission refused: " + code + "; no files removed")


def charged(info):
    blocks = getattr(info, "st_blocks", None)
    if type(blocks) is not int or blocks < 0 or info.st_size < 0:
        raise CacheBudgetError("capacity-unknown")
    # Charge logical bytes too: sparse/compressed/cloned storage never earns quota.
    return max(info.st_size, blocks * 512) + ENTRY_ALLOWANCE


def signature(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns,
            info.st_mode, info.st_uid, info.st_nlink, getattr(info, "st_blocks", None))


class CacheSession:
    def __init__(self, root, fd):
        self.root, self.fd = root, fd
        self.files = {}

    def check_root(self):
        for path in (self.root, *self.root.parents):
            if stat.S_ISLNK(path.lstat().st_mode):
                raise CacheBudgetError("unsafe-cache-root")
        current, opened = self.root.lstat(), os.fstat(self.fd)
        if ((current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino)
                or not stat.S_ISDIR(opened.st_mode) or opened.st_uid != os.geteuid()
                or opened.st_mode & 0o022):
            raise CacheBudgetError("unsafe-cache-root")
        return opened

    def scan(self):
        root = self.check_root()
        started = time.monotonic()
        files, payload, allocated, accounted, partials = {}, 0, 0, charged(root), 0
        with os.scandir(self.fd) as entries:
            for entry in entries:
                if len(files) >= MAX_FILES or time.monotonic() - started > 2:
                    raise CacheBudgetError("inventory-bound-exceeded")
                if not MANAGED_NAME.fullmatch(entry.name):
                    raise CacheBudgetError("unknown-cache-entry")
                info = entry.stat(follow_symlinks=False)
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                        or info.st_nlink != 1 or info.st_mode & 0o022 or info.st_size > MAX_FILE_BYTES):
                    raise CacheBudgetError("unsafe-cache-entry")
                accounted += charged(info)
                payload += info.st_size
                allocated += info.st_blocks * 512
                partials += entry.name.startswith(".download-")
                files[entry.name] = info
        capacity = os.fstatvfs(self.fd)
        if (type(capacity.f_frsize) is not int or capacity.f_frsize <= 0
                or type(capacity.f_bavail) is not int or capacity.f_bavail < 0):
            raise CacheBudgetError("capacity-unknown")
        for name, before in files.items():
            if time.monotonic() - started > 2:
                raise CacheBudgetError("inventory-bound-exceeded")
            if signature(before) != signature(os.stat(name, dir_fd=self.fd, follow_symlinks=False)):
                raise CacheBudgetError("cache-changing")
        if signature(root) != signature(self.check_root()):
            raise CacheBudgetError("cache-changing")
        if time.monotonic() - started > 2:
            raise CacheBudgetError("inventory-bound-exceeded")
        self.files = files
        return {"status": "observed", "observedAt": datetime.now(timezone.utc).isoformat(),
                "limitBytes": DEFAULT_CACHE_LIMIT, "accountedBytes": accounted,
                "managedPayloadBytes": payload, "managedAllocatedBytes": allocated,
                "managedFileCount": len(files), "partialFileCount": partials,
                "availableBudgetBytes": max(0, DEFAULT_CACHE_LIMIT - accounted),
                "filesystemFreeBytes": capacity.f_bavail * capacity.f_frsize,
                "allocationUnitBytes": max(ENTRY_ALLOWANCE, capacity.f_frsize),
                "reservedBytes": 0, "automaticCleanup": False}

    def admit(self, expected, new_file=True):
        if type(expected) is not int or not 0 <= expected <= MAX_FILE_BYTES:
            raise CacheBudgetError("invalid-cache-reservation")
        observation = self.scan()
        unit = observation["allocationUnitBytes"]
        reserve = ((expected + unit - 1) // unit) * unit + ENTRY_ALLOWANCE + unit if new_file else 0
        if new_file and observation["managedFileCount"] >= MAX_FILES:
            raise CacheBudgetError("inventory-bound-exceeded")
        if observation["accountedBytes"] + reserve > DEFAULT_CACHE_LIMIT:
            raise CacheBudgetError("cache-limit-exceeded")
        if observation["filesystemFreeBytes"] < reserve + DISK_MARGIN:
            raise CacheBudgetError("insufficient-disk-capacity")
        # The exclusive directory lock remains held through streaming and publication.
        return {**observation, "reservedBytes": reserve}

    def verified(self, name, expected, sha256):
        if not MANAGED_NAME.fullmatch(name):
            raise CacheBudgetError("unknown-cache-entry")
        self.check_root()
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fd)
        with os.fdopen(fd, "rb") as source:
            before = os.fstat(source.fileno())
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.geteuid()
                    or before.st_nlink != 1 or before.st_size != expected or before.st_mode & 0o022):
                return False
            checksum, size = hashlib.sha256(), 0
            while True:
                data = source.read(min(1024**2, expected - size + 1))
                if not data:
                    break
                size += len(data)
                if size > expected:
                    return False
                checksum.update(data)
            after = os.fstat(source.fileno())
        current = os.stat(name, dir_fd=self.fd, follow_symlinks=False)
        self.check_root()
        return (signature(before) == signature(after) == signature(current)
                and size == expected and checksum.hexdigest() == sha256)


class CacheBudget:
    def __init__(self, root):
        self.root = Path(os.path.abspath(root))

    @contextmanager
    def locked(self, exclusive=False):
        fd = None
        try:
            if fcntl is None:
                raise CacheBudgetError("cache-lock-unavailable")
            fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                fcntl.flock(fd, (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB)
            except BlockingIOError:
                raise CacheBudgetError("cache-busy") from None
            session = CacheSession(self.root, fd)
            session.check_root()
            yield session
        except OSError:
            raise CacheBudgetError("capacity-unknown") from None
        finally:
            if fd is not None:
                os.close(fd)

    def observe(self):
        try:
            with self.locked() as session:
                return session.scan()
        except CacheBudgetError as error:
            return self.unknown(error.code)
        except Exception:
            return self.unknown("capacity-unknown")

    @staticmethod
    def unknown(reason):
        return {"status": "unknown", "reason": reason,
                "observedAt": None, "limitBytes": DEFAULT_CACHE_LIMIT, "accountedBytes": None,
                "managedPayloadBytes": None, "managedAllocatedBytes": None,
                "managedFileCount": None, "partialFileCount": None,
                "availableBudgetBytes": None, "filesystemFreeBytes": None, "allocationUnitBytes": None,
                "reservedBytes": None, "automaticCleanup": False}


class BoundedDownload:
    """Refuse bytes beyond admission BEFORE writing them to disk."""
    def __init__(self, stream, expected):
        self.stream, self.expected, self.written = stream, expected, 0

    def write(self, data):
        if len(data) > self.expected - self.written:
            raise CacheBudgetError("download-reservation-exceeded")
        count = self.stream.write(data)
        self.written += count
        if count != len(data):
            raise CacheBudgetError("short-cache-write")
        return count

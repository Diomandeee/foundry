"""Restore one explicit version into a new workspace; never overlay a checkout."""
import ctypes
import hashlib
import json
import os
import shutil
import sys
import tarfile
import tempfile
import unicodedata
from collections import defaultdict
from pathlib import Path
from common import encode, safe_path


def publish_exclusive(stage, destination):
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        code = libc.renamex_np(os.fsencode(stage), os.fsencode(destination), ctypes.c_uint(4))
    elif sys.platform.startswith("linux") and hasattr(libc, "renameat2"):
        code = libc.renameat2(-100, os.fsencode(stage), -100, os.fsencode(destination), ctypes.c_uint(1))
    else:
        raise RuntimeError("atomic no-replace publication is unavailable on this OS")
    if code:
        raise OSError(ctypes.get_errno(), "workspace publication refused; staging preserved")


def no_symlink_parents(path):
    path = Path(os.path.abspath(path))
    for part in (path, *path.parents):
        if part.is_symlink():
            raise ValueError("workspace/cache parent must not be a symlink")
    return path


def write_verified(source, target, entry):
    checksum, total = hashlib.sha256(), 0
    while True:
        chunk = source.read(min(1024 * 1024, entry["bytes"] - total + 1))
        if not chunk:
            break
        total += len(chunk)
        if total > entry["bytes"]:
            raise ValueError("restored file exceeded declared size")
        checksum.update(chunk)
        target.write(chunk)
    if total != entry["bytes"] or checksum.hexdigest() != entry["sha256"]:
        raise ValueError("restored file SHA-256 mismatch")
    target.flush()
    os.fchmod(target.fileno(), entry["mode"])
    os.fsync(target.fileno())


def restore(catalog, project_id, version_id, destination, reader):
    project, version = catalog.version(project_id, version_id)
    if version["pullBlocked"]:
        raise ValueError("version requires path-conflict resolution before pull")
    reserved = unicodedata.normalize("NFD", ".foundry-workspace.json").casefold()
    if any(unicodedata.normalize("NFD", e["path"].split("/")[0]).casefold() == reserved for e in version["entries"]):
        raise ValueError("source collides with reserved workspace receipt")
    destination = no_symlink_parents(destination)
    if not destination.parent.is_dir() or destination.exists() or destination.is_symlink():
        raise ValueError("pull requires a new destination under an existing directory")
    if not (sys.platform == "darwin" or (sys.platform.startswith("linux") and hasattr(ctypes.CDLL(None), "renameat2"))):
        raise ValueError("no supported exclusive publication primitive")
    no_symlink_parents(reader.cache)
    grouped = defaultdict(list)
    for entry in version["entries"]:
        grouped[entry["archive"]].append(entry)
    refs = catalog.index["archives"]
    if hasattr(reader, "preflight"):
        reader.preflight([refs[a] for a in grouped])
    archive_bytes = sum(refs[a]["bytes"] for a in grouped)
    # Conservative: allow every required archive plus staged files and safety margin.
    needed = archive_bytes + version["bytes"] + 64 * 1024**2
    if shutil.disk_usage(destination.parent).free < needed:
        raise ValueError("insufficient workspace disk headroom for archives and staging")
    cache_parent = reader.cache
    while not cache_parent.exists():
        cache_parent = cache_parent.parent
    if shutil.disk_usage(cache_parent).free < archive_bytes + 64 * 1024**2:
        raise ValueError("insufficient archive cache disk headroom")
    stage = Path(tempfile.mkdtemp(prefix=".foundry-pull-", dir=destination.parent))
    published = False
    try:
        for archive_id, entries in grouped.items():
            archive = reader.fetch(refs[archive_id])
            with tarfile.open(archive, "r:gz") as tar:
                members = defaultdict(list)
                for member in tar:
                    members[member.name].append(member)
                    if len(tar.members) > 1000000:
                        raise ValueError("archive member bound exceeded")
                selected = defaultdict(list)
                headers = {}
                for entry in entries:
                    source = safe_path(entry["sourcePath"])
                    chain = set()
                    while True:
                        if source in chain or len(chain) > 1000 or len(members[source]) != 1:
                            raise ValueError("ambiguous or cyclic archive member")
                        chain.add(source)
                        header = members[source][0]
                        if header.isreg():
                            break
                        if not header.islnk():
                            raise ValueError("source member is not a regular file or internal hardlink")
                        source = safe_path(header.linkname)
                    if header.size != entry["bytes"]:
                        raise ValueError("source member size mismatch")
                    selected[header.offset_data].append(entry)
                    headers[header.offset_data] = header
                # A gzip reader can seek forward cheaply; arbitrary path order can
                # repeatedly rewind and decompress the entire prefix of the archive.
                for offset in sorted(selected):
                    first, *duplicates = selected[offset]
                    output = stage / first["path"]
                    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    # Keep the descriptor open for local duplicate reads even if
                    # the captured final permission removes filesystem read access.
                    with tar.extractfile(headers[offset]) as source_stream, output.open("x+b") as target:
                        write_verified(source_stream, target, first)
                        for duplicate in duplicates:
                            target.seek(0)
                            duplicate_path = stage / duplicate["path"]
                            duplicate_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                            with duplicate_path.open("xb") as duplicate_target:
                                write_verified(target, duplicate_target, duplicate)
        receipt = {"format": "foundry.workspace.v1", "catalogRevision": catalog.index["revision"],
                   "project": project_id, "version": version_id, "sourceMember": version["member"],
                   "files": version["files"], "bytes": version["bytes"],
                   "contentVerified": True, "canonicalPromotion": False,
                   "scope": catalog.index["scope"], "archives": {a: refs[a] for a in grouped}}
        with (stage / ".foundry-workspace.json").open("xb") as stream:
            stream.write(encode(receipt))
            stream.flush()
            os.fsync(stream.fileno())
        # Flush directory entries before publishing; file bytes were flushed above.
        for directory, _, _ in os.walk(stage, topdown=False):
            fd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        publish_exclusive(stage, destination)
        published = True
        fd = os.open(destination.parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        return {**receipt, "destination": str(destination)}
    except Exception as error:
        # Never erase a partially restored workspace or retry by overwriting it.
        detail = str(error) if isinstance(error, (ValueError, RuntimeError)) else type(error).__name__
        if published:
            raise RuntimeError("verified workspace published at " + str(destination)
                               + "; final directory durability acknowledgement failed: " + detail) from None
        raise RuntimeError("pull stopped; unpublished files retained at " + str(stage)
                           + "; reason: " + detail) from None

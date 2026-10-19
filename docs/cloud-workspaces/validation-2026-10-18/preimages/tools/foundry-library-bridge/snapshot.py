"""Explicit CLI-only local source snapshots. No upload or authority mutation."""
import hashlib
import json
import os
import stat
import tempfile
from pathlib import Path
from common import digest, encode, safe_path, validate_entries
from pull import no_symlink_parents, publish_exclusive
from readiness import reconstructability
from snapshot_policy import MAX_SOURCE_BYTES, screen_source, selection


def flush_directory(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def directory_owned(root):
    root = Path(root)
    for path in (root, *root.parents):
        info = path.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o022
                or info.st_uid not in ((os.geteuid(),) if path == root else (0, os.geteuid()))):
            raise ValueError("snapshot requires owned directories without links or unsafe write permissions")


def identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns,
            info.st_mode, info.st_uid, info.st_gid, info.st_nlink)


def refuse_source_destination(workspace, destination, root_identity):
    current = workspace.lstat()
    if (current.st_dev, current.st_ino) != root_identity:
        raise ValueError("snapshot source root identity changed")
    # Existing filesystem identities catch case/Unicode aliases that lexical
    # Path comparisons miss. Do this before any private staging is created.
    for ancestor in destination.parents:
        info = ancestor.lstat()
        if not stat.S_ISDIR(info.st_mode) or (info.st_dev, info.st_ino) == root_identity:
            raise ValueError("snapshot destination must be outside the source workspace")


def open_root(root):
    root = Path(root)
    fd = os.open(root.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for position, part in enumerate(root.parts[1:], 1):
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
            info = os.fstat(fd)
            owners = (os.geteuid(),) if position == len(root.parts) - 1 else (0, os.geteuid())
            if info.st_uid not in owners or info.st_mode & 0o022:
                raise ValueError("snapshot source directory ownership is unsafe")
        return fd
    except Exception:
        os.close(fd)
        raise


def open_source(root, name, missing_ok=False, root_identity=None):
    """Anchor every path component; concurrent symlink replacement cannot redirect reads."""
    safe_path(name)
    directory_owned(root)
    fd = open_root(root)
    try:
        root_info = os.fstat(fd)
        if root_info.st_uid != os.geteuid() or root_info.st_mode & 0o022:
            raise ValueError("snapshot source root ownership changed")
        if root_identity is not None and (root_info.st_dev, root_info.st_ino) != root_identity:
            raise ValueError("snapshot source root identity changed")
        parts = name.split("/")
        for part in parts[:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
            info = os.fstat(fd)
            if info.st_uid != os.geteuid() or info.st_mode & 0o022:
                raise ValueError("snapshot refuses unowned or writable source ancestors")
        leaf = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            info = os.fstat(leaf)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                    or info.st_nlink != 1 or info.st_mode & 0o7022):
                raise ValueError("snapshot refuses unowned, linked, special or unsafe source files")
            return leaf
        except Exception:
            os.close(leaf)
            raise
    except FileNotFoundError:
        if missing_ok:
            return None
        raise ValueError("snapshot explicitly selected source file is missing") from None
    finally:
        os.close(fd)


def snapshot(catalog, project_id, version_id, workspace, destination, metadata=None, include_new=None):
    project, base = catalog.version(project_id, version_id)
    assessment = reconstructability(catalog, project, base, metadata)
    if base["pullBlocked"] or base["kind"] != "assembled-copy":
        raise ValueError("snapshot requires an unblocked assembled source base")
    base_paths, added_paths = selection(base["entries"], include_new)
    selected_paths = base_paths | added_paths
    base_by_path = {entry["path"]: entry for entry in base["entries"]}
    workspace, destination = no_symlink_parents(workspace), no_symlink_parents(destination)
    if not workspace.is_dir() or not destination.parent.is_dir() or destination.exists() or destination.is_symlink():
        raise ValueError("snapshot requires existing workspace and new destination under existing parent")
    if workspace == destination or workspace in destination.parents:
        raise ValueError("snapshot destination must be outside workspace")
    directory_owned(workspace)
    directory_owned(destination.parent)
    root_info = workspace.lstat()
    root_identity = root_info.st_dev, root_info.st_ino
    refuse_source_destination(workspace, destination, root_identity)
    with os.fdopen(open_source(workspace, ".foundry-workspace.json", root_identity=root_identity), "rb") as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise ValueError("invalid base workspace receipt")
        raw = source.read(65537)
        if len(raw) > 65536:
            raise ValueError("invalid base workspace receipt")
    receipt = json.loads(raw)
    if (receipt.get("format") != "foundry.workspace.v1" or receipt.get("project") != project_id
            or receipt.get("version") != version_id or receipt.get("catalogRevision") != catalog.index["revision"]):
        raise ValueError("workspace receipt does not match explicit base revision")
    def inventory():
        found = {}
        # Never enumerate the workspace or discover unknown additions/history.
        for name in sorted(selected_paths):
            fd = open_source(workspace, name, missing_ok=name in base_paths, root_identity=root_identity)
            if fd is None:
                continue
            with os.fdopen(fd, "rb") as source:
                info = os.fstat(source.fileno())
                if info.st_size > MAX_SOURCE_BYTES:
                    raise ValueError("snapshot source text size bound exceeded")
                found[name] = identity(info)
        return found

    before = inventory()
    directory_owned(destination.parent)
    refuse_source_destination(workspace, destination, root_identity)
    stage = Path(tempfile.mkdtemp(prefix=".foundry-snapshot-", dir=destination.parent))
    published = False
    try:
        entries = []
        content = stage / "content"
        content.mkdir(mode=0o700)
        total = 0
        for name in sorted(before):
            info = before[name]
            if total + info[2] > 4 * 1024**3:
                raise ValueError("snapshot source size bound exceeded")
            fd = open_source(workspace, name, root_identity=root_identity)
            with os.fdopen(fd, "rb") as source:
                current = os.fstat(source.fileno())
                if identity(current) != info:
                    raise ValueError("workspace changed before capture")
                raw = source.read(MAX_SOURCE_BYTES + 1)
                if len(raw) != info[2] or identity(os.fstat(source.fileno())) != info:
                    raise ValueError("workspace changed during capture")
            # No candidate content reaches staging before whole-file screening.
            # Errors contain no matched path, value, line, snippet or digest.
            screen_source(raw)
            size, h = len(raw), hashlib.sha256(raw).hexdigest()
            target = content / name
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with target.open("xb") as output:
                output.write(raw)
                output.flush()
                os.fchmod(output.fileno(), 0o400)
                os.fsync(output.fileno())
            total += size
            mode = stat.S_IMODE(info[5])
            base_entry = base_by_path.get(name)
            change = ("added" if name in added_paths else "unchanged" if
                      (h, size, mode) == (base_entry["sha256"], base_entry["bytes"], base_entry["mode"]) else "modified")
            entries.append({"path": name, "bytes": size, "sha256": h, "mode": mode, "change": change})
        validate_entries(entries)
        if inventory() != before:
            raise ValueError("workspace changed during capture; retry with writers stopped")
        manifest = {"format": "foundry.local-snapshot.v1", "project": project_id,
                    "baseCatalogRevision": catalog.index["revision"], "baseVersion": version_id,
                    "baseEntriesSha256": digest(base["entries"]), "entries": entries,
                    "baseReconstructability": assessment,
                    "includedNewPaths": sorted(added_paths),
                    "addedEntries": [entry for entry in entries if entry["change"] == "added"],
                    "changedEntries": [entry for entry in entries if entry["change"] == "modified"],
                    "deletedPaths": sorted(base_paths - before.keys()),
                    "sourceSelection": "delivered-base-plus-explicit-added-files",
                    "capture": "stat-checked-non-atomic-selected-source",
                    "canonicalPromotion": False}
        snapshot_id = digest(manifest)
        descriptor = {"format": "foundry.snapshot-publication.v1", "status": "prepared-not-published",
                      "snapshotId": snapshot_id, "manifestSha256": snapshot_id, "object": None,
                      "publicationAuthorized": False,
                      "nextGate": "Owner approval, secret review, parent authority and real immutable publication receipt required."}
        for name, value in (("manifest.json", manifest), ("publication.prepared.json", descriptor)):
            with (stage / name).open("xb") as output:
                output.write(encode(value))
                output.flush()
                os.fchmod(output.fileno(), 0o400)
                os.fsync(output.fileno())
        for directory, _, _ in os.walk(stage, topdown=False):
            os.chmod(directory, 0o500)
            flush_directory(directory)
        publish_exclusive(stage, destination)
        published = True
        flush_directory(destination.parent)
        return {"snapshotId": snapshot_id, "destination": str(destination), "publicationAuthorized": False}
    except Exception:
        raise RuntimeError("snapshot published; directory acknowledgement failed" if published
                           else "snapshot stopped; private staging retained for operator review") from None

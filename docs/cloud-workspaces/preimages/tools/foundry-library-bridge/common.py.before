"""Fleet catalog format. No runtime service or credentials are created on import."""
import hashlib
import json
import re
import unicodedata
from pathlib import Path, PurePosixPath


def encode(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()


def digest(value):
    return hashlib.sha256(encode(value)).hexdigest()


def file_hash(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def safe_path(value):
    if (not isinstance(value, str) or not value or "\\" in value
            or any(ord(c) < 32 or ord(c) == 127 for c in value)):
        raise ValueError("invalid relative path")
    p = PurePosixPath(value)
    if p.is_absolute() or any(x in ("", ".", "..") for x in value.split("/")):
        raise ValueError("unsafe relative path")
    return value


def valid_hash(value):
    if not isinstance(value, str) or not re.fullmatch("[0-9a-f]{64}", value):
        raise ValueError("invalid SHA-256")
    return value


def validate_entries(entries):
    seen = {}
    files = set()
    for entry in entries:
        name = safe_path(entry["path"])
        if unicodedata.normalize("NFD", name.split("/")[0]).casefold() == ".foundry-workspace.json":
            raise ValueError("source collides with reserved workspace receipt")
        # Include implicit directories: A/x and a/y also collide on default macOS.
        parts = name.split("/")
        for n in range(1, len(parts) + 1):
            prefix = "/".join(parts[:n])
            key = unicodedata.normalize("NFD", prefix).casefold()
            if key in seen and seen[key] != prefix:
                raise ValueError("case/Unicode path collision")
            seen[key] = prefix
        if name in files:
            raise ValueError("duplicate destination path")
        files.add(name)
        valid_hash(entry["sha256"])
        if type(entry["bytes"]) is not int or not 0 <= entry["bytes"] <= 256 * 1024 * 1024:
            raise ValueError("invalid file size")
        if type(entry["mode"]) is not int or not 0 <= entry["mode"] <= 0o777:
            raise ValueError("invalid permission mode")
    for name in files:
        if any("/".join(name.split("/")[:i]) in files for i in range(1, len(name.split("/")))):
            raise ValueError("file/directory collision")


class Catalog:
    def __init__(self, root):
        self.root = Path(root).resolve(strict=True)
        self.index = json.loads((self.root / "catalog.json").read_text())
        body = dict(self.index)
        revision = body.pop("revision")
        if self.index["format"] != "foundry.fleet-catalog.v1" or digest(body) != valid_hash(revision):
            raise ValueError("catalog revision mismatch")
        self.projects = {p["id"]: p for p in self.index["projects"]}
        if len(self.projects) != len(self.index["projects"]):
            raise ValueError("duplicate project identity")

    def project(self, project_id):
        summary = self.projects[project_id]
        # Object name is a hash, never a browser-supplied filesystem path.
        h = valid_hash(summary["detailSha256"])
        raw = (self.root / "projects" / (h + ".json")).read_bytes()
        if hashlib.sha256(raw).hexdigest() != h:
            raise ValueError("project detail mismatch")
        project = json.loads(raw)
        if project["id"] != project_id:
            raise ValueError("project identity mismatch")
        return project

    def version(self, project_id, version_id):
        project = self.project(project_id)
        version = next(v for v in project["versions"] if v["id"] == version_id)
        body = {k: v for k, v in version.items() if k not in ("id", "pullBlocked")}
        if digest(body) != valid_hash(version_id):
            raise ValueError("version identity mismatch")
        validate_entries(version["entries"])
        return project, version

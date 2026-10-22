#!/usr/bin/env python3
"""repo-hygiene scan: read-only inventory of what a repo holds outside git.

Writes one inventory document (schema: schemas/inventory.v1.schema.json) and never
modifies the repo. Secret-risk content is detected but never copied into the output.

  scan.py <repo> [--out inventory.json] [--owner-map owners.json] [--lane <name>]

owners.json maps path prefixes to owner lanes: {"scripts/render": "air-deck-ableton-integration"}.
"""
import argparse
import ast
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys

SCHEMA = "foundry.repo-hygiene.inventory.v1"
GENERATED_DIRS = ("__pycache__", ".build", "build", "DerivedData", "node_modules", ".venv", "venv", "dist",
                  ".pytest_cache", ".mypy_cache", ".next", ".wrangler", ".swiftpm", "xcuserdata")
LOG_EXT = (".log", ".err", ".out", ".pid")
DATA_EXT = (".csv", ".parquet", ".npy", ".npz", ".pt", ".ckpt", ".safetensors", ".onnx", ".mp4", ".mov", ".wav",
            ".mp3", ".m4a", ".aiff", ".png", ".jpg", ".jpeg", ".heic", ".jsonl", ".sqlite", ".db", ".zip", ".tar",
            ".zst", ".gz", ".als", ".mlmodel", ".task", ".bin")
CODE_EXT = (".py", ".swift", ".ts", ".tsx", ".js", ".mjs", ".rs", ".go", ".sh", ".ps1", ".rb", ".kt", ".c", ".cc",
            ".cpp", ".h", ".hpp", ".m", ".mm", ".metal", ".sql", ".toml", ".yml", ".yaml", ".plist", ".xcconfig")
DOC_EXT = (".md", ".mdx", ".rst", ".txt", ".html")
SECRET_NAME = re.compile(r"(^|/)(\.env(\..*)?|.*\.p8|.*\.pem|.*\.key|id_[a-z0-9_]+|.*credentials.*\.json|.*service[-_]?account.*\.json|.*secrets?\.(json|ya?ml|toml))$", re.I)
SECRET_CONTENT = re.compile(
    r"(-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{16,}|"
    r"xox[abposr]-[A-Za-z0-9-]{10,}|ghp_[A-Za-z0-9]{30,}|AIza[0-9A-Za-z_-]{35}|"
    r"eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|"
    r"(?i:(api[_-]?key|secret|password|token)\s*[:=]\s*['\"][^'\"\s]{12,}['\"]))")
TEST_RE = re.compile(r"(^|/)(tests?|__tests__|spec|.*Tests?)/|(^|/)(test_[^/]+|[^/]+_test\.[a-z]+|[^/]+\.test\.[a-z]+|[^/]+Tests?\.swift)$")
FRONTMATTER = re.compile(r"\A---\n(.*?)\n---\n", re.S)


def git(repo, *args, check=True):
    r = subprocess.run(["git", "-C", repo, *args], capture_output=True)
    if check and r.returncode != 0:
        raise SystemExit(f"git {' '.join(args)} failed: {r.stderr.decode(errors='replace')[:400]}")
    return r.stdout


def status_entries(repo):
    """(state, path) from `git status --porcelain=v1 -z --untracked-files=all`. Renames give the new path."""
    raw = git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=no").split(b"\0")
    out, i = [], 0
    while i < len(raw):
        e = raw[i].decode(errors="surrogateescape")
        i += 1
        if not e:
            continue
        xy, path = e[:2], e[3:]
        if xy[0] in "RC":
            i += 1  # skip the old path
        if xy == "??":
            state = "untracked"
        elif "D" in xy:
            state = "deleted"
        elif "A" in xy:
            state = "added"
        else:
            state = "modified"
        out.append((state, path))
    return out


def classify(path, size, head):
    p = path.lower()
    parts = path.split("/")
    if SECRET_NAME.search(path) or (head is not None and SECRET_CONTENT.search(head)):
        return "secret-risk"
    if any(d in parts for d in GENERATED_DIRS) or p.endswith((".pyc", ".o", ".dSYM")):
        return "generated"
    if p.endswith(LOG_EXT) or "/logs/" in f"/{p}" or p.startswith("logs/"):
        return "log"
    if TEST_RE.search(path):
        return "test"
    if p.endswith(DOC_EXT):
        return "doc"
    if p.endswith(DATA_EXT) or (p.endswith(".json") and size > 256 * 1024):
        return "data"
    if p.endswith(CODE_EXT) or p.endswith(".json"):
        return "code"
    return "unknown"


def read_head(abspath, limit=262144):
    try:
        with open(abspath, "rb") as f:
            b = f.read(limit)
        if b"\0" in b[:8192]:
            return None  # binary
        return b.decode("utf-8", errors="replace")
    except OSError:
        return None


# ---------- "imported by tracked code?" ----------

def python_module_index(paths):
    """Map dotted module names (every suffix of the path) -> repo path, for .py files."""
    idx = {}
    for p in paths:
        if not p.endswith(".py"):
            continue
        parts = p[:-3].split("/")
        if parts[-1] == "__init__":
            parts = parts[:-1]
        for k in range(len(parts)):
            idx.setdefault(".".join(parts[k:]), set()).add(p)
    return idx


def python_imports(src, path):
    try:
        tree = ast.parse(src, filename=path)
    except (SyntaxError, ValueError):
        return set()
    mods = set()
    pkg = path.rsplit("/", 1)[0].replace("/", ".") if "/" in path else ""
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            mods.update(a.name for a in n.names)
        elif isinstance(n, ast.ImportFrom):
            base = n.module or ""
            if n.level:
                up = pkg.split(".")[: max(0, len(pkg.split(".")) - (n.level - 1))] if pkg else []
                base = ".".join([*up, base]).strip(".")
            mods.add(base)
            mods.update(f"{base}.{a.name}".strip(".") for a in n.names)
    return mods


def shell_refs(src):
    return set(re.findall(r"[\w./-]+\.(?:py|sh|ps1|swift|js|mjs|ts)\b", src))


def importers(repo, tracked, candidates):
    """For each candidate path: tracked files that import/invoke it."""
    cand_py = python_module_index([c for c in candidates if c.endswith(".py")])
    by_base = {}
    for c in candidates:
        by_base.setdefault(os.path.basename(c), set()).add(c)
    hits = {c: set() for c in candidates}
    for t in tracked:
        if not t.endswith((".py", ".sh", ".ps1", ".yml", ".yaml", ".toml", ".json", ".plist", ".swift", ".js", ".mjs", ".ts")):
            continue
        src = read_head(os.path.join(repo, t), limit=1 << 20)
        if not src:
            continue
        if t.endswith(".py"):
            for m in python_imports(src, t):
                for p in cand_py.get(m, ()):
                    hits[p].add(t)
        tdir = os.path.dirname(t)
        for ref in shell_refs(src):
            r = ref[2:] if ref.startswith("./") else ref
            for p in by_base.get(os.path.basename(r), ()):
                # a path-qualified reference must match the candidate's path suffix; a bare file name
                # only counts from a file in the same directory (else every generated copy matches)
                if ("/" in r and (p == r or p.endswith("/" + r))) or ("/" not in r and os.path.dirname(p) == tdir):
                    hits[p].add(t)
    return {c: sorted(v)[:20] for c, v in hits.items()}


def build_source_dirs(repo):
    """XcodeGen/SwiftPM source roots: an untracked .swift there is compiled into a tracked target."""
    roots = set()
    for y in git(repo, "ls-files", "*project.yml", "project.yml").decode().split("\n"):
        if not y:
            continue
        base = os.path.dirname(y)
        for m in re.findall(r"^\s*-\s*(?:path:\s*)?([A-Za-z0-9_./-]+)\s*$", read_head(os.path.join(repo, y)) or "", re.M):
            roots.add(os.path.normpath(os.path.join(base, m)))
    for pk in git(repo, "ls-files", "*Package.swift").decode().split("\n"):
        if pk:
            roots.add(os.path.normpath(os.path.join(os.path.dirname(pk), "Sources")))
    return sorted(r for r in roots if r and r != ".")


# ---------- docs, refs ----------

def doc_status(src):
    m = FRONTMATTER.match(src or "")
    if not m:
        return None
    fm = {}
    for line in m.group(1).split("\n"):
        if ":" in line and not line.startswith(" "):
            k, v = line.split(":", 1)
            fm[k.strip()] = v.strip().strip("'\"")
    st = fm.get("status")
    return {"status": st, "superseded_by": fm.get("superseded_by"), "describes": fm.get("describes")} if st else None


def dangling_refs(repo):
    out = []
    for line in git(repo, "for-each-ref", "--format=%(refname)%00%(objectname)").decode(errors="replace").split("\n"):
        if not line:
            continue
        ref, sha = line.split("\0")
        ok = subprocess.run(["git", "-C", repo, "cat-file", "-e", sha + "^{object}"], capture_output=True).returncode == 0
        if not ok:
            out.append({"ref": ref, "sha": sha})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("repo")
    ap.add_argument("--out")
    ap.add_argument("--owner-map")
    ap.add_argument("--lane", default=None)
    ap.add_argument("--allow-parent", action="store_true")
    a = ap.parse_args()
    repo = os.path.abspath(a.repo)
    top = git(repo, "rev-parse", "--show-toplevel").decode().strip()
    if os.path.realpath(top) != os.path.realpath(repo) and not a.allow_parent:
        # e.g. a build dir under $HOME when $HOME is itself a git repo: never inventory the parent by accident
        raise SystemExit(f"{repo} is not a repo root (git toplevel is {top}); pass the repo root or --allow-parent")
    owners = json.load(open(a.owner_map)) if a.owner_map else {}
    tracked = [p for p in git(top, "ls-files", "-z").decode(errors="surrogateescape").split("\0") if p]
    entries = status_entries(top)
    live = [p for s, p in entries if s != "deleted"]
    imp = importers(top, tracked, [p for s, p in entries if s == "untracked"])
    src_dirs = build_source_dirs(top)

    # the same file name in many untracked places = an output artifact some tool writes per run
    base_count = {}
    for s_, p_ in entries:
        if s_ == "untracked":
            base_count[os.path.basename(p_)] = base_count.get(os.path.basename(p_), 0) + 1
    items = []
    for state, path in entries:
        ab = os.path.join(top, path)
        st = os.stat(ab) if os.path.exists(ab) else None
        size = st.st_size if st else 0
        head = read_head(ab) if st and size <= 5 * 1024 * 1024 else None
        kind = classify(path, size, head)
        if state == "untracked" and kind in ("code", "unknown", "doc") and base_count.get(os.path.basename(path), 0) >= 5:
            kind = "generated"
        owner = next((v for k, v in sorted(owners.items(), key=lambda kv: -len(kv[0])) if path.startswith(k)), a.lane)
        it = {
            "path": path, "state": state, "kind": kind, "bytes": size,
            "last_modified": dt.datetime.fromtimestamp(st.st_mtime, dt.timezone.utc).isoformat(timespec="seconds") if st else None,
            "owner_lane": owner,
            "imported_by_tracked": imp.get(path, []),
            "in_build_source_dir": any(path.startswith(d + "/") for d in src_dirs) and path.endswith(".swift"),
        }
        if kind == "secret-risk":
            it["secret_reason"] = "name" if SECRET_NAME.search(path) else "content-pattern"
        if kind == "doc" and head:
            it["doc"] = doc_status(head)
        items.append(it)

    by = lambda key: {k: sum(1 for i in items if i[key] == k) for k in sorted({i[key] for i in items})}
    violations = [i["path"] for i in items if i["state"] == "untracked" and (i["imported_by_tracked"] or i["in_build_source_dir"])]
    tracked_docs = [p for p in tracked if p.lower().endswith((".md", ".mdx"))]
    docs_with_status = sum(1 for p in tracked_docs if doc_status(read_head(os.path.join(top, p), 8192)))
    inv = {
        "schema": SCHEMA,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "repo": {"path": top, "name": os.path.basename(top),
                 "head": git(top, "rev-parse", "HEAD", check=False).decode().strip() or None,
                 "branch": git(top, "branch", "--show-current", check=False).decode().strip() or None,
                 "remote": git(top, "remote", "get-url", "origin", check=False).decode().strip() or None},
        "summary": {"entries": len(items), "by_state": by("state"), "by_kind": by("kind"),
                    "untracked_imported_by_tracked": len(violations),
                    "docs_tracked": len(tracked_docs), "docs_with_status": docs_with_status,
                    "dangling_refs": None},
        "items": items,
        "dangling_refs": dangling_refs(top),
        "content_hash": None,
    }
    inv["summary"]["dangling_refs"] = len(inv["dangling_refs"])
    inv["content_hash"] = hashlib.sha256(json.dumps(inv["items"], sort_keys=True).encode()).hexdigest()
    out = json.dumps(inv, indent=1, sort_keys=False)
    if a.out:
        open(a.out, "w").write(out + "\n")
    else:
        print(out)
    s = inv["summary"]
    print(f"{inv['repo']['name']}: {s['entries']} entries {s['by_state']} kinds {s['by_kind']}; "
          f"untracked-but-imported {s['untracked_imported_by_tracked']}; dangling refs {s['dangling_refs']}; "
          f"docs with status {s['docs_with_status']}/{s['docs_tracked']}", file=sys.stderr)


if __name__ == "__main__":
    main()

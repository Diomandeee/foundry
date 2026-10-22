#!/usr/bin/env python3
"""Relevance boundary: the end-of-chunk check that keeps a repo's working tree honest.

  boundary.py check   <repo> [--baseline B.json] [--ledger L.json] [--mode enforce|ratchet|report] [--out receipt.json]
  boundary.py baseline <repo> --out B.json      # freeze today's violations so only NEW ones fail (ratchet)
  boundary.py ledger   <repo> --out L.json [--merge L.json]   # create/refresh the dangling-ref ledger

Rules (receipt schema: schemas/boundary-receipt.v1.schema.json):
  R1 untracked-but-used     an untracked file that tracked code imports/invokes, or an untracked .swift
                            inside a tracked target's source root. Must be committed (or the import removed).
  R2 generated/data/log     untracked generated, data or log paths must be .gitignored or moved to the data plane.
  R3 secret-risk            untracked files that look like secrets must be quarantined, never committed.
  R4 doc-status             tracked docs under docs/ or named *PLAN*/*ARCHITECTURE*/*STATUS* carry doc-status front matter.
  R5 doc-describes-changed  a doc marked current whose `describes` paths changed after its verified_commit is stale.
  R6 dangling-refs          every ref pointing at missing objects has a ledger entry.
Read-only: never modifies the repo.
"""
import argparse
import datetime as dt
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scan  # noqa: E402

DOC_HINT = ("PLAN", "ARCHITECTURE", "STATUS", "ROADMAP", "RUNBOOK", "CONTRACT", "PROGRAM")


def inventory(repo):
    import io, contextlib
    buf = io.StringIO()
    argv = sys.argv
    sys.argv = ["scan.py", repo]
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
            scan.main()
    finally:
        sys.argv = argv
    return json.loads(buf.getvalue())


def ignored(repo, paths):
    if not paths:
        return set()
    r = subprocess.run(["git", "-C", repo, "check-ignore", "--stdin", "-z"], input="\0".join(paths).encode(), capture_output=True)
    return {p for p in r.stdout.decode(errors="replace").split("\0") if p}


def needs_status(path):
    base = os.path.basename(path).upper()
    return path.lower().endswith((".md", ".mdx")) and (path.startswith("docs/") or any(h in base for h in DOC_HINT))


def rules(repo, inv, ledger):
    top = inv["repo"]["path"]
    items = inv["items"]
    unt = [i for i in items if i["state"] == "untracked"]
    r1 = sorted(i["path"] for i in unt if i["imported_by_tracked"] or i.get("in_build_source_dir"))
    gdl = [i["path"] for i in unt if i["kind"] in ("generated", "data", "log")]
    r2 = sorted(set(gdl) - ignored(top, gdl))
    r3 = sorted(i["path"] for i in unt if i["kind"] == "secret-risk")
    tracked = [p for p in scan.git(top, "ls-files", "-z").decode(errors="replace").split("\0") if p]
    r4, r5 = [], []
    for p in tracked:
        if not needs_status(p):
            continue
        st = scan.doc_status(scan.read_head(os.path.join(top, p), 8192))
        if not st:
            r4.append(p)
            continue
        if st["status"] == "current":
            fm = scan.read_head(os.path.join(top, p), 8192) or ""
            vc = next((l.split(":", 1)[1].strip() for l in fm.split("\n")[:40] if l.startswith("verified_commit:")), None)
            desc = [d.strip(" []'\"") for d in (st.get("describes") or "").split(",") if d.strip(" []'\"")]
            if vc and desc:
                ch = subprocess.run(["git", "-C", top, "diff", "--name-only", f"{vc}..HEAD", "--", *desc], capture_output=True)
                if ch.returncode == 0 and ch.stdout.strip():
                    r5.append(f"{p} (describes changed since {vc[:10]}: {len(ch.stdout.split())} files)")
            elif not desc:
                r4.append(p + " (current without describes)")
    known = {e["ref"] for e in (ledger or {}).get("entries", [])}
    r6 = sorted(d["ref"] for d in inv["dangling_refs"] if d["ref"] not in known)
    return [("R1-untracked-but-used", r1), ("R2-generated-or-data-not-ignored", r2), ("R3-secret-risk-untracked", r3),
            ("R4-doc-status", sorted(r4)), ("R5-doc-describes-changed", sorted(r5)), ("R6-dangling-refs-ledgered", r6)]


def cmd_check(a):
    inv = inventory(a.repo)
    ledger = json.load(open(a.ledger)) if a.ledger and os.path.exists(a.ledger) else None
    base = json.load(open(a.baseline)) if a.baseline and os.path.exists(a.baseline) else {}
    out = []
    for rid, v in rules(a.repo, inv, ledger):
        new = sorted(set(v) - set(base.get(rid, []))) if a.mode == "ratchet" else v
        ok = (not new) if a.mode != "report" else True
        out.append({"id": rid, "pass": ok, "violations": v, "new_violations": new})
    rc = {"schema": "foundry.repo-hygiene.boundary-receipt.v1", "repo": inv["repo"]["name"], "head": inv["repo"]["head"],
          "checked_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "lane": a.lane,
          "mode": a.mode, "pass": all(r["pass"] for r in out), "inventory_hash": inv["content_hash"], "rules": out}
    if a.out:
        json.dump(rc, open(a.out, "w"), indent=1)
    for r in out:
        print(f"{'PASS' if r['pass'] else 'FAIL'} {r['id']}: {len(r['violations'])} total, {len(r['new_violations'])} new"
              + ("".join(f"\n    {x}" for x in r["new_violations"][:8]) if not r["pass"] else ""))
    print(("BOUNDARY PASS" if rc["pass"] else "BOUNDARY FAIL") + f" ({a.mode}) {inv['repo']['name']} @ {str(inv['repo']['head'])[:10]}")
    return 0 if rc["pass"] else 1


def cmd_baseline(a):
    inv = inventory(a.repo)
    b = {rid: v for rid, v in rules(a.repo, inv, None)}
    b["_meta"] = {"repo": inv["repo"]["name"], "head": inv["repo"]["head"], "at": inv["generated_at"]}
    json.dump(b, open(a.out, "w"), indent=1)
    print("baseline:", {k: len(v) for k, v in b.items() if k != "_meta"})
    return 0


def cmd_ledger(a):
    inv = inventory(a.repo)
    old = json.load(open(a.merge)) if a.merge and os.path.exists(a.merge) else {"entries": []}
    have = {e["ref"]: e for e in old["entries"]}
    now = inv["generated_at"]
    for d in inv["dangling_refs"]:
        have.setdefault(d["ref"], {"ref": d["ref"], "sha": d["sha"], "first_seen": now, "cause": None,
                                   "recovery_status": "unchecked", "source": None, "recovered_as": None,
                                   "checked_by": None, "checked_at": None, "note": None})
    led = {"schema": "foundry.repo-hygiene.ref-ledger.v1", "repo": inv["repo"]["name"], "entries": sorted(have.values(), key=lambda e: e["ref"])}
    json.dump(led, open(a.out, "w"), indent=1)
    from collections import Counter
    print("ledger:", len(led["entries"]), dict(Counter(e["recovery_status"] for e in led["entries"])))
    return 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check"); c.add_argument("repo"); c.add_argument("--baseline"); c.add_argument("--ledger")
    c.add_argument("--mode", default="ratchet", choices=["enforce", "ratchet", "report"]); c.add_argument("--out"); c.add_argument("--lane")
    b = sub.add_parser("baseline"); b.add_argument("repo"); b.add_argument("--out", required=True)
    l = sub.add_parser("ledger"); l.add_argument("repo"); l.add_argument("--out", required=True); l.add_argument("--merge")
    a = ap.parse_args()
    return {"check": cmd_check, "baseline": cmd_baseline, "ledger": cmd_ledger}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())

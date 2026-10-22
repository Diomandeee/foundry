#!/usr/bin/env python3
"""Onboard app-fleet registry records into Foundry bases.

Dry run (default): for each selected record, read the GitHub tree of the default branch
(no clone), apply the gate's admissibility rules (text-only, 4 MiB per file, 8 MiB per
merge) and print the plan: create / seed / subscribe / audit, plus the files that would
have to move to a Drive bundle. Writes one receipt per repo under receipts/app-fleet/.

Apply (--apply): clone, strip the offenders into a bundle dir, create the Artifacts repo,
FOUNDRY_SEED push, subscribe, and write foundry_base back into the registry. --apply
refuses to run without --namespace and without Mohamed's go recorded in --approved-by.

No secret is read or printed here. Tokens are minted by foundry-push / wrangler themselves.
"""
import argparse, json, os, pathlib, subprocess, sys, datetime, re, shutil

BIN_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".pdf", ".zip", ".tar", ".gz", ".zst",
           ".mp4", ".mov", ".m4a", ".mp3", ".wav", ".aif", ".aiff", ".als", ".amxd", ".ttf", ".otf",
           ".woff", ".woff2", ".icns", ".car", ".mlmodel", ".mlmodelc", ".mlpackage", ".safetensors",
           ".bin", ".pt", ".pth", ".onnx", ".npy", ".npz", ".sqlite", ".db", ".realm", ".a", ".dylib",
           ".framework", ".xcframework", ".ipa", ".app", ".dmg", ".pkg", ".jar", ".class", ".wasm",
           ".psd", ".ai", ".sketch", ".fig", ".blend", ".fbx", ".obj", ".usdz", ".glb", ".gltf", ".ply"}
PER_FILE = 4 * 1024 * 1024
PER_MERGE = 8 * 1024 * 1024
FOUNDRY_BIN = pathlib.Path.home() / ".config/foundry/bin"
LOCKFIX = pathlib.Path(__file__).resolve().parents[2]


def gh_json(args):
    out = subprocess.run(["gh", "api", *args], capture_output=True, text=True)
    if out.returncode != 0:
        return None, out.stderr.strip()[:200]
    return json.loads(out.stdout), None


def tree(owner_repo, seed_branch=None):
    meta, err = gh_json([f"repos/{owner_repo}"])
    if err:
        return None, None, err
    # A record's seed_branch names the live trunk when GitHub's default branch is stale
    # (MotionMix: main last moved 2026-04, the work lives on an unrelated branch).
    branch = seed_branch or meta.get("default_branch", "main")
    t, err = gh_json([f"repos/{owner_repo}/git/trees/{branch}?recursive=1"])
    if err:
        return branch, None, err
    return branch, t, None


def lint(entries):
    offenders, text_bytes, n = [], 0, 0
    for e in entries:
        if e.get("type") != "blob":
            continue
        n += 1
        p, size = e["path"], e.get("size", 0)
        ext = os.path.splitext(p)[1].lower()
        if ext in BIN_EXT or "/.xcassets/" in p and ext == ".png" or size > PER_FILE:
            offenders.append({"path": p, "bytes": size, "why": "binary-ext" if ext in BIN_EXT else "over-4MiB"})
        else:
            text_bytes += size
    return n, text_bytes, offenders


def plan_record(rec, namespace):
    origin = rec.get("origin")
    if not origin:
        return {"id": rec["id"], "skip": "no GitHub origin"}
    owner_repo = re.sub(r"^https://github.com/", "", origin).rstrip("/")
    base = re.sub(r"[^A-Za-z0-9._-]", "-", rec["title"]).lower()[:64]
    branch, t, err = tree(owner_repo, rec.get("seed_branch"))
    if err:
        return {"id": rec["id"], "skip": f"github: {err}"}
    n, text_bytes, offenders = lint(t.get("tree", []))
    return {
        "id": rec["id"], "title": rec["title"], "tier": rec["tier"], "origin": origin,
        "default_branch": branch, "truncated_tree": t.get("truncated", False),
        "files": n, "text_bytes": text_bytes, "offenders": offenders,
        "base": base, "namespace": namespace,
        "steps": [
            f"npx wrangler artifacts repos create {base} --namespace {namespace}",
            f"FOUNDRY_SEED={base} {FOUNDRY_BIN}/foundry-push {base} {branch}:main   (from a clean clone minus offenders)",
            f"bash tools/subscribe-repo.sh staging {base}",
            f"registry: foundry_base={base}; audit list reads registry",
        ],
        "bundle": f"gdrive:Assets/app-fleet/{base}/" if offenders else None,
        "first_merge_fits_gate": text_bytes <= PER_MERGE,
    }


SOURCE = LOCKFIX.parent / "source"


def sh(cmd, cwd=None, check=True, env=None):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, env=env)
    if check and r.returncode != 0:
        raise RuntimeError(f"{' '.join(map(str, cmd))}: rc={r.returncode} {r.stderr.strip()[:300]}")
    return r


def seed_one(rec, plan, a):
    """One text-only orphan commit per base. Binaries are stripped and listed in .foundry/assets.json
    (path, bytes, sha256) pointing at the GitHub origin commit, which keeps the full tree."""
    import hashlib
    base, branch = plan["base"], plan["default_branch"]
    work = pathlib.Path(a.work); work.mkdir(parents=True, exist_ok=True)
    src = work / f"{base}.src"; snap = work / f"{base}.seed"
    for d in (src, snap):
        shutil.rmtree(d, ignore_errors=True)
    sh(["git", "clone", "--quiet", "--depth", "1", "--branch", branch, rec["origin"], str(src)])
    origin_sha = sh(["git", "rev-parse", "HEAD"], cwd=src).stdout.strip()
    offenders = {o["path"] for o in plan["offenders"]}
    assets = []
    snap.mkdir()
    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d != ".git"]
        for f in files:
            full = pathlib.Path(root, f); rel = str(full.relative_to(src))
            if full.is_symlink():
                continue
            data = full.read_bytes()
            is_text = True
            try:
                data.decode("utf-8")
            except UnicodeDecodeError:
                is_text = False
            if rel in offenders or not is_text or len(data) > PER_FILE:
                assets.append({"path": rel, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
                continue
            dst = snap / rel; dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(full, dst); shutil.copymode(full, dst)
    (snap / ".foundry").mkdir(exist_ok=True)
    (snap / ".foundry/assets.json").write_text(json.dumps({"format": "foundry.assets.v1", "origin": rec["origin"],
        "origin_commit": origin_sha, "origin_branch": branch, "stripped": assets}, indent=1))
    (snap / "FOUNDRY-SEED.md").write_text(f"# Foundry seed\n\nSeeded from {rec['origin']} at `{origin_sha}` ({branch}) on "
        f"{datetime.datetime.now(datetime.timezone.utc).date()} by the app-fleet lane. One text-only commit; "
        f"{len(assets)} binary or oversized files are listed in `.foundry/assets.json` and stay on the origin commit.\n")
    env = {**os.environ, "GIT_AUTHOR_NAME": "app-fleet seed", "GIT_AUTHOR_EMAIL": "fleet@local",
           "GIT_COMMITTER_NAME": "app-fleet seed", "GIT_COMMITTER_EMAIL": "fleet@local"}
    sh(["git", "init", "--quiet", "-b", "main"], cwd=snap, env=env)
    sh(["git", "add", "-A"], cwd=snap, env=env)
    sh(["git", "commit", "--quiet", "-m", f"seed {base} from {rec['origin']}@{origin_sha[:12]}"], cwd=snap, env=env)
    seed_sha = sh(["git", "rev-parse", "HEAD"], cwd=snap).stdout.strip()
    n_files = int(sh(["git", "ls-files"], cwd=snap).stdout.count("\n"))
    cr = sh(["npx", "wrangler", "artifacts", "repos", "create", base, "--namespace", a.namespace], cwd=SOURCE, check=False)
    created = cr.returncode == 0
    if not created:
        # Never push a seed onto a base someone else created: that would be a second ungated commit.
        raise RuntimeError(f"repos create {base} refused (exists or error), not seeding: {(cr.stderr or cr.stdout).strip()[:160]}")
    sh([str(FOUNDRY_BIN / "foundry-push"), base, "main:main"], cwd=snap, env={**env, "FOUNDRY_SEED": base})
    sub = sh(["bash", "tools/subscribe-repo.sh", "staging", base], cwd=LOCKFIX, check=False)
    shutil.rmtree(src, ignore_errors=True)
    return {"base": base, "origin_commit": origin_sha, "seed_commit": seed_sha, "files": n_files,
            "stripped": len(assets), "created": created, "subscribed": sub.stdout.strip()[:120], "namespace": a.namespace}


def write_back(registry, rec_id, fields):
    """Re-read the registry under an exclusive lock and update only this record, so two lanes
    seeding at once never wipe each other's foundry_base (supervisor's write race, 2026-10-22)."""
    import fcntl
    lock = pathlib.Path(str(registry) + ".lock")
    with open(lock, "w") as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        reg = json.load(open(registry))
        for rec in reg["records"]:
            if rec["id"] == rec_id:
                rec.update(fields); break
        tmp = pathlib.Path(str(registry) + ".tmp"); tmp.write_text(json.dumps(reg, indent=1)); tmp.replace(registry)
        fcntl.flock(lf, fcntl.LOCK_UN)


def apply(sel, a):
    reg = json.load(open(a.registry)); by_id = {r["id"]: r for r in reg["records"]}
    rec_dir = pathlib.Path(a.receipts); rec_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    log = {"approved_by": a.approved_by, "started": ts, "namespace": a.namespace, "results": []}
    for r in sel:
        p = plan_record(r, a.namespace)
        if "skip" in p:
            log["results"].append({"id": r["id"], "skipped": p["skip"]}); print(f"SKIP {r['id']}: {p['skip']}"); continue
        if a.only_clean and p["offenders"]:
            log["results"].append({"id": r["id"], "skipped": f"{len(p['offenders'])} binaries, --only-clean"}); continue
        if p["files"] - len(p["offenders"]) > a.max_files:
            log["results"].append({"id": r["id"], "skipped": f"{p['files']} files > gate limit {a.max_files}"})
            print(f"SKIP {r['id']}: {p['files']} files exceeds gate limit"); continue
        try:
            res = seed_one(r, p, a)
            write_back(a.registry, r["id"], {"foundry_base": res["base"], "foundry_seed": res})
            log["results"].append({"id": r["id"], **res})
            print(f"SEEDED {r['id']:<30} base={res['base']} files={res['files']} stripped={res['stripped']} seed={res['seed_commit'][:8]}")
        except Exception as e:
            log["results"].append({"id": r["id"], "error": str(e)[:400]}); print(f"ERROR  {r['id']}: {str(e)[:200]}")
        (rec_dir / f"seed.{ts}.json").write_text(json.dumps(log, indent=1))
    ok = sum(1 for x in log["results"] if "seed_commit" in x)
    print(f"\nseeded {ok}, skipped {sum(1 for x in log['results'] if 'skipped' in x)}, errors {sum(1 for x in log['results'] if 'error' in x)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--registry", default=str(LOCKFIX / "docs/app-fleet/apps.v1.json"))
    ap.add_argument("--tiers", default="hot,warm")
    ap.add_argument("--ids", default=None, help="comma list of registry ids (overrides --tiers)")
    ap.add_argument("--namespace", default="foundry-staging")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--approved-by", default=None, help="literal words from Mohamed authorising --apply")
    ap.add_argument("--receipts", default=str(LOCKFIX / "receipts/app-fleet"))
    ap.add_argument("--skip", default="", help="comma list of registry ids to leave to another lane")
    ap.add_argument("--max-files", type=int, default=2000, help="gate tree limit (review M7); bigger repos are reported, not seeded")
    ap.add_argument("--work", default=str(pathlib.Path(os.environ.get("TMPDIR", "/tmp")) / "app-fleet-seed"))
    ap.add_argument("--only-clean", action="store_true", help="seed only repos with no binaries to strip")
    a = ap.parse_args()

    reg = json.load(open(a.registry))
    recs = reg["records"]
    if a.ids:
        want = set(a.ids.split(","))
        sel = [r for r in recs if r["id"] in want]
    else:
        tiers = set(a.tiers.split(","))
        sel = [r for r in recs if r["tier"] in tiers and r.get("origin") and not r.get("foundry_base")]

    if a.apply:
        if not a.approved_by:
            sys.exit("REFUSED: --apply needs --approved-by with Mohamed's words")
        skip = set(x for x in a.skip.split(",") if x)
        sel = [r for r in sel if r["id"] not in skip]
        return apply(sel, a)

    pathlib.Path(a.receipts).mkdir(parents=True, exist_ok=True)
    plans = []
    for r in sel:
        p = plan_record(r, a.namespace)
        plans.append(p)
        pathlib.Path(a.receipts, f"{r['id']}.dry-run.json").write_text(json.dumps(p, indent=1))
        if "skip" in p:
            print(f"SKIP  {r['id']:<34} {p['skip']}")
        else:
            off = len(p["offenders"]); ob = sum(o["bytes"] for o in p["offenders"])
            flag = "" if p["first_merge_fits_gate"] else "  TEXT>8MiB"
            print(f"{p['tier']:<4} {r['id']:<34} files={p['files']:<6} text={p['text_bytes']/1e6:6.1f}MB "
                  f"binaries={off:<4} ({ob/1e6:6.1f}MB){flag}{'  TRUNC' if p['truncated_tree'] else ''}")
    ok = [p for p in plans if "skip" not in p]
    print(f"\n{len(ok)} plannable, {len(plans)-len(ok)} skipped; "
          f"{sum(1 for p in ok if p['offenders'])} need a Drive bundle; "
          f"{sum(1 for p in ok if not p['first_merge_fits_gate'])} exceed 8 MiB text (seed bypasses, later merges will not)")
    summary = {"built_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
               "namespace": a.namespace, "selected": len(sel), "plans": plans}
    pathlib.Path(a.receipts, "_summary.dry-run.json").write_text(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()

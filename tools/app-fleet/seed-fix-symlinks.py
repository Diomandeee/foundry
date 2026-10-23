#!/usr/bin/env python3
"""Record symlinks that early seeds dropped, through the gate.

Seeds made by onboard.py before cf52461 skipped symlinks without listing them in
.foundry/assets.json, so a lane's GitHub-mirror check (LANDING-ON-A-SEEDED-BASE.md step 5)
sees them as unexplained differences. For each selected registry record this reads the
symlinks (mode 120000) of the seed's origin commit from GitHub, compares them with the base's
assets.json, and, with --apply, lands the missing entries as one gate task per base:
open task -> subscribe fork -> push -> wait for the verdict -> delete the fork on MERGE.

Dry run by default. Task files are 0600 and read through a field allowlist; the fork's write
token is never printed. A base that already lists every symlink is left alone.
"""
import argparse, base64, json, os, pathlib, re, subprocess, sys, tempfile, time

LOCKFIX = pathlib.Path(__file__).resolve().parents[2]
SOURCE = pathlib.Path.home() / "Developer/foundry-integration/source"
FOUNDRY_BIN = pathlib.Path.home() / ".config/foundry/bin"
ORCH = "https://foundry-orchestrator-staging.motionmix-participation.workers.dev"
AGENT = "claude-seedfix"
GIT_ID = ["-c", "user.name=app-fleet seed-fix", "-c", "user.email=fleet@local"]


def sh(cmd, cwd=None, check=True, env=None):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, env=env)
    if check and r.returncode:
        raise RuntimeError(f"{cmd[0]} {cmd[1] if len(cmd) > 1 else ''} failed: {(r.stderr or r.stdout).strip()[:200]}")
    return r


def gh(path):
    return json.loads(sh(["gh", "api", path]).stdout)


def origin_symlinks(origin, commit):
    owner_repo = re.sub(r"^https://github.com/", "", origin).rstrip("/")
    tree = gh(f"repos/{owner_repo}/git/trees/{commit}?recursive=1")
    if tree.get("truncated"):
        raise RuntimeError("GitHub tree truncated; cannot prove the symlink list complete")
    links = {}
    for e in tree["tree"]:
        if e.get("mode") == "120000":
            blob = gh(f"repos/{owner_repo}/git/blobs/{e['sha']}")
            links[e["path"]] = base64.b64decode(blob["content"]).decode("utf-8", "surrogateescape")
    return links


def decision(task_id):
    out = sh(["npx", "wrangler", "d1", "execute", "foundry-decisions-staging", "--remote", "--json", "--command",
              f"select id,verdict,reason,merged_sha from decisions where task_id='{task_id}' order by id desc limit 1"],
             cwd=SOURCE).stdout
    rows = json.loads(out)[0]["results"]
    return rows[0] if rows else None


def fix_one(rec, a, work):
    base, seed = rec["foundry_base"], rec["foundry_seed"]
    links = origin_symlinks(rec["origin"], seed["origin_commit"])
    if not links:
        return {"id": rec["id"], "base": base, "result": "no symlinks at origin"}
    d = work / base
    sh(["git", "init", "-q", "-b", "land", str(d)])
    sh([str(FOUNDRY_BIN / "foundry-fetch"), base, "+main:refs/remotes/foundry/main"], cwd=d)
    sh(["git", "checkout", "-q", "-B", "land", "foundry/main"], cwd=d)
    ap = d / ".foundry/assets.json"
    assets = json.loads(ap.read_text())
    listed = {x["path"] for x in assets.get("stripped", [])}
    missing = {p: t for p, t in links.items() if p not in listed}
    if not missing:
        return {"id": rec["id"], "base": base, "result": "already complete", "symlinks": len(links)}
    if not a.apply:
        return {"id": rec["id"], "base": base, "result": "would add", "missing": sorted(missing)}
    assets["stripped"] += [{"path": p, "symlink": t} for p, t in sorted(missing.items())]
    ap.write_text(json.dumps(assets, indent=1))
    task = f"seedfix-symlinks-{base}"[:60].rstrip("-.")
    sh(["git", *GIT_ID, "commit", "-q", "-am", f"seed-fix: list {len(missing)} symlinks in .foundry/assets.json"], cwd=d)
    tf = pathlib.Path.home() / f".config/foundry/task-{task}.json"
    old = os.umask(0o077)
    try:
        body = json.dumps({"baseRepo": base, "taskId": task, "agents": [AGENT], "allowedRoots": [".foundry/assets.json"]})
        tok = (pathlib.Path.home() / ".config/foundry/staging-task-token").read_text().strip()
        r = subprocess.run(["curl", "-s", "-X", "POST", f"{ORCH}/tasks", "-H", "content-type: application/json",
                            "-H", "@-", "-d", body], input=f"authorization: Bearer {tok}\n", capture_output=True, text=True)
        tf.write_text(r.stdout)
    finally:
        os.umask(old)
    t = json.loads(tf.read_text())
    forks = [x.get("forkRepo") for x in t.get("dispatches", [])]
    if t.get("baseRepo") != base or len(forks) != 1:
        raise RuntimeError(f"task not opened for {base}: {t.get('error') or 'no dispatch'}")
    fork = forks[0]
    sh(["bash", "tools/subscribe-repo.sh", "staging", fork], cwd=SOURCE)
    sh(["git", *GIT_ID, "commit", "-q", "--amend", "--no-edit", "--date=now"], cwd=d)
    sh([str(FOUNDRY_BIN / "foundry-push"), fork, "land:main"], cwd=d)
    row = None
    for _ in range(24):
        time.sleep(10)
        row = decision(task)
        if row:
            break
    res = {"id": rec["id"], "base": base, "task": task, "added": sorted(missing), "decision": row}
    if row and row["verdict"] == "merge":
        sh(["npx", "wrangler", "artifacts", "repos", "delete", fork, "--namespace", "foundry-staging", "--force"], cwd=SOURCE)
        tf.unlink(missing_ok=True)
        res["fork_deleted"] = True
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--registry", default=str(LOCKFIX / "docs/app-fleet/apps.v1.json"))
    ap.add_argument("--ids", help="comma list; default every record with a foundry_seed")
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    reg = json.load(open(a.registry))["records"]
    ids = set(a.ids.split(",")) if a.ids else None
    recs = [r for r in reg if r.get("foundry_seed", {}).get("origin_commit") and (ids is None or r["id"] in ids)]
    out = []
    with tempfile.TemporaryDirectory(prefix="seedfix-") as w:
        for r in recs:
            try:
                res = fix_one(r, a, pathlib.Path(w))
            except Exception as e:  # one base failing must not stop the others
                res = {"id": r["id"], "base": r.get("foundry_base"), "error": str(e)[:300]}
            out.append(res)
            print(json.dumps(res), flush=True)
    rd = LOCKFIX / "receipts/app-fleet"
    rd.mkdir(parents=True, exist_ok=True)
    (rd / f"seedfix-symlinks.{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}{'' if a.apply else '.dry-run'}.json").write_text(json.dumps(out, indent=1))


if __name__ == "__main__":
    sys.exit(main())

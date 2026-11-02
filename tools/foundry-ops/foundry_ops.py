#!/usr/bin/env python3
"""Foundry operator tool: list every repo, clean up decided forks, land changes through the gate in batches.

  foundry_ops.py repos [--forks|--bases] [--json]
      Every repo in the namespace. The Artifacts list API pages by cursor; `wrangler artifacts repos list`
      ignores the cursor and stops at 50.

  foundry_ops.py forks [--gc] [--min-age-days N] [--agent ID ...] [--include-unused] [--apply]
      Every task fork with its gate state: D1 decisions plus the fork's own main head. merged (head is the
      merged push), unused (no decision, head still the task's base sha), pushed-after-merge, pushed-undecided,
      refused-<verdict>, no-ticket. --gc prints what cleanup would delete; --apply deletes it and logs each to
      ~/.config/foundry/fork-gc.tsv. Cleanup only takes merged forks (the change is on the base) and, with
      --include-unused, unused ones (they hold nothing but the base). Everything else is always kept.

  foundry_ops.py land SPEC.json [--dry-run]
      Land one or more changes through the gate, in order (each lands on the base the previous one moved).
      Per item: open the task (never re-POSTs a task id that has a saved response), subscribe its fork and let
      the subscription settle, cherry-pick the commits onto the task's base in a scratch worktree, stamp the
      commit time (the gate refuses a HEAD authored more than 300 s before the push), push to the fork, wait
      for the D1 decision (one re-push if the push was dropped), optionally mirror to GitHub, delete the fork
      it created once merged. SPEC is one object or a list:
        {"base": "motionmix", "task": "mm-thing-20261031", "agent": "claude-<session>",
         "repo": "~/Developer/MotionMix", "commits": ["<sha>", ...] or "range": "a..b",
         "allowedRoots": ["path/prefix", ...],
         "github": {"remote": "origin", "history": true},   (optional: task/<task> = the merge, history/<task> = the push)
         "deleteFork": true}                                  (default true)

      Before the task is opened, a preflight scans every worktree of the repo and refuses when another active
      lane has unlanded edits, with different bytes, to a file this landing changes (--ack-overlap or
      "ackOverlap": true lands anyway). If the base has .foundry/generated.json, its generator must first
      reproduce the base byte for byte in the scratch worktree; then cherry-pick conflicts confined to generated
      files are resolved by regenerating, and generated files are refreshed after the last pick. After a merge,
      the source worktree is reset onto the merged commit when nothing would be lost (HEAD is the last landed
      commit, no tracked edits, every commit beyond main has landed); otherwise the result carries the command.
        .foundry/generated.json: {"format": "foundry.generated.v1", "files": [...], "run": ["xcodegen", "generate"],
                                  "links": {"../Sibling": "~/Developer/Sibling"}, "assets": ".foundry/assets.json"}

  foundry_ops.py scan REPO BASE [--fetch] [--cache] [--json] [--active-days N]
      Every worktree of REPO against refs/foundry/BASE/main: landed (via the land log, since the gate squashes),
      pending files, hunk-level conflicts with main (git merge-tree), and files two active lanes both have
      pending. --cache writes ~/.config/foundry/lanes/BASE.json for the SessionStart lanes hook.

Credentials never reach output: the Cloudflare token comes from `wrangler auth token` and stays in memory,
the task token is read from its 0600 file, saved task responses are written 0600 and only allowlisted fields
are ever read back. Git pushes go through foundry-push / foundry-fetch, which hand tokens to git via askpass.
"""
import argparse, datetime, json, os, pathlib, shutil, subprocess, sys, tempfile, time, urllib.error, urllib.parse, urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]  # the foundry checkout: wrangler + tools/subscribe-repo.sh
CONF = pathlib.Path.home() / ".config/foundry"
BIN = CONF / "bin"
ENVS = {
    "staging": {"namespace": "foundry-staging", "d1": "4dfb279c-4e61-4954-a13a-3e8ef8181484",
                "orchestrator": "https://foundry-orchestrator-staging.motionmix-participation.workers.dev",
                "task_token": CONF / "staging-task-token"},
}
API = "https://api.cloudflare.com/client/v4"
SETTLE_S = 30        # a push made seconds after a new subscription can be dropped (2026-10-27)
DECISION_WAIT_S = 120
MAX_AUTHOR_AGE_S = 300


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def sh(cmd, cwd=None, check=True, quiet=False):
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if check and p.returncode != 0:
        raise SystemExit(f"command failed ({p.returncode}): {' '.join(map(str, cmd[:4]))} ...\n{p.stderr.strip()[-800:]}")
    return p if quiet else p.stdout


class Cloudflare:
    def __init__(self, env):
        self.env = ENVS[env]
        self.token = json.loads(sh(["npx", "wrangler", "auth", "token", "--json"], cwd=ROOT))["token"]
        self.account = self._account()

    def _account(self):
        d = self.call("GET", "/accounts?per_page=50")
        accounts = d.get("result") or []
        if len(accounts) != 1:
            raise SystemExit(f"expected one Cloudflare account, got {len(accounts)}")
        return accounts[0]["id"]

    def call(self, method, path, body=None):
        req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                     headers={"Authorization": f"Bearer {self.token}", "content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            raise SystemExit(f"{method} {path.split('?')[0]}: HTTP {e.code} {e.read()[:300]!r}")

    def repos(self):
        out, cursor, ns = [], None, urllib.parse.quote(self.env["namespace"])
        while True:
            q = "?per_page=50" + (f"&cursor={urllib.parse.quote(cursor)}" if cursor else "")
            d = self.call("GET", f"/accounts/{self.account}/artifacts/namespaces/{ns}/repos{q}")
            page = d.get("result") or []
            out += page
            cursor = (d.get("result_info") or {}).get("cursor")
            if not page or not cursor or len(page) < 50:
                return out

    def delete_repo(self, name):
        ns = urllib.parse.quote(self.env["namespace"])
        self.call("DELETE", f"/accounts/{self.account}/artifacts/namespaces/{ns}/repos/{urllib.parse.quote(name)}")

    def fork_head(self, repo, remote):
        """main's sha in a repo, via a 5-minute read token handed to git by askpass (never on argv or output)."""
        ns = urllib.parse.quote(self.env["namespace"])
        d = self.call("POST", f"/accounts/{self.account}/artifacts/namespaces/{ns}/tokens",
                      {"repo": repo, "scope": "read", "ttl": 300})
        tok = ((d.get("result") or {}).get("plaintext") or (d.get("result") or {}).get("token") or "").split("?")[0]
        if not tok:
            raise SystemExit(f"no read token for {repo}")
        with tempfile.TemporaryDirectory() as tmp:
            t, ask = pathlib.Path(tmp, "t"), pathlib.Path(tmp, "ask")
            t.write_text(tok); t.chmod(0o600)
            ask.write_text(f'#!/bin/sh\ncase "$1" in Username*) echo x;; *) cat "{t}";; esac\n'); ask.chmod(0o700)
            p = subprocess.run(["git", "-c", "credential.helper=", "ls-remote", remote, "refs/heads/main"],
                               capture_output=True, text=True, timeout=60,
                               env={**os.environ, "GIT_ASKPASS": str(ask), "GIT_TERMINAL_PROMPT": "0"})
        if p.returncode != 0:
            raise SystemExit(f"ls-remote {repo} failed: {p.stderr.strip()[-200:]}")
        return (p.stdout.split() or [None])[0]

    def d1(self, sql, params=()):
        d = self.call("POST", f"/accounts/{self.account}/d1/database/{self.env['d1']}/query",
                      {"sql": sql, "params": list(params)})
        return d["result"][0]["results"]


# ---------------------------------------------------------------- repos / forks

def fork_states(cf, probe=True):
    """Each task fork's gate state. Repo push times are not reported for forks, so state is proven from the
    fork's own main head: equal to the last merged push = merged and nothing since; equal to the task's base
    sha with no decision ever = unused. Anything else is kept."""
    forks = [r for r in cf.repos() if "--" in r["name"]]
    # Never select tickets.scope_json: it carries the scope token.
    tickets = {t["fork_repo"]: t for t in cf.d1("select fork_repo, task_id, agent_id, base_repo, base_sha from tickets")}
    last = {}
    for d in cf.d1("select repo, verdict, after_sha, merged_sha, decided_at, id from decisions order by id"):
        last[d["repo"]] = d
    now = datetime.datetime.now(datetime.timezone.utc)
    rows = []
    for r in forks:
        dec, t = last.get(r["name"]), tickets.get(r["name"], {})
        head = cf.fork_head(r["name"], r["remote"]) if probe else None
        if not t:
            state = "no-ticket"
        elif dec is None:
            state = "unused" if head and head == t.get("base_sha") else "pushed-undecided" if probe else "undecided"
        elif dec["verdict"] == "merge":
            state = "merged" if head == dec["after_sha"] else "pushed-after-merge" if probe else "merge"
        else:
            state = f"refused-{dec['verdict']}"
        ref = (dec or {}).get("decided_at") or r.get("created_at")
        age = (now - datetime.datetime.fromisoformat(ref.replace("Z", "+00:00"))).days if ref else None
        rows.append({"fork": r["name"], "state": state, "age_days": age,
                     "agent": t.get("agent_id") or r["name"].split("--", 1)[1], "task": t.get("task_id"),
                     "base": t.get("base_repo"), "head": head, "created_at": r.get("created_at"),
                     "decision": dec and {k: dec[k] for k in ("id", "verdict", "merged_sha", "decided_at")}})
    return rows


def cmd_repos(a):
    cf = Cloudflare(a.env)
    rows = [r for r in cf.repos() if not (a.forks and "--" not in r["name"]) and not (a.bases and "--" in r["name"])]
    if a.json:
        json.dump([{k: r.get(k) for k in ("name", "default_branch", "created_at", "last_push_at", "status")} for r in rows],
                  sys.stdout, indent=1)
    else:
        for r in sorted(rows, key=lambda r: r["name"]):
            print(f"{r['name']}\t{(r.get('last_push_at') or '-')[:10]}")
        log(f"{len(rows)} repos in {cf.env['namespace']}")


def cmd_forks(a):
    cf = Cloudflare(a.env)
    rows = fork_states(cf)
    take = {"merged"} | ({"unused"} if a.include_unused else set())
    doomed = [r for r in rows if r["state"] in take and (r["age_days"] or 0) >= a.min_age_days
              and (not a.agent or r["agent"] in a.agent)]
    if a.json:
        json.dump({"forks": rows, "gc": [r["fork"] for r in doomed] if a.gc else None}, sys.stdout, indent=1)
    else:
        for r in sorted(rows, key=lambda r: (r["state"], r["fork"])):
            mark = "GC " if a.gc and r in doomed else "   "
            print(f"{mark}{r['state']:<20}{str(r['age_days']):>4}d  {r['fork']}")
    counts = {}
    for r in rows:
        counts[r["state"]] = counts.get(r["state"], 0) + 1
    log(f"{len(rows)} forks: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items())))
    if a.gc:
        log(f"cleanup would delete {len(doomed)} (merged{' + unused' if a.include_unused else ''}, "
            f">= {a.min_age_days} d{', agents ' + ','.join(a.agent) if a.agent else ''})")
    if a.apply:
        if not a.gc:
            raise SystemExit("--apply needs --gc")
        ledger = CONF / "fork-gc.tsv"
        for r in doomed:
            cf.delete_repo(r["fork"])
            with open(ledger, "a") as f:
                f.write(f"{datetime.datetime.now().isoformat(timespec='seconds')}\t{r['fork']}\t{r['state']}\t"
                        f"{(r['decision'] or {}).get('merged_sha') or ''}\n")
            log(f"deleted {r['fork']} ({r['state']})")


# ---------------------------------------------------------------- lanes

# Lanes are worktrees. Nothing registers them, so the scan reads git: every worktree of the repo against the
# base's Foundry main. The gate squash-merges (one commit on main, parent main only), so a landed branch never
# becomes an ancestor of main; the land log maps each landed source commit to its merged sha instead.
ACTIVE_DAYS = 3.0
GENERATED_SPEC = ".foundry/generated.json"
LANES_CACHE = CONF / "lanes"


def git(*args, cwd, check=False):
    return sh(["git", *args], cwd=cwd, check=check, quiet=True)


def _lines(out):
    return [l for l in out.splitlines() if l]


def landed_commits(base):
    """Source commit -> merged main sha for every landed change on `base`."""
    out = {}
    try:
        with open(CONF / "land-log.jsonl") as f:
            for l in f:
                try:
                    r = json.loads(l)
                except ValueError:
                    continue
                if r.get("base") == base and r.get("verdict") == "merge" and r.get("decision"):
                    for c in r.get("commits") or []:
                        out[c] = r["decision"]["merged_sha"]
    except FileNotFoundError:
        pass
    return out


def worktrees(repo):
    out, cur = [], {}
    for l in git("worktree", "list", "--porcelain", cwd=repo, check=True).stdout.splitlines() + [""]:
        if not l:
            if cur:
                out.append(cur)
            cur = {}
        elif l.startswith("worktree "):
            cur["path"] = l[9:]
        elif l.startswith("HEAD "):
            cur["head"] = l[5:]
        elif l.startswith("branch "):
            cur["branch"] = l[7:].removeprefix("refs/heads/")
        elif l == "detached":
            cur["branch"] = "(detached)"
    # Skip land scratch worktrees, missing directories and unborn branches (HEAD all zeros).
    return [w for w in out if os.path.isdir(w["path"]) and not os.path.basename(os.path.dirname(w["path"])).startswith("land-")
            and w.get("head", "").strip("0")]


def generated_spec(repo, ref):
    """The base's regeneration recipe (.foundry/generated.json at `ref`), or None."""
    p = git("show", f"{ref}:{GENERATED_SPEC}", cwd=repo)
    if p.returncode != 0:
        return None
    spec = json.loads(p.stdout)
    if spec.get("format") != "foundry.generated.v1" or not spec.get("files") or not spec.get("run"):
        raise SystemExit(f"{GENERATED_SPEC} at {ref[:12]}: need format foundry.generated.v1, files and run")
    return spec


def file_version(wt, rev, path, dirty):
    """The blob a lane has for `path`: its working file when edited, else its commit's."""
    if path in dirty:
        full = os.path.join(wt, path)
        return git("hash-object", path, cwd=wt).stdout.strip() if os.path.exists(full) else ""
    return git("rev-parse", f"{rev}:{path}", cwd=wt).stdout.strip()


def scan(repo, base, active_days=ACTIVE_DAYS):
    """Every worktree of `repo` against refs/foundry/<base>/main. Read-only."""
    main_ref = f"refs/foundry/{base}/main"
    main_sha = git("rev-parse", "--verify", main_ref, cwd=repo, check=True).stdout.strip()
    landed = landed_commits(base)
    spec = generated_spec(repo, main_ref)
    generated = set((spec or {}).get("files", []))
    now = time.time()
    lanes = []
    for w in worktrees(repo):
        wt, head = w["path"], w["head"]
        lane = {"path": wt, "branch": w.get("branch"), "head": head}
        lane["last_commit_age_d"] = round((now - int(git("log", "-1", "--format=%ct", head, cwd=repo).stdout or now)) / 86400, 1)
        st = git("status", "--porcelain", "--untracked-files=no", cwd=wt)
        dirty = {l[3:].split(" -> ")[-1] for l in st.stdout.splitlines() if l}
        mtimes = [os.path.getmtime(os.path.join(wt, f)) for f in dirty if os.path.exists(os.path.join(wt, f))]
        lane["dirty_age_d"] = round((now - max(mtimes)) / 86400, 1) if mtimes else None
        fork = git("merge-base", head, main_ref, cwd=repo).stdout.strip()
        if not fork:
            lane.update(state="unrelated-history", pending=[], dirty=sorted(dirty), active=False)
            lanes.append(lane)
            continue
        # Only commits after the newest landed one are new work; its merge is the real fork point.
        src_from = fork
        for c in _lines(git("rev-list", f"{fork}..{head}", cwd=repo).stdout):
            if c in landed:
                src_from, fork = c, landed[c]
                lane["landed_as"] = fork
                break
        committed = set(_lines(git("diff", "--name-only", src_from, head, cwd=repo).stdout))
        pending = sorted(f for f in committed | dirty
                         if file_version(wt, head, f, dirty) != git("rev-parse", f"{main_ref}:{f}", cwd=repo).stdout.strip())
        main_since = set(_lines(git("diff", "--name-only", fork, main_ref, cwd=repo).stdout))
        conflicts = []
        if committed:
            mt = git("merge-tree", "--write-tree", "--name-only", "--no-messages", f"--merge-base={src_from}",
                     main_ref, head, cwd=repo)
            conflicts = sorted(set(_lines(mt.stdout)[1:])) if mt.returncode == 1 else []
        dirty_moved = sorted(dirty & set(pending) & main_since)
        ages = [x for x in (lane["last_commit_age_d"], lane["dirty_age_d"]) if x is not None]
        lane.update(fork=fork, main_moved_by=int(git("rev-list", "--count", "--first-parent", f"{fork}..{main_ref}", cwd=repo).stdout or 0),
                    pending=pending, dirty=sorted(dirty & set(pending)), merge_conflicts=conflicts,
                    dirty_on_moved_files=dirty_moved, active=bool(pending) and min(ages) <= active_days,
                    state="landed" if not pending else "conflicts-with-main" if conflicts or dirty_moved else "clean-pending")
        lanes.append(lane)
    active = [l for l in lanes if l["active"]]
    overlaps = []
    for i, a in enumerate(active):
        for b in active[i + 1:]:
            shared = sorted(set(a["pending"]) & set(b["pending"]))
            if shared:
                overlaps.append({"a": a["path"], "b": b["path"], "files": shared,
                                 "generated_only": set(shared) <= generated})
    return {"repo": repo, "base": base, "main": main_sha, "scanned_at": int(now), "generated": sorted(generated),
            "lanes": lanes, "overlaps": overlaps}


def repo_top(path):
    return os.path.realpath(git("rev-parse", "--show-toplevel", cwd=path, check=True).stdout.strip())


def preflight(repo, base, picks, ack=False, active_days=ACTIVE_DAYS):
    """Refuse a landing whose files another active lane is also changing, with different bytes.
    Generated files are left out: the cherry-pick regenerates them (see regenerate)."""
    r = scan(repo, base, active_days)
    me = repo_top(repo)
    mine = set()
    for c in picks:
        mine |= set(_lines(git("diff-tree", "--no-commit-id", "--name-only", "-r", "--root", c, cwd=repo).stdout))
    contested = []
    for lane in r["lanes"]:
        if not lane["active"] or os.path.realpath(lane["path"]) == me or lane["head"] in picks:
            continue
        files = sorted(f for f in (set(lane["pending"]) & mine) - set(r["generated"])
                       if file_version(lane["path"], lane["head"], f, set(lane["dirty"]))
                       != git("rev-parse", f"{picks[-1]}:{f}", cwd=repo).stdout.strip())
        if files:
            contested.append({"lane": lane["path"], "branch": lane["branch"], "files": files})
    for c in contested:
        log(f"  overlap: {c['branch']} ({c['lane']}) is also changing {', '.join(c['files'][:6])}"
            + (f" and {len(c['files']) - 6} more" if len(c["files"]) > 6 else ""))
    if contested and not ack:
        raise SystemExit("preflight: another active lane has unlanded edits to these files. Agree on an order with "
                         "that lane (its worktree is named above), or pass --ack-overlap to land anyway; the second "
                         "lane to land will then have to rebase onto yours.")
    return contested


def regenerate(wt, spec, sources=()):
    """Run the base's generator in `wt`. Links named in the recipe are made next to the worktree (relative
    paths such as ../MotionMix resolve there), and files the seed stripped (assets.json) are linked in from
    `sources` so folder-scanning generators see the same tree a lane builds from."""
    parent = os.path.dirname(wt)
    for rel, target in (spec.get("links") or {}).items():
        dst = os.path.normpath(os.path.join(wt, rel))
        if not dst.startswith(parent + os.sep) or os.path.dirname(dst) != parent:
            raise SystemExit(f"{GENERATED_SPEC}: link {rel} must name a sibling of the worktree")
        if not os.path.lexists(dst):
            os.symlink(os.path.expanduser(target), dst)
    manifest = spec.get("assets")
    if manifest and os.path.exists(os.path.join(wt, manifest)):
        for a in json.load(open(os.path.join(wt, manifest))).get("stripped", []):
            dst = os.path.join(wt, a["path"])
            if os.path.lexists(dst):
                continue
            for src in sources:
                cand = os.path.join(src, a["path"])
                if os.path.exists(cand):
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    os.symlink(os.path.realpath(cand), dst)
                    break
    p = sh([os.path.expanduser(x) for x in spec["run"]], cwd=wt, check=False, quiet=True)
    if p.returncode != 0:
        return f"generator failed: {(p.stderr or p.stdout).strip()[-300:]}"
    return None


def generated_drift(wt, spec):
    """Generated files whose bytes differ from the index (empty = the generator reproduces them)."""
    git("add", "--intent-to-add", "--", *spec["files"], cwd=wt)
    return _lines(git("diff", "--name-only", "--", *spec["files"], cwd=wt).stdout)


def apply_picks(wt, picks, spec=None, sources=()):
    """Cherry-pick `picks` in `wt`. With a regeneration recipe that reproduces the base byte for byte, conflicts
    confined to generated files are resolved by regenerating, and the generated files are refreshed after the
    last pick. Returns (ok, detail dict)."""
    detail = {}
    trusted = False
    if spec:
        err = regenerate(wt, spec, sources)
        drift = [] if err else generated_drift(wt, spec)
        trusted = not err and not drift
        detail["regenerate"] = "verified" if trusted else (err or f"base not reproduced: {', '.join(drift)}")
        if not trusted:
            git("checkout", "--", *spec["files"], cwd=wt)
            log(f"  regenerate: not used ({detail['regenerate']})")
    p = git("cherry-pick", "--allow-empty", *picks, cwd=wt)
    resolved = []
    while p.returncode != 0:
        unmerged = set(_lines(git("diff", "--name-only", "--diff-filter=U", cwd=wt).stdout))
        if not (trusted and unmerged and unmerged <= set(spec["files"])):
            git("cherry-pick", "--abort", cwd=wt)
            detail["conflicts"] = sorted(unmerged)
            detail["detail"] = (p.stderr or p.stdout).strip()[-400:]
            return False, detail
        err = regenerate(wt, spec, sources)
        if err:
            git("cherry-pick", "--abort", cwd=wt)
            detail.update(conflicts=sorted(unmerged), detail=err)
            return False, detail
        git("add", "--", *spec["files"], cwd=wt, check=True)
        resolved += sorted(unmerged)
        log(f"  regenerated {', '.join(sorted(unmerged))} to resolve a generated-file conflict")
        p = subprocess.run(["git", "cherry-pick", "--continue"], cwd=wt, capture_output=True, text=True,
                           env={**os.environ, "GIT_EDITOR": "true"})
    if resolved:
        detail["regenerated_conflicts"] = resolved
    if trusted:
        err = regenerate(wt, spec, sources)
        drift = [] if err else generated_drift(wt, spec)
        if err:
            detail["regenerate_after"] = err
        elif drift:
            # A clean textual merge of a generated file can still be wrong; the generator's output is the truth.
            git("add", "--", *drift, cwd=wt, check=True)
            detail["regenerated_after"] = drift
            log(f"  regenerated {', '.join(drift)} after the cherry-pick")
    return True, detail


def post_land_reset(src, picks, merged, base):
    """Move the source worktree onto the merged commit when that loses nothing: HEAD is the last landed commit,
    no tracked file is edited, and every commit HEAD has beyond main has landed. Otherwise say how."""
    if not src or not os.path.isdir(src):
        return {"reset": "skipped", "why": "no source worktree"}
    head = git("rev-parse", "HEAD", cwd=src).stdout.strip()
    hint = f"git -C {src} reset --keep {merged[:12]}"
    if head != picks[-1]:
        return {"reset": "skipped", "why": "HEAD is not the last landed commit", "hint": hint}
    if git("status", "--porcelain", "--untracked-files=no", cwd=src).stdout.strip():
        return {"reset": "skipped", "why": "tracked edits in the worktree", "hint": hint}
    landed = set(landed_commits(base)) | set(picks)
    own = _lines(git("rev-list", "--max-count=500", head, "--not", merged, cwd=src).stdout)
    if len(own) >= 500 or not set(own) <= landed:
        return {"reset": "skipped", "why": "the branch has commits that did not land", "hint": hint}
    p = git("reset", "--keep", merged, cwd=src)
    if p.returncode != 0:
        return {"reset": "failed", "why": p.stderr.strip()[-200:], "hint": hint}
    log(f"  reset {src} onto the merged commit {merged[:8]} (was {head[:8]})")
    return {"reset": "done", "from": head, "to": merged}


def write_scan_cache(r):
    LANES_CACHE.mkdir(parents=True, exist_ok=True)
    tmp = LANES_CACHE / f".{r['base']}.json.tmp"
    tmp.write_text(json.dumps(r))
    os.replace(tmp, LANES_CACHE / f"{r['base']}.json")


def cmd_scan(a):
    repo = os.path.expanduser(a.repo)
    if a.fetch:
        sh([str(BIN / "foundry-fetch"), a.base, f"+refs/heads/main:refs/foundry/{a.base}/main"], cwd=repo, check=False)
    r = scan(repo, a.base, a.active_days)
    if a.cache:
        write_scan_cache(r)
    if a.json:
        json.dump(r, sys.stdout, indent=1)
        print()
        return
    if a.cache:
        return
    log(f"{r['base']} main {r['main'][:8]}, {len(r['lanes'])} worktrees")
    for l in sorted(r["lanes"], key=lambda l: (not l["active"], l["last_commit_age_d"])):
        extra = ""
        if l.get("merge_conflicts"):
            extra += f"  merge-conflicts: {', '.join(l['merge_conflicts'][:4])}"
        if l.get("dirty_on_moved_files"):
            extra += f"  edited files main also moved: {', '.join(l['dirty_on_moved_files'][:4])}"
        print(f"{'ACTIVE ' if l['active'] else '       '}{l['state']:<20} {str(l['branch'])[:56]:<56} "
              f"{l['last_commit_age_d']:>6}d  pending {len(l['pending']):<4} edited {len(l['dirty']):<4}{extra}")
    if not r["overlaps"]:
        print("no overlap between active lanes")
    for o in r["overlaps"]:
        print(f"overlap {o['a']} x {o['b']}: {', '.join(o['files'][:6])}{' (generated only)' if o['generated_only'] else ''}")


# ---------------------------------------------------------------- land

def task_file(task):
    return CONF / f"task-{task}.json"


def open_task(env, spec, dry):
    """POST /tasks once per task id; afterwards the saved 0600 response is the task."""
    f = task_file(spec["task"])
    if not f.exists():
        if dry:
            return {"baseSha": None, "forks": [f"{spec['task']}--{spec['agent']}"], "new": True}
        token = ENVS[env]["task_token"].read_text().strip()
        body = {"baseRepo": spec["base"], "taskId": spec["task"], "agents": [spec["agent"]],
                "allowedRoots": spec["allowedRoots"]}
        req = urllib.request.Request(ENVS[env]["orchestrator"] + "/tasks", method="POST", data=json.dumps(body).encode(),
                                     headers={"Authorization": f"Bearer {token}", "content-type": "application/json",
                                              # The workers.dev edge refuses urllib's default agent (error 1010).
                                              "User-Agent": "foundry-ops/1"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                raw = r.read()
        except urllib.error.HTTPError as e:
            raise SystemExit(f"POST /tasks {spec['task']}: HTTP {e.code} {e.read()[:300]!r}")
        fd = os.open(f, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as out:
            out.write(raw)
        new = True
    else:
        new = False
    d = json.loads(f.read_text())
    # Allowlisted fields only: dispatches[].token is a repo write token.
    if d.get("taskId") != spec["task"] or d.get("baseRepo") != spec["base"]:
        raise SystemExit(f"{f} is a different task ({d.get('taskId')} on {d.get('baseRepo')})")
    subs = {s.get("forkRepo"): bool(s.get("ok")) for s in d.get("subscriptions") or []}
    forks = [x.get("forkRepo") for x in d.get("dispatches") or [] if x.get("agentId") == spec["agent"]]
    if not forks:
        raise SystemExit(f"{f} has no dispatch for agent {spec['agent']}")
    return {"baseSha": d.get("baseSha"), "forks": forks, "new": new, "subscribed": subs}


def subscribe(env, fork, already):
    if already:
        return False
    out = sh(["bash", "tools/subscribe-repo.sh", env, fork], cwd=ROOT)
    created = not out.startswith("exists:")
    log(f"  subscription {'created' if created else 'exists'} for {fork}")
    return created


def commits_of(spec, repo):
    if spec.get("commits"):
        return [sh(["git", "rev-parse", "--verify", c + "^{commit}"], cwd=repo).strip() for c in spec["commits"]]
    if spec.get("range"):
        return sh(["git", "rev-list", "--reverse", "--no-merges", spec["range"]], cwd=repo).split()
    raise SystemExit(f"{spec['task']}: give commits or range")


def decision_for(cf, fork, sha):
    rows = cf.d1("select id, verdict, reason, merged_sha, decided_at from decisions where repo = ? and after_sha = ? "
                 "order by id desc limit 1", (fork, sha))
    return rows[0] if rows else None


def wait_decision(cf, fork, sha, timeout):
    end = time.time() + timeout
    while time.time() < end:
        d = decision_for(cf, fork, sha)
        if d:
            return d
        time.sleep(10)
    return None


def land_one(cf, env, spec, dry, ack_overlap=False):
    spec = {"deleteFork": True, **spec}
    repo = str(pathlib.Path(spec["repo"]).expanduser())
    for k in ("base", "task", "agent", "allowedRoots"):
        if not spec.get(k):
            raise SystemExit(f"spec missing {k}: {spec}")
    picks = commits_of(spec, repo)
    log(f"== {spec['task']}: {len(picks)} commit(s) onto {spec['base']}")
    base_ref = f"refs/foundry/{spec['base']}/main"
    sh([str(BIN / "foundry-fetch"), spec["base"], f"+refs/heads/main:{base_ref}"], cwd=repo)
    # Before the task exists: a landing that another active lane would collide with stops here.
    contested = preflight(repo, spec["base"], picks, ack=ack_overlap or bool(spec.get("ackOverlap")))
    t = open_task(env, spec, dry)
    fork = t["forks"][0]
    if dry:
        log(f"  dry run: would open task, subscribe {fork}, cherry-pick {', '.join(c[:8] for c in picks)}, push, wait")
        return {"task": spec["task"], "fork": fork, "dry_run": True, "overlap": contested}
    if subscribe(env, fork, t["subscribed"].get(fork)):
        time.sleep(SETTLE_S)
    elif t["new"] and t["subscribed"].get(fork):
        time.sleep(SETTLE_S)  # the orchestrator subscribed it a moment ago
    # The scratch worktree gets its own parent directory, so a recipe's ../sibling links resolve there.
    tmp = tempfile.mkdtemp(prefix=f"land-{spec['task']}-")
    wt = os.path.join(tmp, os.path.basename(repo_top(repo)))
    result = {"task": spec["task"], "fork": fork, "base": spec["base"], "commits": picks}
    if contested:
        result["overlap"] = contested
    try:
        onto = t["baseSha"] or base_ref
        sh(["git", "worktree", "add", "--detach", wt, onto], cwd=repo)
        sources = [repo] + [w["path"] for w in worktrees(repo)[:1]]
        ok, detail = apply_picks(wt, picks, generated_spec(repo, onto), sources)
        result.update(detail)
        if not ok:
            result["verdict"] = "local-conflict"
            return result
        for attempt in (1, 2):
            sh(["git", "commit", "--amend", "--no-edit", "--date=now"], cwd=wt)
            head = sh(["git", "rev-parse", "HEAD"], cwd=wt).strip()
            sh([str(BIN / "foundry-push"), fork, "HEAD:refs/heads/main", "--force"], cwd=wt)
            log(f"  pushed {head[:8]} to {fork} (attempt {attempt}); waiting for the gate")
            d = wait_decision(cf, fork, head, DECISION_WAIT_S)
            if d:
                break
            log("  no decision row: the push was likely dropped; re-stamping and pushing once more")
        result.update(pushed=head, decision=d)
        if not d:
            result["verdict"] = "no-decision"
            return result
        result["verdict"] = d["verdict"]
        if d["verdict"] != "merge":
            return result
        merged = d["merged_sha"]
        sh([str(BIN / "foundry-fetch"), spec["base"], f"+refs/heads/main:{base_ref}"], cwd=repo)
        gh = spec.get("github")
        if gh:
            remote = gh.get("remote", "origin")
            refs = [f"{merged}:refs/heads/task/{spec['task']}"]
            if gh.get("history", True):
                dated = spec["task"][-8:].isdigit()  # task ids usually end in their date already
                refs.append(f"{head}:refs/heads/history/{spec['task']}"
                            + ("" if dated else f"-{datetime.date.today():%Y%m%d}"))
            sh(["git", "push", remote, *refs], cwd=repo)
            result["github"] = refs
        if spec["deleteFork"]:
            cf.delete_repo(fork)
            result["fork_deleted"] = True
        # A squash merge never makes the lane's branch an ancestor of main; move it onto the merge.
        result["source"] = post_land_reset(repo, picks, merged, spec["base"])
        return result
    finally:
        sh(["git", "worktree", "remove", "--force", wt], cwd=repo, check=False)
        shutil.rmtree(tmp, ignore_errors=True)


def cmd_land(a):
    specs = json.loads(pathlib.Path(a.spec).read_text())
    specs = specs if isinstance(specs, list) else [specs]
    cf = None if a.dry_run else Cloudflare(a.env)
    results = []
    for s in specs:
        r = land_one(cf, a.env, s, a.dry_run, a.ack_overlap)
        results.append(r)
        with open(CONF / "land-log.jsonl", "a") as f:
            f.write(json.dumps({"at": datetime.datetime.now().isoformat(timespec="seconds"), **r}) + "\n")
        log(f"  -> {r.get('verdict', 'dry-run')}" + (f" {r['decision']['merged_sha'][:8]}" if r.get("verdict") == "merge" else ""))
        if not a.dry_run and r.get("verdict") != "merge" and not a.keep_going:
            log("stopping: the next item would land on a base this one did not move (use --keep-going to continue)")
            break
    # Main moved: refresh what the SessionStart lanes hook shows.
    for repo, base in {(str(pathlib.Path(s["repo"]).expanduser()), s["base"]) for s in specs[:len(results)]}:
        try:
            write_scan_cache(scan(repo, base))
        except (Exception, SystemExit) as e:
            log(f"  lane scan cache not refreshed for {base}: {e}")
    json.dump(results, sys.stdout, indent=1)
    print()
    if any(r.get("verdict") not in ("merge", None) for r in results):
        sys.exit(1)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--env", default="staging", choices=sorted(ENVS))
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("repos"); r.add_argument("--forks", action="store_true"); r.add_argument("--bases", action="store_true")
    r.add_argument("--json", action="store_true"); r.set_defaults(fn=cmd_repos)
    f = sub.add_parser("forks"); f.add_argument("--gc", action="store_true"); f.add_argument("--apply", action="store_true")
    f.add_argument("--min-age-days", type=int, default=3); f.add_argument("--agent", action="append")
    f.add_argument("--include-unused", action="store_true"); f.add_argument("--json", action="store_true")
    f.set_defaults(fn=cmd_forks)
    l = sub.add_parser("land"); l.add_argument("spec"); l.add_argument("--dry-run", action="store_true")
    l.add_argument("--keep-going", action="store_true"); l.add_argument("--ack-overlap", action="store_true")
    l.set_defaults(fn=cmd_land)
    sc = sub.add_parser("scan"); sc.add_argument("repo"); sc.add_argument("base")
    sc.add_argument("--active-days", type=float, default=ACTIVE_DAYS); sc.add_argument("--fetch", action="store_true")
    sc.add_argument("--cache", action="store_true"); sc.add_argument("--json", action="store_true")
    sc.set_defaults(fn=cmd_scan)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()

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
         "chains": ["chain:pact-pulse", ...],                 (optional: read off the session when absent, [] for none)
         "deleteFork": true}                                  (default true)

      Declared chains are checked against PACT (pact-server POST /api/check-chains, URL from $FOUNDRY_PACT_URL or
      ~/.config/foundry/pact-url) before the task is opened: a chain PACT does not know, or one whose stages do not
      compose, refuses the landing (verdict plan-refused) with nothing created. Missing canonical stages are shown,
      not refused (a pipeline lacks them by design, PACT finding 0009). An unreachable PACT is "not checked" and the
      landing goes on. The chains also go to POST /tasks, so the orchestrator and the gate record and re-check them.
      A spec with no "chains" key takes the chains this Claude session ran ($CLAUDE_CODE_SESSION_ID): named with the
      Skill tool or typed as /chain:x, or walked by hand with every member in order (members from PACT). Quoted
      mentions do not count. A session that ran none lands with none; nothing is ever inferred from the diff.

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
      Every worktree of REPO against refs/foundry/BASE/main: landed (via the land log, since the gate squashes,
      or by patch-id when the log does not know the landing), pending files, untracked files main does not have,
      hunk-level conflicts with main (git merge-tree), and files two active lanes both have pending. Worktrees
      whose branch ref is gone (HEAD unborn) are listed as orphans with the files only they hold.
      --cache writes ~/.config/foundry/lanes/BASE.json for the SessionStart lanes hook.

Credentials never reach output: the Cloudflare token comes from `wrangler auth token` and stays in memory,
the task token is read from its 0600 file, saved task responses are written 0600 and only allowlisted fields
are ever read back. Git pushes go through foundry-push / foundry-fetch, which hand tokens to git via askpass.
"""
import argparse, datetime, hashlib, json, os, pathlib, re, shutil, subprocess, sys, tempfile, time, urllib.error, urllib.parse, urllib.request

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
# Long enough for a gate under load: decision 638 (2026-11-03) came 2 minutes after its push, just past the
# old 120 s wait, and land re-pushed the change as a second event. A re-push is for a dropped push only.
DECISION_WAIT_S = 300
# A base whose main carries .foundry/verify.json is built and tested before the gate decides
# (tools/foundry-verify): minutes, plus up to 3 queue retries if the verifier asks for one.
VERIFIED_DECISION_WAIT_S = 1800
# The gate keeps check output out of its ledger, so a refusal reads "failed <check>". The verifier
# runs on Mac1 and logs what failed by head sha; land reads it from there.
VERIFY_LOG = pathlib.Path.home() / ".fleet/verify/verify.log"
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
# becomes an ancestor of main; the land log maps each landed source commit to its merged sha instead. The log is
# per host and keyed by sha, so a landing made from another Mac, or a lane re-committed after it landed, is
# matched by content: the lane's change since its fork has the patch-id (or the tree) of a main commit.
ACTIVE_DAYS = 3.0
GENERATED_SPEC = ".foundry/generated.json"
LANES_CACHE = CONF / "lanes"
CONTENT_MATCH_MAX = 200  # main commits since the fork, and lane commits, compared by patch-id per lane


def git(*args, cwd, check=False):
    return sh(["git", *args], cwd=cwd, check=check, quiet=True)


def git_in(args, cwd, text):
    """git with `text` on stdin (patch-id, hash-object --stdin-paths, cat-file --batch-check)."""
    return subprocess.run(["git", *args], cwd=cwd, input=text, capture_output=True, text=True).stdout


def _lines(out):
    return [l for l in out.splitlines() if l]


def _paths(out):
    return [p for p in out.split("\0") if p]


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


def worktrees(repo, unborn=False):
    """Worktrees of `repo`, main checkout first. With `unborn`, also those whose branch ref no longer exists
    (HEAD all zeros, `unborn: True`): their files are on disk only, so the scan has to see them."""
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
    # Skip land scratch worktrees, missing directories and (unless asked for) unborn branches.
    keep = []
    for w in out:
        if not os.path.isdir(w["path"]) or os.path.basename(os.path.dirname(w["path"])).startswith("land-"):
            continue
        if not w.get("head", "").strip("0"):
            if not unborn:
                continue
            w["unborn"] = True
        keep.append(w)
    return keep


def generated_spec(repo, ref):
    """The base's regeneration recipe (.foundry/generated.json at `ref`), or None."""
    p = git("show", f"{ref}:{GENERATED_SPEC}", cwd=repo)
    if p.returncode != 0:
        return None
    spec = json.loads(p.stdout)
    if spec.get("format") != "foundry.generated.v1" or not spec.get("files") or not spec.get("run"):
        raise SystemExit(f"{GENERATED_SPEC} at {ref[:12]}: need format foundry.generated.v1, files and run")
    return spec


def stripped_assets(repo, ref, spec):
    """Files the seed stripped and land links back in (the recipe's "assets" manifest at `ref`), as
    {path: (bytes, sha256)}. Every lane holds them untracked on purpose."""
    manifest = (spec or {}).get("assets")
    p = git("show", f"{ref}:{manifest}", cwd=repo) if manifest else None
    if not p or p.returncode != 0:
        return {}
    return {a["path"]: (a.get("bytes"), a.get("sha256")) for a in json.loads(p.stdout).get("stripped", [])
            if a.get("path")}


def not_assets(wt, paths, assets):
    """`paths` less the stripped assets whose disk bytes still match the manifest. A rebuilt one stays: it is
    work, and land would link the manifest's copy over it."""
    def same(path):
        size, sha = assets[path]
        full = os.path.join(wt, path)
        try:
            if size is not None and os.path.getsize(full) != size:
                return False
            if not sha:
                return True
            h = hashlib.sha256()
            with open(full, "rb") as f:
                for block in iter(lambda: f.read(1 << 20), b""):
                    h.update(block)
            return h.hexdigest() == sha
        except OSError:
            return False
    return [p for p in paths if p not in assets or not same(p)]


def file_version(wt, rev, path, dirty):
    """The blob a lane has for `path`: its working file when edited, else its commit's."""
    if path in dirty:
        full = os.path.join(wt, path)
        return git("hash-object", path, cwd=wt).stdout.strip() if os.path.exists(full) else ""
    return git("rev-parse", f"{rev}:{path}", cwd=wt).stdout.strip()


def not_on(repo, ref, wt, paths):
    """The `paths` (relative to worktree `wt`) whose bytes on disk differ from `ref`'s, or that `ref` lacks."""
    paths = [p for p in paths if os.path.isfile(os.path.join(wt, p))]
    if not paths:
        return []
    disk = git_in(["hash-object", "--stdin-paths"], wt, "".join(p + "\n" for p in paths)).split()
    at = git_in(["cat-file", "--batch-check=%(objectname)"], repo, "".join(f"{ref}:{p}\n" for p in paths)).splitlines()
    return sorted(p for p, d, a in zip(paths, disk, at) if d != a.split(" ")[0])


def patch_id(repo, a, b, memo):
    """Stable patch-id (line numbers and whitespace ignored) of the change a..b, memoized; '' when empty."""
    if (a, b) not in memo:
        d = git("diff", a, b, cwd=repo).stdout
        memo[(a, b)] = git_in(["patch-id", "--stable"], repo, d).split(" ")[0] if d else ""
    return memo[(a, b)]


def landed_by_content(repo, main_ref, fork, lane_commits, memo):
    """(lane commit, main commit) for the newest lane commit whose whole change since `fork` is one main commit's
    own change (same patch-id) or whose tree is a main commit's tree. That is a landing the land log does not
    know: made from another host, or the lane was re-committed after it landed. None when nothing matches."""
    mains = [l.split() for l in _lines(git("log", "--first-parent", f"--max-count={CONTENT_MATCH_MAX}", "--format=%H %T",
                                           f"{fork}..{main_ref}", cwd=repo).stdout)]
    if not mains:
        return None
    by_tree, by_patch = {}, {}  # oldest main commit wins: that is the landing, later ones only repeat it
    for m, t in reversed(mains):
        by_tree.setdefault(t, m)
        pid = patch_id(repo, f"{m}^1", m, memo)
        if pid:
            by_patch.setdefault(pid, m)
    for c in lane_commits[:CONTENT_MATCH_MAX]:
        t = git("rev-parse", f"{c}^{{tree}}", cwd=repo).stdout.strip()
        if t in by_tree:
            return c, by_tree[t]
        pid = patch_id(repo, fork, c, memo)
        if pid in by_patch:
            return c, by_patch[pid]
    return None


def orphan_lane(repo, main_ref, lane, wt, now, assets):
    """A worktree whose branch ref is gone: no commit to compare, so every file it holds that main lacks (or has
    with other bytes) is work that exists only on disk, stripped assets aside."""
    files = _paths(git("ls-files", "-z", cwd=wt).stdout) + _paths(git("ls-files", "--others", "--exclude-standard",
                                                                      "-z", cwd=wt).stdout)
    only_here = not_on(repo, main_ref, wt, not_assets(wt, files, assets))
    mtimes = [os.path.getmtime(os.path.join(wt, f)) for f in only_here]
    lane.update(state="orphan", last_commit_age_d=None, pending=only_here, dirty=only_here, untracked=[],
                dirty_age_d=round((now - max(mtimes)) / 86400, 1) if mtimes else None, active=False)
    return lane


def scan(repo, base, active_days=ACTIVE_DAYS):
    """Every worktree of `repo` against refs/foundry/<base>/main. Read-only.

    States: landed, clean-pending, conflicts-with-main, untracked-only (everything committed has landed, but the
    worktree holds new files main does not have), unrelated-history (no common commit with main) and orphan
    (branch ref gone). `untracked` lists untracked, non-ignored files whose bytes main does not have; they never
    count as pending, so preflight and overlaps are decided by committed and edited files only. Paths in the
    base's stripped-assets manifest are left out of both while their bytes match it: every lane has them
    untracked by design."""
    main_ref = f"refs/foundry/{base}/main"
    main_sha = git("rev-parse", "--verify", main_ref, cwd=repo, check=True).stdout.strip()
    landed = landed_commits(base)
    spec = generated_spec(repo, main_ref)
    generated = set((spec or {}).get("files", []))
    assets = stripped_assets(repo, main_ref, spec)
    now = time.time()
    memo = {}
    lanes = []
    for w in worktrees(repo, unborn=True):
        wt, head = w["path"], w["head"]
        lane = {"path": wt, "branch": w.get("branch"), "head": head}
        if w.get("unborn"):
            lane = orphan_lane(repo, main_ref, lane, wt, now, assets)
            if lane["pending"]:
                lanes.append(lane)
            continue
        lane["last_commit_age_d"] = round((now - int(git("log", "-1", "--format=%ct", head, cwd=repo).stdout or now)) / 86400, 1)
        st = git("status", "--porcelain", "--untracked-files=no", cwd=wt)
        dirty = {l[3:].split(" -> ")[-1] for l in st.stdout.splitlines() if l}
        mtimes = [os.path.getmtime(os.path.join(wt, f)) for f in dirty if os.path.exists(os.path.join(wt, f))]
        lane["dirty_age_d"] = round((now - max(mtimes)) / 86400, 1) if mtimes else None
        untracked = not_on(repo, main_ref, wt, not_assets(wt, _paths(git("ls-files", "--others", "--exclude-standard",
                                                                         "-z", cwd=wt).stdout), assets))
        lane["untracked"] = untracked
        fork = git("merge-base", head, main_ref, cwd=repo).stdout.strip()
        if not fork:
            lane.update(state="unrelated-history", pending=[], dirty=sorted(dirty), active=False)
            lanes.append(lane)
            continue
        # Only commits after the newest landed one are new work; its merge is the real fork point.
        src_from = fork
        own = _lines(git("rev-list", f"{fork}..{head}", cwd=repo).stdout)
        for c in own:
            if c in landed:
                src_from, fork = c, landed[c]
                lane["landed_as"] = fork
                break
        else:
            hit = landed_by_content(repo, main_ref, fork, own, memo) if own else None
            if hit:
                src_from, fork = hit
                lane.update(landed_as=fork, landed_by="content")
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
                    state=("untracked-only" if untracked else "landed") if not pending
                    else "conflicts-with-main" if conflicts or dirty_moved else "clean-pending")
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
    for l in sorted(r["lanes"], key=lambda l: (not l["active"], l["last_commit_age_d"] is None, l["last_commit_age_d"] or 0)):
        extra = ""
        if l.get("merge_conflicts"):
            extra += f"  merge-conflicts: {', '.join(l['merge_conflicts'][:4])}"
        if l.get("dirty_on_moved_files"):
            extra += f"  edited files main also moved: {', '.join(l['dirty_on_moved_files'][:4])}"
        if l.get("landed_by") == "content":
            extra += f"  landed as {l['landed_as'][:8]} (matched by content)"
        age = "-" if l["last_commit_age_d"] is None else l["last_commit_age_d"]
        print(f"{'ACTIVE ' if l['active'] else '       '}{l['state']:<20} {str(l['branch'])[:56]:<56} "
              f"{age:>6}d  pending {len(l['pending']):<4} edited {len(l['dirty']):<4} "
              f"untracked {len(l.get('untracked', [])):<4}{extra}")
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
        if spec.get("chains"):
            body["chains"] = list(spec["chains"])
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


def pact_url():
    f = CONF / "pact-url"
    return os.environ.get("FOUNDRY_PACT_URL") or (f.read_text().strip() if f.exists() else "")


def chain_usable(r):
    """packages/plan-check `usable`: found and typechecking; missing canonical stages describe, never refuse."""
    return bool(r and r.get("found")) and r.get("typechecks") is not False


def plan_check(chains, url=None, post=None):
    """The orchestrator's intake question, asked from the operator side over the tailnet: do the declared chains
    exist and compose? Same verdict shape as packages/plan-check; an outage fails open (checked False, ok True)."""
    if not chains:
        return None
    url = pact_url() if url is None else url
    if not url:
        return {"checked": False, "ok": True, "results": [], "error": "no PACT url ($FOUNDRY_PACT_URL or ~/.config/foundry/pact-url)"}
    def http_post(u, body):
        req = urllib.request.Request(u, method="POST", data=json.dumps(body).encode(),
                                     headers={"content-type": "application/json", "User-Agent": "foundry-ops/1"})
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.loads(r.read())
    try:
        got = (post or http_post)(url.rstrip("/") + "/api/check-chains", {"chains": list(chains)})
    except Exception as e:  # noqa: BLE001 - any failure to ask is "not checked"
        return {"checked": False, "ok": True, "results": [], "error": str(e)[:200]}
    by = {r.get("name"): r for r in (got or {}).get("results") or [] if isinstance(r, dict)}
    results = [by.get(c) or {"name": c, "found": False} for c in chains]
    return {"checked": True, "ok": all(chain_usable(r) for r in results), "results": results}


def plan_lines(plan):
    if not plan["checked"]:
        return [f"  pact: not checked ({plan.get('error')}), landing anyway"]
    out = []
    for r in plan["results"]:
        if not r.get("found"):
            out.append(f"  pact: {r['name']} REFUSED: no such chain in the corpus")
        elif r.get("typechecks") is False:
            out.append(f"  pact: {r['name']} REFUSED: its stages do not compose ({r.get('word', '')})")
        else:
            out.append(f"  pact: {r['name']} ok, {r.get('present', '?')}/4 stages ({r.get('word', '')})")
    return out


# A skill the user typed, as the transcript opens that message. Anywhere later in a message it is only a quotation.
TYPED_SKILL = re.compile(r"\s*(?:<command-message>[^<]*</command-message>\s*)?<command-name>/?([^<\s]+)</command-name>")
# Typed, these are the harness's own commands; `compact` is also a skill, and a chain member.
HARNESS_COMMANDS = {"compact"}


def session_skills(sid, root=None):
    """The skills a Claude session ran, oldest first, its subagents' included. Only structure counts: a Skill tool
    call, or a user message that is a command. Transcripts quote chain names constantly, so text never does."""
    root = pathlib.Path.home() / ".claude/projects" if root is None else pathlib.Path(root)
    runs = []
    for f in [*root.glob(f"*/{sid}.jsonl"), *root.glob(f"*/{sid}/subagents/*.jsonl")]:
        with open(f, errors="ignore") as lines:
            for line in lines:
                if '"Skill"' not in line and "<command-name>" not in line:
                    continue
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                content = (d.get("message") or {}).get("content")
                if d.get("type") == "assistant" and isinstance(content, list):
                    runs += [(d.get("timestamp") or "", b["input"]["skill"]) for b in content
                             if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name") == "Skill"
                             and isinstance(b.get("input"), dict) and b["input"].get("skill")]
                elif d.get("type") == "user" and isinstance(content, str):
                    m = TYPED_SKILL.match(content)
                    if m and m[1] not in HARNESS_COMMANDS:
                        runs.append((d.get("timestamp") or "", m[1]))
    return [name for _, name in sorted(runs, key=lambda r: r[0])]


def corpus_chains(url=None, get=None):
    """PACT's chains with their members; [] when it cannot be asked, which only loses the walked-by-hand reading."""
    url = pact_url() if url is None else url
    if not url:
        return []
    def http_get(u):
        with urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "foundry-ops/1"}), timeout=5) as r:
            return json.loads(r.read())
    try:
        return (get or http_get)(url.rstrip("/") + "/api/chains").get("chains") or []
    except Exception:  # noqa: BLE001 - same as plan_check: PACT down never stops a landing
        return []


def chains_ran(skills, corpus):
    """Chains named outright, then chains whose every member ran in order: agents often walk one skill by skill."""
    def in_order(members):
        run = iter(skills)
        return len(members) >= 2 and all(m in run for m in members)
    named = [s for s in skills if s.startswith("chain:")]
    return list(dict.fromkeys(named + [c["name"] for c in corpus if in_order(c.get("members") or [])]))


def session_chains(sid=None, root=None, url=None, get=None):
    sid = sid or os.environ.get("CLAUDE_CODE_SESSION_ID")
    skills = session_skills(sid, root) if sid else []
    return chains_ran(skills, corpus_chains(url, get)) if skills else []


def commits_of(spec, repo):
    if spec.get("commits"):
        return [sh(["git", "rev-parse", "--verify", c + "^{commit}"], cwd=repo).strip() for c in spec["commits"]]
    if spec.get("range"):
        return sh(["git", "rev-list", "--reverse", "--no-merges", spec["range"]], cwd=repo).split()
    raise SystemExit(f"{spec['task']}: give commits or range")


def decision_for(cf, fork, shas):
    """The newest decision row for any of `shas` pushed to `fork`."""
    shas = [shas] if isinstance(shas, str) else list(shas)
    rows = cf.d1("select id, verdict, reason, merged_sha, decided_at, after_sha from decisions where repo = ? and "
                 f"after_sha in ({', '.join('?' * len(shas))}) order by id desc limit 1", (fork, *shas))
    return rows[0] if rows else None


def wait_decision(cf, fork, shas, timeout):
    """The gate's verdict for any of `shas` (the heads this landing pushed). An `error` row is the gate saying
    it will retry (its queue redelivers, e.g. when the verifier asked for one), not a verdict: keep waiting,
    and return it only if nothing better arrives in time."""
    end, last_error = time.time() + timeout, None
    while time.time() < end:
        d = decision_for(cf, fork, shas)
        if d and d["verdict"] != "error":
            return d
        last_error = d or last_error
        time.sleep(10)
    return last_error


def push_until_decided(cf, fork, wt, wait_s, push=None, attempts=2):
    """Push HEAD to the fork and wait for the gate's verdict; returns (decision, heads pushed).

    A push that leaves no row at all is re-stamped and pushed once more (a push made seconds after a new
    subscription can be dropped), and from then on every head pushed is waited on, not just the newest:
    the gate can still decide the first one. On 2026-11-03 it merged a first push (decision 638) 8 s after
    land stopped waiting for it, and the re-push of the same change became a second event (643)."""
    push = push or (lambda head: sh([str(BIN / "foundry-push"), fork, "HEAD:refs/heads/main", "--force"], cwd=wt))
    heads, d = [], None
    for attempt in range(1, attempts + 1):
        if heads:
            # One last look before making a new event: the verdict may have landed since the wait ended.
            d = decision_for(cf, fork, heads)
            if d:
                break
            log("  no decision row: the push was likely dropped; re-stamping and pushing once more")
        sh(["git", "commit", "--amend", "--no-edit", "--date=now"], cwd=wt)
        head = sh(["git", "rev-parse", "HEAD"], cwd=wt).strip()
        push(head)
        heads.append(head)
        log(f"  pushed {head[:8]} to {fork} (attempt {attempt}); waiting for the gate")
        d = wait_decision(cf, fork, heads, wait_s)
        if d:
            break
    return d, heads


def verifier_verdict(head, log_path=None):
    """The verifier's own account of this push (which tests failed), or None off Mac1."""
    found = None
    try:
        with open(log_path or VERIFY_LOG) as f:
            for line in f:
                if head in line:
                    try:
                        row = json.loads(line)
                    except ValueError:
                        continue
                    if row.get("head") == head and row.get("event") in ("verdict", "skip", "unjudged"):
                        found = row
    except OSError:
        return None
    return found


def land_one(cf, env, spec, dry, ack_overlap=False):
    spec = {"deleteFork": True, **spec}
    repo = str(pathlib.Path(spec["repo"]).expanduser())
    for k in ("base", "task", "agent", "allowedRoots"):
        if not spec.get(k):
            raise SystemExit(f"spec missing {k}: {spec}")
    picks = commits_of(spec, repo)
    log(f"== {spec['task']}: {len(picks)} commit(s) onto {spec['base']}")
    detected = {}
    if "chains" not in spec:
        ran = session_chains()
        if ran:
            spec["chains"], detected = ran, {"chainsFrom": "session"}
            log(f"  chains this session ran: {', '.join(ran)}")
    # PACT before anything is created: a declared chain that does not exist or does not compose stops here.
    plan = plan_check(spec.get("chains") or [])
    if plan:
        for line in plan_lines(plan):
            log(line)
        if plan["checked"] and not plan["ok"]:
            if detected:
                log('  read off this session, not written in the spec; "chains": [] lands without them')
            return {"task": spec["task"], "base": spec["base"], "verdict": "plan-refused", "planCheck": plan, **detected}
    base_ref = f"refs/foundry/{spec['base']}/main"
    sh([str(BIN / "foundry-fetch"), spec["base"], f"+refs/heads/main:{base_ref}"], cwd=repo)
    # Before the task exists: a landing that another active lane would collide with stops here.
    contested = preflight(repo, spec["base"], picks, ack=ack_overlap or bool(spec.get("ackOverlap")))
    t = open_task(env, spec, dry)
    fork = t["forks"][0]
    if dry:
        log(f"  dry run: would open task, subscribe {fork}, cherry-pick {', '.join(c[:8] for c in picks)}, push, wait")
        return {"task": spec["task"], "fork": fork, "dry_run": True, "overlap": contested,
                **({"planCheck": plan} if plan else {})}
    if subscribe(env, fork, t["subscribed"].get(fork)):
        time.sleep(SETTLE_S)
    elif t["new"] and t["subscribed"].get(fork):
        time.sleep(SETTLE_S)  # the orchestrator subscribed it a moment ago
    # The scratch worktree gets its own parent directory, so a recipe's ../sibling links resolve there.
    tmp = tempfile.mkdtemp(prefix=f"land-{spec['task']}-")
    wt = os.path.join(tmp, os.path.basename(repo_top(repo)))
    result = {"task": spec["task"], "fork": fork, "base": spec["base"], "commits": picks, **detected}
    if plan:
        result["planCheck"] = plan
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
        verified = subprocess.run(["git", "cat-file", "-e", f"{base_ref}:.foundry/verify.json"], cwd=repo,
                                  capture_output=True).returncode == 0
        wait_s = VERIFIED_DECISION_WAIT_S if verified else DECISION_WAIT_S
        if verified:
            log(f"  {spec['base']} verifies merges (.foundry/verify.json): waiting up to {wait_s // 60} min")
        d, heads = push_until_decided(cf, fork, wt, wait_s)
        # The head the verdict is about, which is not always the last one pushed.
        head = (d or {}).get("after_sha") or heads[-1]
        result.update(pushed=head, decision=d)
        if len(heads) > 1:
            result["pushes"] = heads
        if not d:
            result["verdict"] = "no-decision"
            return result
        result["verdict"] = d["verdict"]
        if d["verdict"] != "merge":
            if "verification_failed" in str(d.get("reason")):
                v = verifier_verdict(head)
                result["verification"] = (v.get("summary") or v.get("error")) if v else \
                    f"see {VERIFY_LOG} on Mac1 for head {head[:12]}"
                log(f"  verification failed: {result['verification']}")
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
            later = [h for h in heads if h != head]
            if later:
                # Let the gate finish the duplicate push before its fork goes; a missing fork is an error it retries.
                log(f"  waiting for the gate to settle {', '.join(h[:8] for h in later)} before deleting the fork")
                wait_decision(cf, fork, later, DECISION_WAIT_S)
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

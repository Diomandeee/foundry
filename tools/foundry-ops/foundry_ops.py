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

Credentials never reach output: the Cloudflare token comes from `wrangler auth token` and stays in memory,
the task token is read from its 0600 file, saved task responses are written 0600 and only allowlisted fields
are ever read back. Git pushes go through foundry-push / foundry-fetch, which hand tokens to git via askpass.
"""
import argparse, datetime, json, os, pathlib, subprocess, sys, tempfile, time, urllib.error, urllib.parse, urllib.request

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


def land_one(cf, env, spec, dry):
    spec = {"deleteFork": True, **spec}
    repo = str(pathlib.Path(spec["repo"]).expanduser())
    for k in ("base", "task", "agent", "allowedRoots"):
        if not spec.get(k):
            raise SystemExit(f"spec missing {k}: {spec}")
    picks = commits_of(spec, repo)
    log(f"== {spec['task']}: {len(picks)} commit(s) onto {spec['base']}")
    t = open_task(env, spec, dry)
    fork = t["forks"][0]
    if dry:
        log(f"  dry run: would open task, subscribe {fork}, cherry-pick {', '.join(c[:8] for c in picks)}, push, wait")
        return {"task": spec["task"], "fork": fork, "dry_run": True}
    if subscribe(env, fork, t["subscribed"].get(fork)):
        time.sleep(SETTLE_S)
    elif t["new"] and t["subscribed"].get(fork):
        time.sleep(SETTLE_S)  # the orchestrator subscribed it a moment ago
    base_ref = f"refs/foundry/{spec['base']}/main"
    sh([str(BIN / "foundry-fetch"), spec["base"], f"+refs/heads/main:{base_ref}"], cwd=repo)
    wt = tempfile.mkdtemp(prefix=f"land-{spec['task']}-")
    result = {"task": spec["task"], "fork": fork, "base": spec["base"], "commits": picks}
    try:
        sh(["git", "worktree", "add", "--detach", wt, t["baseSha"] or base_ref], cwd=repo)
        p = sh(["git", "cherry-pick", "--allow-empty", *picks], cwd=wt, check=False, quiet=True)
        if p.returncode != 0:
            sh(["git", "cherry-pick", "--abort"], cwd=wt, check=False)
            result["verdict"] = "local-conflict"
            result["detail"] = p.stderr.strip()[-400:]
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
        return result
    finally:
        sh(["git", "worktree", "remove", "--force", wt], cwd=repo, check=False)


def cmd_land(a):
    specs = json.loads(pathlib.Path(a.spec).read_text())
    specs = specs if isinstance(specs, list) else [specs]
    cf = None if a.dry_run else Cloudflare(a.env)
    results = []
    for s in specs:
        r = land_one(cf, a.env, s, a.dry_run)
        results.append(r)
        with open(CONF / "land-log.jsonl", "a") as f:
            f.write(json.dumps({"at": datetime.datetime.now().isoformat(timespec="seconds"), **r}) + "\n")
        log(f"  -> {r.get('verdict', 'dry-run')}" + (f" {r['decision']['merged_sha'][:8]}" if r.get("verdict") == "merge" else ""))
        if not a.dry_run and r.get("verdict") != "merge" and not a.keep_going:
            log("stopping: the next item would land on a base this one did not move (use --keep-going to continue)")
            break
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
    l.add_argument("--keep-going", action="store_true"); l.set_defaults(fn=cmd_land)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()

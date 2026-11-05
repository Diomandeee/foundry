#!/usr/bin/env python3
"""Foundry gate verifier: build and test what a merge would produce, on a fleet worker, before the gate merges it.

The gate (workers/gate, VERIFY_URL) calls POST <VERIFY_URL>/api/verify with {repo, baseBranch, files, headSha}
after admission and before the merge, and refuses the merge when a check ran and failed (VERIFY_ENFORCE=1).
This server answers that call:

  1. Map the fork to its base: ~/.config/foundry/task-<task>.json (written by foundry_ops land) names it.
     A base not listed in ~/.config/foundry/verify.json gets {"runs": []}: "nothing checked", never a pass.
  2. Fetch the base main and the fork head. Read the recipe, .foundry/verify.json, from the BASE main, so a
     proposal cannot rewrite the check that judges it.
  3. Rebuild the tree the gate would write: base main with the fork's changes since its fork point overlaid
     (the gate squashes whole files, and it has already refused any path both sides changed). Copy in the
     stripped assets listed in .foundry/assets.json, checked against their sha256.
  4. Run the recipe on a worker: ~/fleet/bin/fabric job run --sync <tree> --link ... -- <command>.
     A link is a local directory ("../SharedServices": "~/Developer/SharedServices") or another base's
     merged tree ("../MotionMix/x": {"base": "motionmix", "path": "x"}): that base's main is fetched and
     `path` exported from it, so the app is checked against what its sibling has merged, never against a
     working tree another lane is editing. The linked shas key main's cached baseline with main's own.
  5. Pass when no test fails that does not also fail on base main. Main's failures are measured once per
     main sha (cached), and only when the candidate has failures, so a red main never blocks the fix for it.

A change confined to the recipe's `skip` globs (docs) is reported as a passing "skipped" check, with that
word in its output. A guarded base never merges unjudged: anything that keeps the server from judging
(fetch failure, worker outage, deadline, a crash) is a 503 with {"retry": true}, which the gate turns into
an `error` row and a queue retry. Only a verifier that cannot be reached at all reads as "not checked".
A busy worker is waited on for FORCE_AFTER_S, then the job runs with --force.

Mac1 only orchestrates: the build runs on the worker named in the recipe. One run at a time; queued
requests count against their own deadline.

  verify_server.py serve [--port 8803]
  verify_server.py check REPO HEAD_SHA        run one verification from the command line, print the result

Config ~/.config/foundry/verify.json:
  {"bases": {"motionmixapp": {"sources": ["~/Developer/MotionMixApp"]}}, "token_file": "~/.config/foundry/verify-token"}
The token is the first path segment of VERIFY_URL; every other path is a 404.
"""

import argparse
import fnmatch
import hashlib
import hmac
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = os.path.expanduser("~")
CONFIG = os.path.join(HOME, ".config", "foundry", "verify.json")
TASKS = os.path.join(HOME, ".config", "foundry")
FETCH = os.path.join(HOME, ".config", "foundry", "bin", "foundry-fetch")
FABRIC = os.path.join(HOME, "fleet", "bin", "fabric")
ROOT = os.path.join(HOME, ".fleet", "verify")
DEFAULT_DEADLINE_S = 780  # under the gate's VERIFY_TIMEOUT_MS (840 s), itself under the 15 min queue wall
RUN_LOCK = threading.Lock()


class Unjudged(Exception):
    """The server could not judge a change on a base it guards. Becomes a 503 with "retry": the gate
    records an error and retries the push, so an unjudged change never merges as if it were checked."""


def log(event, **kw):
    os.makedirs(ROOT, exist_ok=True)
    with open(os.path.join(ROOT, "verify.log"), "a") as f:
        f.write(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "event": event, **kw}) + "\n")


def load_config():
    try:
        with open(CONFIG) as f:
            return json.load(f)
    except OSError:
        return {"bases": {}}


def git(repo, *args, check=True, input=None):
    r = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, input=input)
    if check and r.returncode:
        raise Unjudged(f"git {' '.join(args[:3])}: {(r.stderr or r.stdout).strip()[-200:]}")
    return r.stdout


def base_of(repo):
    """The base a fork belongs to, from the task file foundry_ops land saved when it opened the task."""
    task = repo.split("--", 1)[0]
    try:
        with open(os.path.join(TASKS, f"task-{task}.json")) as f:
            return json.load(f).get("baseRepo")
    except (OSError, ValueError):
        return None


# ---- the tree the gate would write ----

def changes(repo, fork_point, head):
    """(added_or_modified, deleted) on the fork since its fork point: the paths the gate would land."""
    out = git(repo, "diff", "--name-status", "--no-renames", "-z", fork_point, head)
    parts, upserts, deletes = out.split("\0"), [], []
    for status, path in zip(parts[0::2], parts[1::2]):
        (deletes if status.startswith("D") else upserts).append(path)
    return upserts, deletes


def build_tree(repo, main_ref, head):
    """Check out base main and overlay the fork's changes. Returns the changed paths."""
    fork_point = git(repo, "merge-base", main_ref, head).strip()
    if not fork_point:
        raise Unjudged("fork shares no history with base main")
    upserts, deletes = changes(repo, fork_point, head)
    git(repo, "checkout", "-q", "-f", "--detach", main_ref)
    git(repo, "clean", "-q", "-ffd")  # excluded (asset) files survive: see ensure_assets
    if upserts:
        git(repo, "checkout", "-q", head, "--pathspec-from-file=-", "--pathspec-file-nul", input="\0".join(upserts))
    if deletes:
        git(repo, "rm", "-q", "-f", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul",
            input="\0".join(deletes))
    return upserts + deletes


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def blob_at(commit, path, repos, origin, cache):
    """(bytes, mode) of path at commit, read from a local clone (objects only, nothing checked out) or,
    failing that, from a blob-less cache of the manifest's origin that fetches the one blob it needs."""
    spec = f"{commit}:{path}"
    for r in repos:
        r = os.path.expanduser(r)
        if subprocess.run(["git", "-C", r, "cat-file", "-e", spec], capture_output=True).returncode == 0:
            break
    else:
        if not origin:
            return None
        if not os.path.isdir(cache):
            subprocess.run(["git", "init", "-q", "--bare", cache], capture_output=True)
        r = cache
        if subprocess.run(["git", "-C", r, "cat-file", "-e", commit + "^{commit}"], capture_output=True).returncode:
            subprocess.run(["git", "-C", r, "fetch", "-q", "--filter=blob:none", "--depth=1", origin, commit],
                           capture_output=True, timeout=120)
    ls = subprocess.run(["git", "-C", r, "ls-tree", commit, "--", path], capture_output=True, text=True).stdout.split()
    data = subprocess.run(["git", "-C", r, "cat-file", "blob", spec], capture_output=True, timeout=120)
    if data.returncode or not ls:
        return None
    return data.stdout, ls[0]


def ensure_assets(repo, main_ref, sources, cache=None):
    """Put in the binaries the seed stripped, each matched by sha256. Returns (placed, unmatched).

    Every manifest entry is materialized, so each merge proves the manifest complete: first an APFS clone
    of a source checkout's file (no extra disk), else the blob at the entry's origin_commit (or the
    manifest's). An unmatched asset means the build used a different binary than main declares."""
    try:
        manifest = json.loads(git(repo, "show", f"{main_ref}:.foundry/assets.json"))
    except (Unjudged, ValueError):
        return 0, []
    cache = cache or os.path.join(os.path.dirname(repo), "origin.git")
    exclude = os.path.join(repo, git(repo, "rev-parse", "--git-path", "info/exclude").strip())
    os.makedirs(os.path.dirname(exclude), exist_ok=True)
    have = set(open(exclude).read().splitlines()) if os.path.exists(exclude) else set()
    placed, unmatched, new_excludes = 0, [], []
    for item in manifest.get("stripped", []):
        rel, want = item["path"], item.get("sha256")
        if "/" + rel not in have:
            new_excludes.append("/" + rel)
        dst = os.path.join(repo, rel)
        if os.path.exists(dst) and (not want or sha256(dst) == want):
            continue
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if os.path.lexists(dst):
            os.remove(dst)
        src = next((os.path.join(os.path.expanduser(s), rel) for s in sources
                    if os.path.isfile(os.path.join(os.path.expanduser(s), rel))), None)
        if src and (not want or sha256(src) == want):
            if subprocess.run(["cp", "-c", src, dst], capture_output=True).returncode:
                shutil.copy2(src, dst)
            placed += 1
            continue
        commit = item.get("origin_commit") or manifest.get("origin_commit")
        blob = blob_at(commit, rel, sources, manifest.get("origin"), cache) if commit else None
        if blob and (not want or hashlib.sha256(blob[0]).hexdigest() == want):
            with open(dst, "wb") as f:
                f.write(blob[0])
            os.chmod(dst, 0o755 if blob[1] == "100755" else 0o644)
            placed += 1
            continue
        unmatched.append(rel)
        if src:  # the build gets the local binary, flagged, rather than none
            if subprocess.run(["cp", "-c", src, dst], capture_output=True).returncode:
                shutil.copy2(src, dst)
    if new_excludes:
        with open(exclude, "a") as f:
            f.write("\n".join(new_excludes) + "\n")
    return placed, unmatched


# ---- running the recipe on a worker ----

def parse_xcodebuild(text):
    """{'executed': int|None, 'skipped': int, 'failing': set, 'build_failed': bool, 'ids': {name: id}} from an
    xcodebuild test log. `ids` maps a failing test's summary name ("Class.test()") to its -only-testing identifier.
    `executed` counts skipped tests too, as xcodebuild does ("Executed 3 tests, with 3 tests skipped and 0 failures")."""
    executed, skipped = None, 0
    ids = {m.group(2) + "." + m.group(3) + "()": f"{m.group(1)}/{m.group(2)}/{m.group(3)}"
           for m in re.finditer(r"Test Case '-\[(\w+)\.(\w+) (\w+)\]' failed", text)}
    for m in re.finditer(r"Executed (\d+) tests?, with (?:(\d+) tests? skipped and )?\d+ failures?", text):
        executed, skipped = int(m.group(1)), int(m.group(2) or 0)
    failing, in_block = set(), False
    for line in text.splitlines():
        if line.startswith("Failing tests:"):
            in_block = True
            continue
        if in_block:
            m = re.match(r"^\s+(\S+\(\))\s*$", line)
            if m:
                failing.add(m.group(1))
            elif line.strip():
                in_block = False
    build_failed = "** BUILD FAILED **" in text or (executed is None and "** TEST FAILED **" in text)
    if executed is None and "** TEST SUCCEEDED **" not in text:
        build_failed = True
    return {"executed": executed, "skipped": skipped, "failing": failing, "build_failed": build_failed,
            "ids": {k: v for k, v in ids.items() if k in failing}}


FORCE_AFTER_S = 180  # a busy worker gets this long to make room; then the gate's check runs anyway


def run_job(repo, recipe, name, deadline):
    """Run the recipe on its worker; return the parsed result. Raises Unjudged on outage or deadline.

    A worker over its placement floors (other lanes' builds) is waited on, then overridden with --force:
    the recipe has its own simulator and DerivedData, so running beside other jobs is slow, not wrong."""
    cmd = [FABRIC, "job", "run", "--host", recipe.get("host", "auto"), "--need", recipe.get("need", "sims"),
           "--name", name, "--by", "foundry-verify", "--sync", repo]
    for rel, src in (recipe.get("links") or {}).items():
        cmd += ["--link", f"{rel}={os.path.expanduser(src)}"]
    tail = ["--", *recipe["command"]]
    waited_since = time.time()
    while True:
        force = ["--force"] if time.time() - waited_since >= FORCE_AFTER_S else []
        r = subprocess.run(cmd + force + tail, capture_output=True, text=True,
                           timeout=max(30, deadline - time.time()))
        m = re.search(r"started (job-\S+) on (\S+)", r.stdout)
        if m:
            break
        busy = re.search(r"load:|memory|no host has room|use --force", r.stderr + r.stdout)
        if not busy or force or time.time() + 60 > deadline:
            raise Unjudged(f"worker did not start the job: {(r.stderr or r.stdout).strip()[-200:]}")
        log("worker-busy", name=name, detail=(r.stderr or r.stdout).strip()[-120:])
        time.sleep(20)
    jid = m.group(1)
    while True:
        if time.time() > deadline:
            subprocess.run([FABRIC, "job", "stop", jid], capture_output=True)
            raise Unjudged(f"{jid} ran past the deadline; stopped")
        time.sleep(10)
        ls = subprocess.run([FABRIC, "job", "ls"], capture_output=True, text=True).stdout
        row = next((l.split() for l in ls.splitlines() if l.startswith(jid)), None)
        if row and row[2] in ("done", "failed"):
            break
        if row and row[2] in ("lost", "stopped"):
            raise Unjudged(f"{jid} {row[2]}")
    text = subprocess.run([FABRIC, "job", "log", jid, "--lines", "200000"], capture_output=True, text=True).stdout
    res = parse_xcodebuild(text)
    res["job"] = jid
    return res


def resolve_links(repo, recipe, work):
    """The recipe with every base link exported to a local directory, and the shas those links were read at.

    {"base": B, "path": P} fetches B's main into refs/verify/link/B and exports P at that commit to
    <work>/links/B-<sha12>/P, once per sha. Anything that keeps a link from resolving is Unjudged: a build
    against a missing sibling would fail for a reason that is not the change's."""
    links, pinned = {}, {}
    for rel, src in (recipe.get("links") or {}).items():
        if isinstance(src, str):
            links[rel] = src
            continue
        lbase, lpath = str(src.get("base", "")), str(src.get("path", "")).strip("/")
        if not re.fullmatch(r"[A-Za-z0-9._-]+", lbase) or not lpath or ".." in lpath.split("/"):
            raise Unjudged(f"link {rel}: wants {{base, path}}, got {src!r}")
        ref = f"refs/verify/link/{lbase}"
        r = subprocess.run([FETCH, lbase, "-q", f"+refs/heads/main:{ref}"], cwd=repo, capture_output=True, text=True)
        if r.returncode:
            raise Unjudged(f"fetch link {lbase}: {(r.stderr or r.stdout).strip()[-160:]}")
        sha = git(repo, "rev-parse", ref).strip()
        dest = os.path.join(work, "links", f"{lbase}-{sha[:12]}")
        if not os.path.isdir(os.path.join(dest, lpath)):
            tmp = dest + ".part"
            shutil.rmtree(tmp, ignore_errors=True)
            os.makedirs(tmp)
            archive = subprocess.run(["git", "-C", repo, "archive", "--format=tar", sha, "--", lpath], capture_output=True)
            if archive.returncode:
                raise Unjudged(f"link {lbase}:{lpath}: {archive.stderr.decode(errors='replace').strip()[-160:]}")
            subprocess.run(["tar", "-x", "-C", tmp], input=archive.stdout, check=True, capture_output=True)
            shutil.rmtree(dest, ignore_errors=True)
            os.rename(tmp, dest)
        links[rel] = os.path.join(dest, lpath)
        pinned[lbase] = sha
    return {**recipe, "links": links}, pinned


def baseline(repo, base, main_sha, recipe, deadline, cache_dir, pinned=None):
    """Main's own failures at this sha (and at these linked shas), measured once."""
    key = main_sha[:12] + "".join(f"-{b}{sha[:12]}" for b, sha in sorted((pinned or {}).items()))
    path = os.path.join(cache_dir, f"baseline-{key}.json")
    try:
        with open(path) as f:
            d = json.load(f)
            return {**d, "failing": set(d["failing"])}
    except (OSError, ValueError, KeyError):
        pass
    git(repo, "checkout", "-q", "-f", "--detach", main_sha)
    git(repo, "clean", "-q", "-ffd")
    res = run_job(repo, recipe, f"verify-{base}-main", deadline)
    with open(path, "w") as f:
        json.dump({**res, "failing": sorted(res["failing"])}, f)
    return res


def rerun(repo, recipe, base, cand, new, deadline):
    """The new failures that pass when run again on their own: flaky, not the change's doing.

    A test counts only if the rerun executed it; one the rerun could not name or select stays a failure."""
    ids = {t: cand.get("ids", {}).get(t) for t in new}
    ids = {t: i for t, i in ids.items() if i}
    cmd = list(recipe["command"])
    if not ids or "test" not in cmd:
        return set()
    at = cmd.index("test") + 1
    cmd[at:at] = [f"-only-testing:{i}" for i in sorted(ids.values())]
    res = run_job(repo, {**recipe, "command": cmd}, f"verify-{base}-rerun", deadline)
    if res["build_failed"] or (res["executed"] or 0) < len(ids):
        return set()
    return set(ids) - res["failing"]


def judge(cand, base_res, flaky=frozenset()):
    """(ok, summary). New failures are what the change adds over main, less the ones a rerun passed."""
    if cand["build_failed"]:
        if base_res is not None and base_res["build_failed"]:
            return True, "does not build, and neither does base main"
        return False, "does not build (" + cand["job"] + ")"
    new = sorted(cand["failing"] - (base_res["failing"] if base_res else set()) - set(flaky))
    tested = f"{cand['executed']} tests" + (f" ({cand['skipped']} skipped)" if cand.get("skipped") else "")
    if flaky:
        tested += f", {len(flaky)} flaky (failed, then passed on rerun): " + ", ".join(sorted(flaky))
    if not new:
        known = len(cand["failing"])
        return True, tested + (f", {known} failing as on main" if known else ", 0 failing") + f" ({cand['job']})"
    return False, tested + f", {len(new)} new failing: " + ", ".join(new)


def verify(req, cfg=None, now=None):
    """The whole check for one gate request. Returns the response body {"runs": [...]}."""
    cfg = cfg or load_config()
    started = now or time.time()
    repo_name, head = str(req.get("repo", "")), str(req.get("headSha", ""))
    branch = str(req.get("baseBranch") or "main")
    base = base_of(repo_name)
    if not base or base not in cfg.get("bases", {}) or not re.fullmatch(r"[0-9a-f]{40}", head):
        return {"runs": []}
    bcfg = cfg["bases"][base]
    deadline = started + bcfg.get("deadline_s", DEFAULT_DEADLINE_S)
    work = os.path.join(ROOT, base)
    repo = os.path.join(work, "tree")
    if not os.path.exists(os.path.join(repo, ".git")):
        # The git dir lives beside the tree, so the worker sync copies a one-line .git file, not the history.
        os.makedirs(work, exist_ok=True)
        r = subprocess.run(["git", "init", "-q", "--separate-git-dir", os.path.join(work, "git"), repo],
                           capture_output=True, text=True)
        if r.returncode:
            raise Unjudged("git init: " + r.stderr.strip()[-160:])
    with RUN_LOCK:
        if time.time() > deadline:
            raise Unjudged("waited past the deadline for an earlier verification")
        for remote, refspec in ((base, "+refs/heads/main:refs/verify/main"),
                                (repo_name, f"+refs/heads/{branch}:refs/verify/head")):
            r = subprocess.run([FETCH, remote, "-q", refspec], cwd=repo, capture_output=True, text=True)
            if r.returncode:
                raise Unjudged(f"fetch {remote}: {(r.stderr or r.stdout).strip()[-160:]}")
        if git(repo, "rev-parse", "refs/verify/head").strip() != head:
            git(repo, "cat-file", "-e", head + "^{commit}")  # the fork moved on; the pushed sha must still be here
        main_sha = git(repo, "rev-parse", "refs/verify/main").strip()
        try:
            recipe = json.loads(git(repo, "show", "refs/verify/main:.foundry/verify.json"))
        except (Unjudged, ValueError):
            return {"runs": []}
        paths = build_tree(repo, "refs/verify/main", head)
        skip = recipe.get("skip") or []
        if paths and all(any(fnmatch.fnmatch(p, g) for g in skip) for p in paths):
            log("skip", base=base, repo=repo_name, head=head, paths=paths[:20])
            return {"runs": [{"name": recipe.get("name", "build+test"), "ok": True,
                              "output": f"skipped: {len(paths)} path(s), all docs ({', '.join(paths[:3])})"}]}
        copied, unmatched = ensure_assets(repo, "refs/verify/main", bcfg.get("sources", []))
        recipe, pinned = resolve_links(repo, recipe, work)
        cand = run_job(repo, recipe, f"verify-{base}", deadline)
        base_res = None
        if cand["build_failed"] or cand["failing"]:
            base_res = baseline(repo, base, main_sha, recipe, deadline, work, pinned)
        flaky = set()
        new = cand["failing"] - (base_res["failing"] if base_res else set())
        if new and not cand["build_failed"]:
            build_tree(repo, "refs/verify/main", head)  # the baseline may have left main checked out
            flaky = rerun(repo, recipe, base, cand, new, deadline)
        ok, summary = judge(cand, base_res, flaky)
        if unmatched:
            summary += f"; {len(unmatched)} asset(s) not as main declares"
        log("verdict", base=base, repo=repo_name, head=head, main=main_sha, links=pinned, ok=ok, summary=summary,
            secs=int(time.time() - started), assets_copied=copied, assets_unmatched=unmatched[:20])
        return {"runs": [{"name": recipe.get("name", "build+test"), "ok": ok, "output": summary}]}


# ---- HTTP ----

def make_handler(token):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code, body):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _authorized(self, suffix):
            parts = self.path.split("?", 1)[0].strip("/").split("/", 1)
            return len(parts) == 2 and hmac.compare_digest(parts[0], token) and parts[1] == suffix

        def do_GET(self):
            if self._authorized("health"):
                return self._send(200, {"ok": True, "busy": RUN_LOCK.locked()})
            self._send(404, {})

        def do_POST(self):
            if not self._authorized("api/verify"):
                return self._send(404, {})
            try:
                n = int(self.headers.get("content-length") or 0)
                req = json.loads(self.rfile.read(min(n, 1 << 20)) or b"{}")
            except ValueError:
                return self._send(400, {"error": "bad json"})
            try:
                self._send(200, verify(req))
            except Unjudged as e:
                log("unjudged", repo=req.get("repo"), head=req.get("headSha"), error=str(e)[:300])
                self._send(503, {"retry": True, "error": str(e)[:300]})
            except Exception as e:  # a guarded base must not merge unjudged: retry, as for Unjudged
                log("crash", repo=req.get("repo"), head=req.get("headSha"), error=repr(e)[:300])
                self._send(503, {"retry": True, "error": "verifier crashed"})

        def log_message(self, *a):
            pass  # the token is in every path; keep it out of stderr

    return Handler


def read_token(cfg):
    path = os.path.expanduser(cfg.get("token_file", "~/.config/foundry/verify-token"))
    with open(path) as f:
        tok = f.read().strip()
    if len(tok) < 32:
        sys.exit(f"{path}: token too short")
    return tok


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve")
    s.add_argument("--port", type=int, default=8803)
    c = sub.add_parser("check")
    c.add_argument("repo")
    c.add_argument("head")
    c.add_argument("--branch", default="main")
    a = ap.parse_args()
    if a.cmd == "check":
        try:
            print(json.dumps(verify({"repo": a.repo, "headSha": a.head, "baseBranch": a.branch}), indent=1))
        except Unjudged as e:
            sys.exit(f"not checked: {e}")
        return
    server = ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(read_token(load_config())))
    log("serve", port=a.port)
    server.serve_forever()


if __name__ == "__main__":
    main()

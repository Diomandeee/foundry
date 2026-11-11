#!/usr/bin/env python3
"""Foundry gate verifier: build and test what a merge would produce, on a fleet worker, before the gate merges it.

The gate (workers/gate, VERIFY_URL) calls POST <VERIFY_URL>/api/verify with {repo, baseBranch, files, headSha}
after admission and before the merge, and refuses the merge when a check ran and failed (VERIFY_ENFORCE=1).
This server answers that call:

  1. Map the fork to its base: ~/.config/foundry/task-<task>.json (written by foundry_ops land) names it.
     A base not listed in ~/.config/foundry/verify.json gets {"runs": []}: "nothing checked", never a pass.
  2. Fetch the base main and the fork head. Read the recipe, .foundry/verify.json, from the BASE main, so a
     proposal cannot rewrite the check that judges it. The one exception is a proposal that only moves the
     recipe to another simulator: otherwise a simulator that is gone would block the change that replaces it.
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
     A real compile failure main shares passes for the same reason. A run that never got as far as the code
     (no such simulator, unresolved packages, a test runner that never started, zero tests) says nothing
     about the change, on either side, so it is unjudged and never cached.

A recipe is one check, or several under "checks": each has its own name, command and, optionally, `when`
globs (it runs only when a changed path matches one), and inherits host, need, links and parse from the top.
A monorepo names a check per part, so a change to the web app does not wait on the iOS build. Changed paths
no check covers are logged as uncovered; when no check applies at all the answer is {"runs": []}, "nothing
checked". `parse` names what reads the log: "xcodebuild" (the default, alone in its check) or a list of
"unittest", "pytest", "swift", "vitest", "xcbuild", "tsc", "exit" for a command that runs those. Every runner
named must leave a result in the log, unless one that did run already failed. "exit" judges a step with
nothing to parse by its exit status. A command that cannot set itself up (npm ci, a venv) exits 75, which
is unjudged, never "does not build".

A change confined to the recipe's `skip` globs (docs) is reported as a passing "skipped" check, with that
word in its output. The gate's receipt keeps only a run's name, so the name carries what happened:
"<check> [537 tests]", "<check> [skipped: docs only]". A guarded base never merges unjudged: anything that keeps the server from judging
(fetch failure, worker outage, deadline, a run that never reached the code, a crash) is a 503 with {"retry": true}, which the gate turns into
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

# xcodebuild prints these only when the build itself ran and failed.
COMPILE_FAILED = ("** BUILD FAILED **", "The following build commands failed:",
                  "Testing cancelled because the build failed")


def unreached(text, executed):
    """Why this log says nothing about the code, or None when it does.

    It has to show tests running, a compile failing, or a recipe's own test step failing before xcodebuild
    (Fabric runs the bridge's unittest first). Anything else never got that far: a destination that does not
    exist exits 70 with none of xcodebuild's result markers, and both sides of the comparison fail alike."""
    if executed or any(m in text for m in COMPILE_FAILED) or re.search(
            r"^(?:FAILED \((?:failures|errors)=|Test case '.*' (?:passed|failed) on )", text, re.M):  # parallel runs print no "Executed"
        return None
    m = re.search(r"^(?:xcodebuild: error: |Testing failed:\n\s*)(.+)$", text, re.M)
    return m.group(1).strip() if m else "no compile failure and no tests in the log"


def parse_xcodebuild(text):
    """{'executed': int|None, 'skipped': int, 'failing': set, 'build_failed': bool, 'unreached': str|None,
    'ids': {name: id}} from an xcodebuild test log. `ids` maps a failing test's summary name ("Class.test()") to its
    -only-testing identifier. `executed` counts skipped tests too, as xcodebuild does ("Executed 3 tests, with 3 tests
    skipped and 0 failures"). `unreached` is set when the run never got as far as the code, and says why."""
    executed, skipped = None, 0
    ids = {m.group(2) + "." + m.group(3) + "()": f"{m.group(1)}/{m.group(2)}/{m.group(3)}"
           for m in re.finditer(r"Test Case '-\[(\w+)\.(\w+) (\w+)\]' failed", text)}
    for m in re.finditer(r"Executed (\d+) tests?, with (?:(\d+) tests? skipped and )?\d+ failures?", text):
        executed, skipped = int(m.group(1)), int(m.group(2) or 0)
    # Swift Testing runs inside the same xcodebuild test and reports apart from XCTest, whose count can be 0
    # (Serenity's iOS tests are all @Test: "Executed 0 tests", then "Test run with 237 tests in 55 suites passed").
    swift_testing = [int(n) for n in re.findall(r"Test run with (\d+) tests? in \d+ suites? (?:passed|failed)", text)]
    if swift_testing:
        executed = (executed or 0) + sum(swift_testing)
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
    failing |= {name.strip() for name in re.findall(r"^\S+ Test (?!run with )(.+?) failed after ", text, re.M)}
    build_failed = "** BUILD FAILED **" in text or (executed is None and "** TEST FAILED **" in text)
    if executed is None and "** TEST SUCCEEDED **" not in text:
        build_failed = True
    return {"executed": executed, "skipped": skipped, "failing": failing, "build_failed": build_failed,
            "unreached": unreached(text, executed), "ids": {k: v for k, v in ids.items() if k in failing}}


# ---- runners other than xcodebuild ----
# Each returns None when its runner left no result in the log, else {"executed", "skipped", "failing",
# "build_failed"}. Failing names are the runner's own ids, the same on base main as on the candidate.

ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def parse_unittest(text):
    """python -m unittest: "Ran N tests", then OK or FAILED, with a FAIL:/ERROR: header per failure.
    A module that does not import is an ERROR on unittest.loader._FailedTest, so it has a name too."""
    ran = re.findall(r"^Ran (\d+) tests? in ", text, re.M)
    if not ran:
        return None
    failing = set()
    for method, where in re.findall(r"^(?:FAIL|ERROR): (\S+) \(([\w.]+)\)", text, re.M):
        # 3.11+ prints module.Class.method in the brackets, older Pythons module.Class
        failing.add(where if where.endswith("." + method) else f"{where}.{method}")
    skipped = sum(int(n) for n in re.findall(r"^(?:OK|FAILED) \((?:[^)]*, )?skipped=(\d+)", text, re.M))
    return {"executed": sum(map(int, ran)), "skipped": skipped, "failing": failing, "build_failed": False}


def parse_tsc(text):
    """tsc --noEmit says nothing when the types hold, so it is never required to be in the log. Each file with
    an error is a failure named for the file: a type error base main already has does not block."""
    files = set(re.findall(r"^(\S+?)\(\d+,\d+\): error TS\d+", text, re.M))
    if not files:
        return None
    return {"executed": 0, "skipped": 0, "failing": {f"tsc {f}" for f in files}, "build_failed": False}


def parse_pytest(text):
    """pytest: the closing "N failed, M passed in 1.2s" line, with a FAILED or ERROR line per failure in the
    short summary (-rfE, the default). A file that does not import is an ERROR named for the file."""
    # A count can be two words ("47 subtests passed" from pytest-subtests), which counts as neither passed nor failed.
    totals = [m.group(1) for m in re.finditer(r"^=* ?((?:\d+ [a-z]+(?: [a-z]+)?(?:, )?)+) in [\d.]+s(?: \([\d:]+\))? ?=*$",
                                              text, re.M)]
    if not totals:
        return None
    count = {}
    for line in totals:
        for n, word in re.findall(r"(\d+) ([a-z]+)", line):
            count[word] = count.get(word, 0) + int(n)
    failing = set(re.findall(r"^(?:FAILED|ERROR) (\S+\.py(?:::\S+)?)", text, re.M))
    ran = sum(count.get(w, 0) for w in ("passed", "failed", "skipped", "xfailed", "xpassed", "error", "errors"))
    return {"executed": ran, "skipped": count.get("skipped", 0), "failing": failing, "build_failed": False}


def parse_swift(text):
    """swift test: XCTest's "Test Case '-[Module.Class method]' failed" and its closing "Executed N tests" under
    'All tests', and Swift Testing's "Test run with N tests". A package that does not compile prints the
    compiler's "file.swift:1:2: error:" and never gets to either."""
    xct = re.findall(r"^Test Suite 'All tests' (?:passed|failed) at .*\n\s*Executed (\d+) tests?, with "
                     r"(?:(\d+) tests? skipped and )?\d+ failures?", text, re.M)
    swt = re.findall(r"Test run with (\d+) tests? in \d+ suites? (?:passed|failed)", text)
    compile_failed = bool(re.search(r"^\S+\.(?:swift|c|cpp|h|m|mm):\d+:\d+: error: ", text, re.M)) and not xct
    if not xct and not swt and not compile_failed:
        return None
    failing = {f"{mod}.{cls}.{name}" for mod, cls, name in
               re.findall(r"^Test Case '-\[(\w+)\.(\w+) (\w+)\]' failed", text, re.M)}
    failing |= {name.strip() for name in re.findall(r"^\S+ Test (?!run with )(.+?) failed after ", text, re.M)}
    return {"executed": sum(int(n) for n, _ in xct) + sum(map(int, swt)),
            "skipped": sum(int(k or 0) for _, k in xct), "failing": failing, "build_failed": compile_failed}


def parse_vitest(text):
    """vitest run: "Tests  1 failed | 67 passed (68)", with a " FAIL  file > suite > test" line per failure.
    A file that does not load is " FAIL  file [ file ]" and is named for the file."""
    totals = re.findall(r"^\s*Tests\s+(.+?) \((\d+)\)\s*$", text, re.M)
    files = re.findall(r"^\s*Test Files\s+(.+?) \((\d+)\)\s*$", text, re.M)
    if not totals and not files:
        return None
    failing = {re.sub(r"\s*\[ .* \]$", "", name) for name in re.findall(r"^\s*FAIL\s+(\S.*?)\s*$", text, re.M)}
    if not failing and any("failed" in part for part, _ in totals + files):
        failing.add("vitest: failures the log does not name")
    skipped = sum(int(n) for part, _ in totals for n in re.findall(r"(\d+) (?:skipped|todo)", part))
    return {"executed": sum(int(n) for _, n in totals), "skipped": skipped, "failing": failing, "build_failed": False}


def parse_xcbuild(text):
    """xcodebuild build or build-for-testing, for a target with nothing the gate can run: it builds or it
    does not. `built` lets a check with no tests count as reached."""
    ok = "** BUILD SUCCEEDED **" in text or "** TEST BUILD SUCCEEDED **" in text
    bad = "** BUILD FAILED **" in text or "** TEST BUILD FAILED **" in text
    if not ok and not bad:
        return None
    return {"executed": 0, "skipped": 0, "failing": set(), "build_failed": bad, "built": not bad}


PARSERS = {"unittest": parse_unittest, "pytest": parse_pytest, "swift": parse_swift, "vitest": parse_vitest,
           "xcbuild": parse_xcbuild, "tsc": parse_tsc}
SILENT_WHEN_CLEAN = {"tsc"}
# "exit" is for a step with nothing to parse (a type check, a compile): exit 0 is "builds", anything else
# "does not build", unless a parser named the failure. It needs the job's exit status, so it is not in PARSERS.
SETUP_FAILED = 75  # EX_TEMPFAIL: the command could not set itself up (npm ci, a venv, a download). Unjudged.


def parse_kinds(recipe):
    """The parsers a check names: ["xcodebuild"] by default. xcodebuild keeps a check to itself (its log
    shares "Executed N tests" with swift test, and its unreached rules are its own)."""
    kinds = recipe.get("parse") or "xcodebuild"
    kinds = [kinds] if isinstance(kinds, str) else list(kinds)
    unknown = [k for k in kinds if k not in ("xcodebuild", "exit") and k not in PARSERS]
    if unknown or not kinds or ("xcodebuild" in kinds and len(kinds) > 1):
        raise Unjudged(f"recipe: parse wants \"xcodebuild\" or a list of {sorted([*PARSERS, 'exit'])}, got {kinds!r}")
    return kinds


def parse_log(text, kinds=("xcodebuild",), exit_code=None):
    """One result for a job log read by the parsers its check names.

    Failures are the union and tests the sum. The run is unreached, so unjudged, when no runner left a result,
    when a named runner is missing and nothing that ran explains why, when zero tests ran, or when the command
    failed and no runner said what failed: none of those says anything about the change."""
    if list(kinds) == ["xcodebuild"]:
        return parse_xcodebuild(text)
    text = ANSI.sub("", text)
    found = {k: PARSERS[k](text) for k in kinds if k != "exit"}
    present = [r for r in found.values() if r]
    failing = set().union(*(r["failing"] for r in present)) if present else set()
    build_failed = any(r["build_failed"] for r in present)
    built = any(r.get("built") for r in present)
    if "exit" in kinds and exit_code is not None:
        build_failed = build_failed or (exit_code != 0 and not failing)
        built = built or exit_code == 0
    executed = sum(r["executed"] for r in present)
    explained = bool(failing) or build_failed
    missing = [k for k in found if not found[k] and k not in SILENT_WHEN_CLEAN]
    unreached = None
    if exit_code == SETUP_FAILED:
        unreached = f"the command could not set itself up (exit {SETUP_FAILED})"
    elif "exit" in kinds and exit_code is None:
        unreached = "the job's exit status is unknown"
    elif not present and not built and not explained:
        unreached = "no test runner left a result in the log"
    elif missing and not explained:
        unreached = f"{', '.join(missing)} left no result in the log"
    elif not executed and not explained and not built:
        unreached = "zero tests ran"
    elif exit_code not in (None, 0) and not explained:
        unreached = f"the command exited {exit_code} and no runner reported a failure"
    return {"executed": executed if present or built else None, "skipped": sum(r["skipped"] for r in present),
            "failing": failing, "build_failed": build_failed, "unreached": unreached, "ids": {}}


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
    exit_code = int(row[3]) if len(row) > 3 and re.fullmatch(r"-?\d+", row[3]) else None
    res = parse_log(text, parse_kinds(recipe), exit_code)
    res["job"] = jid
    return res


def reached(res, what):
    """res, or Unjudged when it never got as far as the code: a retry may find the worker healthy, and a verdict
    would blame the change for the machine (or, when main failed alike, wave it through unbuilt)."""
    if res.get("unreached"):
        raise Unjudged(f"{what} never reached the build or the tests ({res['job']}): {res['unreached']}")
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


def baseline(repo, base, main_sha, recipe, deadline, cache_dir, pinned=None, slug=""):
    """Main's own failures at this sha (and at these linked shas), measured once per check."""
    key = main_sha[:12] + "".join(f"-{b}{sha[:12]}" for b, sha in sorted((pinned or {}).items()))
    path = os.path.join(cache_dir, f"baseline-{slug + '-' if slug else ''}{key}.json")
    try:
        with open(path) as f:
            d = json.load(f)
            return {**d, "failing": set(d["failing"])}
    except (OSError, ValueError, KeyError):
        pass
    git(repo, "checkout", "-q", "-f", "--detach", main_sha)
    git(repo, "clean", "-q", "-ffd")
    res = reached(run_job(repo, recipe, f"verify-{base}-main", deadline), "base main")
    with open(path, "w") as f:
        json.dump({**res, "failing": sorted(res["failing"])}, f)
    return res


def rerun(repo, recipe, base, cand, new, deadline):
    """The new failures that pass when run again on their own: flaky, not the change's doing.

    A test counts only if the rerun executed it; one the rerun could not name or select stays a failure.
    Only xcodebuild can be told which tests to run; any other check is run again whole, and a rerun that
    did not get as far as the first run proves nothing."""
    if parse_kinds(recipe) != ["xcodebuild"]:
        res = run_job(repo, recipe, f"verify-{base}-rerun", deadline)
        if res.get("unreached") or res["build_failed"] or (res["executed"] or 0) < (cand["executed"] or 0):
            return set()
        return set(new) - res["failing"]
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


SIMULATOR_ID = re.compile(r"[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}")


def repointed(repo, head, recipe, paths):
    """The proposal's recipe when all it changes is a simulator id, else main's.

    Main's recipe judges every proposal, so with its simulator gone nothing could land, the replacement
    included (each run is unjudged). Swapping an id cannot weaken the check, and running it proves the new id."""
    if ".foundry/verify.json" not in paths:
        return recipe
    try:
        proposed = json.loads(git(repo, "show", f"{head}:.foundry/verify.json"))
    except (Unjudged, ValueError):
        return recipe
    same = SIMULATOR_ID.sub("", json.dumps(proposed, sort_keys=True)) == SIMULATOR_ID.sub("", json.dumps(recipe, sort_keys=True))
    return proposed if same else recipe


def checks_of(recipe):
    """The recipe's checks, each a whole recipe of its own. One with no "checks" is its own single check;
    otherwise the top-level host, need, links and parse are each check's defaults."""
    if "checks" not in recipe:
        return [recipe]
    shared = {k: recipe[k] for k in ("host", "need", "links", "parse") if k in recipe}
    checks = recipe["checks"]
    if not isinstance(checks, list) or not checks or not all(
            isinstance(c, dict) and isinstance(c.get("name"), str) and c["name"] and isinstance(c.get("command"), list)
            for c in checks):
        raise Unjudged("recipe: checks wants a list, each with a name and a command")
    if len({slug_of(c["name"]) for c in checks}) != len(checks):
        raise Unjudged("recipe: checks want distinct names")
    return [{**shared, **c} for c in checks]


def slug_of(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:28] or "check"


def covers(check, path):
    when = check.get("when")
    return not when or any(fnmatch.fnmatch(path, g) for g in when)


def run_name(check, what):
    """The run's name as the gate's receipt keeps it (200 characters at most, and nothing else of the run)."""
    return f"{str(check.get('name', 'build+test'))[:150]} [{what}]"


def outcome(cand, base_res):
    if cand["build_failed"]:
        return "not built, nor is base main" if base_res is not None and base_res["build_failed"] else "does not build"
    if not cand["executed"]:
        return "builds, no tests"
    return f"{cand['executed']} tests" + (f", {cand['skipped']} skipped" if cand.get("skipped") else "")


def judge(cand, base_res, flaky=frozenset()):
    """(ok, summary). New failures are what the change adds over main, less the ones a rerun passed.
    Both results have reached the code: reached() turns a run that did not into Unjudged before this."""
    if cand["build_failed"]:
        if base_res is not None and base_res["build_failed"]:
            return True, "does not build, and neither does base main"
        return False, "does not build (" + cand["job"] + ")"
    new = sorted(cand["failing"] - (base_res["failing"] if base_res else set()) - set(flaky))
    tested = f"{cand['executed']} tests" + (f" ({cand['skipped']} skipped)" if cand.get("skipped") else "")
    if not cand["executed"] and not cand["failing"]:
        tested = "builds, no tests"
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
        recipe = repointed(repo, head, recipe, paths)
        skip = recipe.get("skip") or []
        checks = checks_of(recipe)
        code = [p for p in paths if not any(fnmatch.fnmatch(p, g) for g in skip)]
        if paths and not code:
            log("skip", base=base, repo=repo_name, head=head, paths=paths[:20])
            return {"runs": [{"name": run_name(recipe if recipe.get("name") else checks[0], "skipped: docs only"),
                              "ok": True,
                              "output": f"skipped: {len(paths)} path(s), all docs ({', '.join(paths[:3])})"}]}
        due = [c for c in checks if any(covers(c, p) for p in code)] if code else checks
        uncovered = [p for p in code if not any(covers(c, p) for c in checks)]
        if not due:
            log("uncovered", base=base, repo=repo_name, head=head, paths=uncovered[:20])
            return {"runs": []}
        copied, unmatched = ensure_assets(repo, "refs/verify/main", bcfg.get("sources", []))
        runs, on_main = [], False
        for check in due:
            slug = slug_of(check["name"]) if "checks" in recipe else ""
            tag = f"{base}-{slug}" if slug else base
            if on_main:  # the last check's baseline or rerun left another tree checked out
                build_tree(repo, "refs/verify/main", head)
                on_main = False
            check, pinned = resolve_links(repo, check, work)
            cand = reached(run_job(repo, check, f"verify-{tag}", deadline), "the candidate")
            base_res = None
            if cand["build_failed"] or cand["failing"]:
                base_res = baseline(repo, tag, main_sha, check, deadline, work, pinned, slug)
                on_main = True
            flaky = set()
            new = cand["failing"] - (base_res["failing"] if base_res else set())
            if new and not cand["build_failed"]:
                build_tree(repo, "refs/verify/main", head)  # the baseline may have left main checked out
                on_main = False
                flaky = rerun(repo, check, tag, cand, new, deadline)
            ok, summary = judge(cand, base_res, flaky)
            if unmatched:
                summary += f"; {len(unmatched)} asset(s) not as main declares"
            log("verdict", base=base, repo=repo_name, head=head, main=main_sha, links=pinned, ok=ok, summary=summary,
                secs=int(time.time() - started), assets_copied=copied, assets_unmatched=unmatched[:20],
                **({"check": check["name"], "uncovered": uncovered[:20]} if slug else {}))
            runs.append({"name": run_name(check, outcome(cand, base_res)), "ok": ok, "output": summary})
        return {"runs": runs}


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

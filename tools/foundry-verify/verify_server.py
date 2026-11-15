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
  5. Pass when no test fails that does not also fail on base main. Main's failures are kept per tree, and only
     looked at when the candidate has failures, so a red main never blocks the fix for it. A change that passes
     is kept as the result of the tree it made: once the gate merges it, that is main, and the next change is
     compared with it instead of a second run of main's tests. A check a change does not touch (docs, another
     part of a monorepo) keeps main's result on the new tree. Main is run only when no such result exists.
     Bases are verified side by side, one verification per base; simulator jobs take turns on each host.
     A check with placements on two hosts keeps main's result per host and measures main (and any rerun) on
     the host its candidate ran on: the hosts' Xcodes and runtimes differ, so results are never mixed.
     A real compile failure main shares passes for the same reason. A run that never got as far as the code
     (no such simulator, unresolved packages, a test runner that never started, zero tests) says nothing
     about the change, on either side, so it is unjudged and never cached.

A recipe is one check, or several under "checks": each has its own name, command and, optionally, `when`
globs (it runs only when a changed path matches one), and inherits host, placements, need, links and parse from the top.
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
an `error` row and a queue retry. A verifier that cannot be reached at all (tunnel down, gate timeout) is
the same `error` and retry on the gate's side (packages/verify HttpVerifier, since 2026-11-14); before that
it read as "not checked" and merged.
A busy worker is retried within the request deadline. Fabric refusals are never forced.

Mac1 only orchestrates: the build runs on a placement named in the recipe. One simulator run per host;
queued requests count against their own deadline. A submission that times out with no receipt holds its host
until reconcile_unknown has read the ledger and the host's tmux and settled whether a job started.
See docs/verify-per-host-design.md for the recipe form.

  verify_server.py serve [--port 8803]
  verify_server.py check REPO HEAD_SHA        run one verification from the command line, print the result
  verify_server.py probe BASE RECIPE --host H  run RECIPE's simulator checks on BASE main on host H (prove a placement)

Config ~/.config/foundry/verify.json:
  {"bases": {"motionmixapp": {"sources": ["~/Developer/MotionMixApp"]}}, "token_file": "~/.config/foundry/verify-token"}
The token is the first path segment of VERIFY_URL; every other path is a 404.
"""

import argparse
import calendar
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
_HOST_LOCKS, _HOST_LOCKS_GUARD = {}, threading.Lock()
_QUARANTINE, _QUARANTINE_GUARD = {}, threading.Lock()
# A job still running at its request's deadline is not stopped (2026-11-14: on a Mac5 loaded by renders a check
# and its main baseline took longer than one 780 s window, every retry stopped its job and started over, and no
# simulator landing could finish). It keeps running, keeps the simulator, and the gate's retry of the same check
# (same name, tree, recipe) takes its result instead of starting a new job. LATE_MORE_S bounds how long past the
# deadline it may run; an unclaimed result is dropped after LATE_KEEP_S.
LATE_MORE_S = 30 * 60
LATE_KEEP_S = 60 * 60
LATE = {}
LATE_LOCK = threading.Lock()
_BASE_LOCKS, _BASE_LOCKS_GUARD = {}, threading.Lock()


def base_lock(base):
    """One verification per base at a time (they share its tree); different bases do not wait on each other."""
    with _BASE_LOCKS_GUARD:
        return _BASE_LOCKS.setdefault(base, threading.Lock())


def host_lock(host):
    """Reserve the physical worker before fabric admission; late jobs retain this exact lock."""
    with _HOST_LOCKS_GUARD:
        return _HOST_LOCKS.setdefault(host, threading.Lock())


def quarantine(key, host, reason, lock):
    """An ambiguous launch/stop must not open a slot for another job. Returns the key it is held under.
    An unknown launch is reconciled by reconcile_unknown; any other quarantine lasts until a restart."""
    key = key or f"unknown:{host}"
    with _QUARANTINE_GUARD:
        _QUARANTINE[key] = {"host": host, "reason": str(reason), "lock": lock}
    log("host-quarantined", host=host, error=str(reason))
    return key


def quarantined():
    with _QUARANTINE_GUARD:
        return [{"host": q["host"], "reason": q["reason"]} for q in _QUARANTINE.values()]


def busy():
    with _BASE_LOCKS_GUARD:
        return sorted(b for b, l in _BASE_LOCKS.items() if l.locked())


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


DISK_FLOOR = re.compile(r": disk: \d+ GB < \d+ GB")   # fabric's refusal when the worker's disk is under its floor
# The worker's performing flag (`fabric stage up`): Mohamed is playing on it. Never forced: on 2026-11-14 three
# verifies forced onto Mac5 while he danced took load past 900 and silenced his deck three times.
PERFORMING = re.compile(r"file:\.fleet/performing")
PLACEMENT_RETRY_S = 20
SIM_HOSTS = ("mac5", "mac4")
UUID = re.compile(r"[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}")


class WorkerRefused(Unjudged):
    def __init__(self, detail, retryable=False):
        super().__init__(f"worker did not start the job: {detail}")
        self.retryable = retryable


class StartUnknown(Unjudged):
    """Fabric timed out without a launch receipt; it may already have started a remote job. `reconcilable`:
    the ledger and the host's tmux can tell whether it did (False when fabric named a host it was not asked for)."""
    def __init__(self, detail, reconcilable=True):
        super().__init__(detail)
        self.reconcilable = reconcilable


class JobStopped(Unjudged):
    def __init__(self, jid, state, host=None):
        super().__init__(f"{jid} {state}")
        self.jid, self.host = jid, host


def placements_of(recipe):
    """Validate and materialize the command for each host. Never mutate the fingerprint's logical recipe."""
    command = recipe.get("command")
    if not isinstance(command, list) or not command or not all(isinstance(s, str) for s in command):
        raise Unjudged("recipe: command wants a nonempty list of strings")
    sims = recipe.get("need", "sims") == "sims"
    if "placements" not in recipe:
        if any(t in s for s in command for t in ("{simulator}", "{derived_data}")):
            raise Unjudged("recipe: placement tokens need placements")
        host = recipe.get("host", "auto")
        hosts = SIM_HOSTS if sims and host == "auto" else (host,)
        if not isinstance(host, str) or (sims and any(h not in SIM_HOSTS for h in hosts)):
            raise Unjudged("recipe: simulator host wants mac4, mac5 or auto")
        return [{**recipe, "host": h} for h in hosts]
    placements = recipe["placements"]
    if not sims or not isinstance(placements, list) or not placements:
        raise Unjudged("recipe: placements wants a nonempty list for a simulator check")
    result, seen = [], set()
    uses_sim = any("{simulator}" in s for s in command)
    if not uses_sim and not any("generic/platform=iOS Simulator" in s for s in command):
        raise Unjudged("recipe: a placement without a simulator must be a generic iOS Simulator build")
    if not any("{derived_data}" in s for s in command):
        raise Unjudged("recipe: placements command must use {derived_data}")
    if sim_of(recipe):
        raise Unjudged("recipe: placements command must not pin a simulator id; use {simulator}")
    for p in placements:
        if not isinstance(p, dict) or set(p) != {"host", "simulator", "derived_data"}:
            raise Unjudged("recipe: each placement wants host, simulator and derived_data only")
        host, sim, dd = p["host"], p["simulator"], p["derived_data"]
        if not isinstance(host, str) or host not in SIM_HOSTS or host in seen:
            raise Unjudged("recipe: placements want distinct canonical hosts mac4/mac5")
        if (uses_sim and (not isinstance(sim, str) or not UUID.fullmatch(sim))) or (not uses_sim and sim is not None):
            raise Unjudged("recipe: simulator wants a UUID used by {simulator}, or null for a generic build")
        if (not isinstance(dd, str) or not re.fullmatch(r"/[A-Za-z0-9_./-]+", dd)
                or ".." in dd.split("/") or dd == "/"):
            raise Unjudged("recipe: derived_data wants an absolute shell-safe path without traversal")
        seen.add(host)
        concrete = [s.replace("{simulator}", sim or "").replace("{derived_data}", dd) for s in command]
        if uses_sim and sim_of({"command": concrete}) != sim:
            raise Unjudged("recipe: {simulator} must be used in the destination id")
        result.append({**recipe, "host": host, "command": concrete})
    return result


class PastDeadline(Unjudged):
    """_start_and_wait's job is still running at the deadline. run_job adopts it (or stops it)."""
    def __init__(self, jid, host=None):
        super().__init__(f"{jid} ran past the deadline")
        self.jid, self.host = jid, host


SSH = "ssh"
SIM_ID = re.compile(r"\bid=([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})")


def sim_of(recipe):
    """The simulator a recipe tests on, from its `-destination ... id=<UDID>`, or None (a generic destination)."""
    m = SIM_ID.search(" ".join(map(str, recipe.get("command") or [])))
    return m.group(1) if m else None


def stop_job(jid, sim=None, host=None):
    """Stop a job, and when it tested on a simulator, end the app it left running there. `fabric job stop` ends the
    job's processes, but the test host belongs to the simulator's own launchd and outlives xcodebuild: on 11-14 a
    MotionMixApp host left by a job stopped at 19:16 sat on C1AB6BF6 at 0% CPU, the next check on that simulator
    (serenity, 19:36) hung at its test stage for 30 min holding the simulator lock, and every simulator landing of every
    base came back unjudged until the host was killed by hand. Only app hosts under that one simulator's
    Containers/Bundle are ended; the simulator itself stays booted."""
    r = subprocess.run([FABRIC, "job", "stop", jid], capture_output=True, timeout=45)
    if r.returncode:
        raise Unjudged(f"{jid}: fabric stop failed; reconcile before reusing the host")
    if host is None:  # compatibility for callers without a captured placement
        row = job_row(jid)
        host = row[1] if row and len(row) > 1 else None
    if (not host or not re.fullmatch(r"[A-Za-z0-9._-]+", host)
            or (sim is not None and (host not in SIM_HOSTS or not UUID.fullmatch(sim)))
            or not re.fullmatch(r"job-[a-zA-Z0-9_-]+", jid)):
        raise Unjudged(f"{jid}: no valid host/simulator for cleanup")
    # The bracket keeps the remote shell's own command line from matching pkill/pgrep.
    try:
        # fabric stop currently ignores ssh failure: verify the tmux session is gone on the recorded host.
        command = (f"command -v tmux >/dev/null || exit 1; tmux has-session -t '{jid}' 2>/dev/null; "
                   "rc=$?; test \"$rc\" -eq 1 || exit 1; ")
        if sim:
            pattern = f"[C]oreSimulator/Devices/{sim}/data/Containers/Bundle/Application/"
            command += (f"pkill -f '{pattern}'; rc=$?; test \"$rc\" -le 1 || exit 1; "
                        f"for attempt in 1 2 3 4 5; do pgrep -f '{pattern}' >/dev/null; rc=$?; "
                        "test \"$rc\" -eq 1 && exit 0; test \"$rc\" -eq 0 || exit 1; sleep 1; done; exit 1")
        else:
            command += "exit 0"
        r = subprocess.run([SSH, "-o", "ConnectTimeout=10", "-o", "BatchMode=yes", "-o", "ControlMaster=no",
                            host, command], capture_output=True, timeout=45)
        if r.returncode:
            raise Unjudged(f"{jid}: stop/simulator cleanup not confirmed on {host}")
        log("sim-cleared", job=jid, host=host, sim=sim)
    except subprocess.TimeoutExpired:
        raise Unjudged(f"{jid}: simulator cleanup timed out on {host}") from None


class Late:
    """A job adopted past its request's deadline: its row once it ends, or why it never gave one."""
    def __init__(self, jid, lock, host, sim=None):
        self.jid, self.lock, self.host, self.sim, self.t = jid, lock, host, sim, time.time()
        self.done, self.row, self.error, self.ended = threading.Event(), None, None, None


def job_fingerprint(repo, recipe, name, host=None):
    """What makes a retry the same check: the job's name, the tree it would sync (the index build_tree or the
    baseline checkout left) and the recipe, plus the host when the run is pinned to one (a baseline or rerun
    measured for a candidate's host must not collect a job that ran on the other). None when the tree cannot be
    read: such a job is stopped as before."""
    r = subprocess.run(["git", "-C", repo, "write-tree"], capture_output=True, text=True)
    if r.returncode:
        return None
    parts = [name, r.stdout.strip(), recipe] + ([host] if host else [])
    return hashlib.sha256(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()


JOB_LS_LAST = 500  # `fabric job ls` prints only the newest 20 by default


def job_row(jid):
    """The job's `fabric job ls` row, or None. Read from the newest JOB_LS_LAST: on 11-14 the default 20 lost an
    adopted job within 10 min while other lanes started theirs, so its end was never seen and its result never taken."""
    r = subprocess.run([FABRIC, "job", "ls", "--last", str(JOB_LS_LAST)],
                       capture_output=True, text=True, timeout=45)
    if r.returncode:
        raise Unjudged(f"{jid}: fabric job ls failed")
    return next((l.split() for l in r.stdout.splitlines() if l.split()[:1] == [jid] and len(l.split()) >= 3), None)


def watch_late(key, late):
    """Wait out an adopted job, then free the simulator. Stops it LATE_MORE_S after adoption."""
    release = True
    try:
        while True:
            if time.time() - late.t > LATE_MORE_S:
                stop_job(late.jid, late.sim, late.host)
                late.error = f"{late.jid} still running {LATE_MORE_S // 60} min past its deadline; stopped"
                break
            time.sleep(10)
            row = job_row(late.jid)
            if row and row[1] != late.host:
                raise Unjudged(f"{late.jid}: ledger host differs from {late.host}")
            if row and row[2] in ("done", "failed"):
                late.row = row
                break
            if row and row[2] in ("lost", "stopped"):
                stop_job(late.jid, late.sim, late.host)
                late.error = f"{late.jid} {row[2]}"
                break
    except Exception as e:  # an unknown job/cleanup state cannot free a reservation
        late.error = f"{late.jid}: watching it failed: {e}"
        quarantine(key, late.host, late.error, late.lock)
        release = False
    finally:
        late.ended = time.time()
        if late.lock and release:
            late.lock.release()
        late.done.set()
        log("late-ended", job=late.jid, ok=late.error is None, error=late.error)


def adopt(key, jid, lock, host, sim=None):
    """Keep a job running past its request's deadline for a retry to collect. False when it has no key."""
    if key is None:
        return False
    late = Late(jid, lock, host, sim)
    with LATE_LOCK:
        now = time.time()
        for k in [k for k, v in LATE.items() if v.ended and now - v.ended > LATE_KEEP_S]:
            del LATE[k]
        LATE[key] = late
    try:
        threading.Thread(target=watch_late, args=(key, late), daemon=True, name=f"late-{jid}").start()
    except RuntimeError as e:
        late.error, late.ended = f"{jid}: watcher could not start: {e}", time.time()
        quarantine(key, host, late.error, lock)
        late.done.set()
    log("late-adopted", job=jid, host=host, sim=sim)
    return True


def claim_late(key, deadline):
    """An earlier attempt's job for this same check: (job id, row) once it ended, None when there is none.
    Still running at this request's deadline is Unjudged again, and the job keeps going for the next retry."""
    if key is None:
        return None
    with LATE_LOCK:
        late = LATE.get(key)
    if late is None:
        return None
    if not late.done.wait(timeout=max(0.0, deadline - 30 - time.time())):
        raise Unjudged(f"{late.jid} from an earlier attempt is still running; a later retry takes its result")
    with LATE_LOCK:
        if LATE.get(key) is late:
            del LATE[key]
    if late.error:
        raise Unjudged(late.error)
    log("late-claimed", job=late.jid)
    return late.jid, late.row


# ---- an unknown launch, reconciled ----
# `fabric job run` timed out with no receipt (a slow first sync of a big tree to a host, a hung ssh). Killing it
# leaves three possible states on the host: nothing started, a job in the ledger, or a tmux session fabric opened
# but never recorded. The reconciler reads both and settles which, so one slow submission does not hold the host
# (and that check) until the verifier restarts. Anything it cannot read keeps the quarantine.
RECONCILE_SETTLE_S = 30
RECONCILE_EVERY_S = 60
RECONCILE_MAX_S = LATE_MORE_S
STARTED_AT = re.compile(r"\b(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)\b")


def fabric_job_name(name):
    """The name part of the job id `fabric job run --name` makes: job-<this>-MMDD-HHMMSS."""
    return re.sub(r"[^a-z0-9-]", "-", name.lower())[:30]


def reconcile_once(key, host, name, lock, sim, t0):
    """Settle one unknown launch. Returns "adopted", "released" or None (could not tell: still quarantined)."""
    pattern = re.compile(rf"job-{re.escape(fabric_job_name(name))}-\d{{4}}-\d{{6}}")
    r = subprocess.run([FABRIC, "job", "ls", "--last", str(JOB_LS_LAST)], capture_output=True, text=True, timeout=45)
    if r.returncode:
        return None
    for line in r.stdout.splitlines():
        row, at = line.split(), STARTED_AT.search(line)
        if len(row) < 3 or not pattern.fullmatch(row[0]) or row[1] != host or not at:
            continue
        if calendar.timegm(time.strptime(at.group(1), "%Y-%m-%dT%H:%M:%SZ")) < t0 - 5:
            continue  # an earlier job of the same name
        late = Late(row[0], lock, host, sim)
        with LATE_LOCK:
            LATE[key] = late
        with _QUARANTINE_GUARD:
            _QUARANTINE.pop(key, None)
        threading.Thread(target=watch_late, args=(key, late), daemon=True, name=f"late-{row[0]}").start()
        log("reconciled", host=host, job=row[0], outcome="adopted")
        return "adopted"
    ledger = {l.split()[0] for l in r.stdout.splitlines() if l.split()}
    try:
        r = subprocess.run([SSH, "-o", "ConnectTimeout=10", "-o", "BatchMode=yes", "-o", "ControlMaster=no", host,
                            "tmux ls -F '#{session_name}' 2>/dev/null; true"], capture_output=True, text=True, timeout=45)
    except subprocess.TimeoutExpired:
        return None
    if r.returncode:
        return None
    for jid in [s for s in r.stdout.split() if pattern.fullmatch(s) and s not in ledger]:
        # fabric opened the session but died before it wrote the ledger row: no one else will ever stop it.
        command = f"tmux kill-session -t '{jid}' 2>/dev/null; tmux has-session -t '{jid}' 2>/dev/null && exit 1; "
        if sim:
            pattern_app = f"[C]oreSimulator/Devices/{sim}/data/Containers/Bundle/Application/"
            command += f"pkill -f '{pattern_app}'; sleep 2; pgrep -f '{pattern_app}' >/dev/null && exit 1; "
        try:
            k = subprocess.run([SSH, "-o", "ConnectTimeout=10", "-o", "BatchMode=yes", "-o", "ControlMaster=no",
                                host, command + "exit 0"], capture_output=True, timeout=45)
        except subprocess.TimeoutExpired:
            return None
        if k.returncode:
            return None
        log("reconciled-orphan", host=host, job=jid)
    with _QUARANTINE_GUARD:
        _QUARANTINE.pop(key, None)
    if lock:
        lock.release()
    log("reconciled", host=host, outcome="released")
    return "released"


def reconcile_unknown(key, host, name, lock, sim, t0):
    time.sleep(RECONCILE_SETTLE_S)  # a fabric process killed mid-ssh may still land its tmux session
    start = time.time()
    while True:
        try:
            if reconcile_once(key, host, name, lock, sim, t0):
                return
        except Exception as e:  # an unreadable state keeps the quarantine; try again
            log("reconcile-error", host=host, error=repr(e)[:200])
        if time.time() - start > RECONCILE_MAX_S:
            log("reconcile-gave-up", host=host, key=key)
            return
        time.sleep(RECONCILE_EVERY_S)


def start_reconcile(key, host, name, lock, sim, t0):
    try:
        threading.Thread(target=reconcile_unknown, args=(key, host, name, lock, sim, t0), daemon=True,
                         name=f"reconcile-{host}").start()
    except RuntimeError as e:
        log("reconcile-error", host=host, error=repr(e)[:200])


def run_job(repo, recipe, name, deadline, host=None):
    """Run on an available recipe placement, one simulator job per host. Never force a fabric refusal.

    Busy, performing, memory and load refusals allow another placement or a bounded retry. A disk-floor
    refusal makes that placement unjudged immediately: waiting frees no disk. Time spent queued and
    submitting counts against the original deadline. Unknown launch outcomes retain their reservation.
    `host` pins the run to that one placement: main's baseline and a rerun are measured where the candidate ran.
    """
    placements = placements_of(recipe)
    if host:
        placements = [p for p in placements if p["host"] == host]
        if not placements:
            raise Unjudged(f"recipe: no placement on {host}, where the candidate ran")
    sims = recipe.get("need", "sims") == "sims"
    key = job_fingerprint(repo, recipe, name, host)
    with _QUARANTINE_GUARD:
        if key in _QUARANTINE:
            raise Unjudged("job requires reconciliation: " + _QUARANTINE[key]["reason"])
    claimed = claim_late(key, deadline)
    if claimed:
        jid, row = claimed
    else:
        jid, row = run_placements(repo, placements, name, deadline, key, sims)
    try:
        r = subprocess.run([FABRIC, "job", "log", jid, "--lines", "200000"],
                           capture_output=True, text=True, timeout=45)
    except subprocess.TimeoutExpired:
        raise Unjudged(f"{jid}: reading the job log timed out") from None
    if r.returncode:
        raise Unjudged(f"{jid}: reading the job log failed")
    exit_code = int(row[3]) if len(row) > 3 and re.fullmatch(r"-?\d+", row[3]) else None
    res = parse_log(r.stdout, parse_kinds(recipe), exit_code)
    res["job"], res["host"] = jid, row[1]
    return res


def run_placements(repo, placements, name, deadline, key, sims):
    """Reserve, submit, and hand off ownership on adoption. A refusal reserves no host while waiting."""
    excluded, reasons = set(), {}
    while True:
        for placement in placements:
            host = placement["host"]
            if host in excluded:
                continue
            if time.time() >= deadline - 60:
                raise Unjudged("placement deadline: " + "; ".join(reasons.values()))
            sim = sim_of(placement)
            cmd = [FABRIC, "job", "run", "--host", host, "--need", placement.get("need", "sims"),
                   "--name", name, "--by", "foundry-verify", "--sync", repo]
            for rel, src in (placement.get("links") or {}).items():
                cmd += ["--link", f"{rel}={os.path.expanduser(src)}"]
            lock = host_lock(host) if sims else None
            if lock and not lock.acquire(blocking=False):
                reasons[host] = f"{host}: another simulator job or quarantine holds the host"
                continue
            release, t0 = True, time.time()
            try:
                return _start_and_wait(cmd, ["--", *placement["command"]], name, deadline)
            except WorkerRefused as e:
                reasons[host] = f"{host}: {e}"
                if not e.retryable:
                    excluded.add(host)
                log("placement-refused", name=name, host=host, detail=str(e))
            except StartUnknown as e:
                release = False
                held = quarantine(key, host, e, lock)
                if e.reconcilable:
                    start_reconcile(held, host, name, lock, sim, t0)
                raise
            except (PastDeadline, JobStopped) as e:
                actual_host = e.host or host
                if isinstance(e, PastDeadline) and adopt(key, e.jid, lock, actual_host, sim):
                    release = False  # the watcher, not this request, now owns the lock
                    raise Unjudged(f"{e.jid} ran past the deadline or lost observation; it keeps running and "
                                   "the retry of this check takes its result") from None
                try:
                    stop_job(e.jid, sim, actual_host)
                except Exception as stop_error:
                    release = False
                    quarantine(key, host, stop_error, lock)
                    raise Unjudged(f"{e.jid}: stop not confirmed; host quarantined") from stop_error
                raise Unjudged(f"{e}; stopped") from None
            finally:
                if lock and release:
                    lock.release()
        if len(excluded) == len(placements):
            raise Unjudged("no placement started: " + "; ".join(reasons.values()))
        left = deadline - 60 - time.time()
        if left <= 0:
            raise Unjudged("placement deadline: " + "; ".join(reasons.values()))
        time.sleep(min(PLACEMENT_RETRY_S, left))


def _start_and_wait(cmd, tail, name, deadline):
    """One unforced submission. A definite refusal allows failover; an ambiguous start never does."""
    host = cmd[cmd.index("--host") + 1]
    try:
        r = subprocess.run(cmd + tail, capture_output=True, text=True, timeout=max(1, deadline - time.time()))
    except subprocess.TimeoutExpired as e:
        out = e.stdout or ""
        if isinstance(out, bytes):
            out = out.decode(errors="replace")
        m = re.search(r"started (job-\S+) on (\S+)", out)
        if m and m.group(2) == host:
            raise PastDeadline(m.group(1), host) from None
        raise StartUnknown(f"fabric job run timed out on {host} without a start receipt; reconcile remote jobs") from None
    m = re.search(r"started (job-\S+) on (\S+)", r.stdout)
    if not m:
        said = r.stderr + r.stdout
        retryable = bool(PERFORMING.search(said) or re.search(r"load:|memory:|busy:|no host has room", said))
        raise WorkerRefused(said.strip()[-200:], retryable and not DISK_FLOOR.search(said))
    if host != "auto" and m.group(2) != host:
        raise StartUnknown(f"fabric reported {m.group(1)} on {m.group(2)}, expected {host}; reconcile remote jobs",
                           reconcilable=False)
    jid = m.group(1)
    while True:
        if time.time() > deadline:
            raise PastDeadline(jid, m.group(2))       # run_job keeps it for the retry, or stops it
        time.sleep(10)
        try:
            row = job_row(jid)
            if row and row[1] != m.group(2):
                raise Unjudged(f"{jid}: ledger host differs from start receipt")
        except (subprocess.TimeoutExpired, OSError, Unjudged):
            raise PastDeadline(jid, m.group(2)) from None  # retain ownership through an observation outage
        if row and row[2] in ("done", "failed"):
            return jid, row
        if row and row[2] in ("lost", "stopped"):
            raise JobStopped(jid, row[2], m.group(2))


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


def result_path(cache_dir, tree, pinned=None, slug="", host=None):
    """Where one check's result for one tree (and these linked shas) is kept. The key is the tree, not the
    commit: the merge the gate makes of a change this server passed has exactly the tree that was tested.
    A check that may run on more than one host keeps one result per host (`host`): Mac4 and Mac5 carry different
    Xcodes and simulator runtimes, so a test may fail on one alone, and comparing a candidate with main's result
    from the other host would blame the change for the machine, or wave a real failure through."""
    key = "t" + tree[:16] + "".join(f"-{b}{sha[:12]}" for b, sha in sorted((pinned or {}).items()))
    key += f"-@{host}" if host else ""
    return os.path.join(cache_dir, f"baseline-{slug + '-' if slug else ''}{key}.json")


def remember(cache_dir, tree, res, pinned=None, slug="", flaky=frozenset(), host=None):
    """Keep a passed candidate's result as the result of the tree it ran on. When the gate merges it, base main
    is that tree, and the next change is compared with this instead of a second run of main's tests. A test
    that failed and then passed on the rerun is not kept as failing: the next change gets its own rerun."""
    tmp = result_path(cache_dir, tree, pinned, slug, host) + ".part"
    with open(tmp, "w") as f:
        json.dump({**res, "failing": sorted(set(res["failing"]) - set(flaky)), "from": "candidate"}, f)
    os.replace(tmp, tmp[:-5])


RESULT_FILE = re.compile(r"baseline-(?:(.*?)-)?t([0-9a-f]{16})(.*)\.json")
KEEP_RESULTS_S = 14 * 86400


def carry(cache_dir, main_tree, tree, tested=()):
    """A check this change does not touch has the same result on the new tree as on main's: copy it across,
    so a docs landing (or one that only touches another part of a monorepo) does not make the next change
    measure main again. `tested` are the slugs this verification runs itself. Old results are dropped here."""
    if not os.path.isdir(cache_dir):
        return
    now = time.time()
    for n in os.listdir(cache_dir):
        m = RESULT_FILE.fullmatch(n)
        path = os.path.join(cache_dir, n)
        if not m:
            continue
        if now - os.path.getmtime(path) > KEEP_RESULTS_S:
            os.remove(path)
        elif m.group(2) == main_tree[:16] and tree[:16] != main_tree[:16] and (m.group(1) or "") not in tested:
            new = os.path.join(cache_dir, n.replace("t" + main_tree[:16], "t" + tree[:16], 1))
            shutil.copyfile(path, new + ".part")
            os.replace(new + ".part", new)


def baseline(repo, base, main_sha, recipe, deadline, cache_dir, pinned=None, slug="", host=None):
    """Main's own failures for this tree (and these linked shas), measured once per check, or taken from the
    passed candidate whose merge made this tree. With `host`, measured on that host and kept for it alone."""
    path = result_path(cache_dir, git(repo, "rev-parse", main_sha + "^{tree}").strip(), pinned, slug, host)
    try:
        with open(path) as f:
            d = json.load(f)
            return {**d, "failing": set(d["failing"])}
    except (OSError, ValueError, KeyError):
        pass
    git(repo, "checkout", "-q", "-f", "--detach", main_sha)
    git(repo, "clean", "-q", "-ffd")
    res = reached(run_job(repo, recipe, f"verify-{base}-main", deadline, host=host), "base main")
    tmp = path + ".part"
    with open(tmp, "w") as f:
        json.dump({**res, "failing": sorted(res["failing"])}, f)
    os.replace(tmp, path)
    return res


def rerun(repo, recipe, base, cand, new, deadline, host=None):
    """The new failures that pass when run again on their own: flaky, not the change's doing.

    A test counts only if the rerun executed it; one the rerun could not name or select stays a failure.
    Only xcodebuild can be told which tests to run; any other check is run again whole, and a rerun that
    did not get as far as the first run proves nothing."""
    if parse_kinds(recipe) != ["xcodebuild"]:
        res = run_job(repo, recipe, f"verify-{base}-rerun", deadline, host=host)
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
    res = run_job(repo, {**recipe, "command": cmd}, f"verify-{base}-rerun", deadline, host=host)
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
    shared = {k: recipe[k] for k in ("host", "placements", "need", "links", "parse") if k in recipe}
    checks = recipe["checks"]
    if not isinstance(checks, list) or not checks or not all(
            isinstance(c, dict) and isinstance(c.get("name"), str) and c["name"] and isinstance(c.get("command"), list)
            for c in checks):
        raise Unjudged("recipe: checks wants a list, each with a name and a command")
    if len({slug_of(c["name"]) for c in checks}) != len(checks):
        raise Unjudged("recipe: checks want distinct names")
    return [{**{k: v for k, v in shared.items() if k != "placements" or "host" not in c}, **c} for c in checks]


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
    with base_lock(base):
        if time.time() > deadline:
            raise Unjudged("waited past the deadline for an earlier verification of this base")
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
        tree = git(repo, "write-tree").strip()   # the index is main plus the change: what a merge would make
        main_tree = git(repo, "rev-parse", "refs/verify/main^{tree}").strip()
        recipe = repointed(repo, head, recipe, paths)
        skip = recipe.get("skip") or []
        checks = checks_of(recipe)
        code = [p for p in paths if not any(fnmatch.fnmatch(p, g) for g in skip)]
        if paths and not code:
            carry(work, main_tree, tree)
            log("skip", base=base, repo=repo_name, head=head, paths=paths[:20])
            return {"runs": [{"name": run_name(recipe if recipe.get("name") else checks[0], "skipped: docs only"),
                              "ok": True,
                              "output": f"skipped: {len(paths)} path(s), all docs ({', '.join(paths[:3])})"}]}
        due = [c for c in checks if any(covers(c, p) for p in code)] if code else checks
        uncovered = [p for p in code if not any(covers(c, p) for c in checks)]
        if not due:
            carry(work, main_tree, tree)
            log("uncovered", base=base, repo=repo_name, head=head, paths=uncovered[:20])
            return {"runs": []}
        carry(work, main_tree, tree, {slug_of(c["name"]) if "checks" in recipe else "" for c in due})
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
            # A check with more than one placement is compared per host: main's result where the candidate ran.
            per_host = cand.get("host") if len(placements_of(check)) > 1 else None
            base_res = None
            if cand["build_failed"] or cand["failing"]:
                base_res = baseline(repo, tag, main_sha, check, deadline, work, pinned, slug, per_host)
                on_main = True
            flaky = set()
            new = cand["failing"] - (base_res["failing"] if base_res else set())
            if new and not cand["build_failed"]:
                build_tree(repo, "refs/verify/main", head)  # the baseline may have left main checked out
                on_main = False
                flaky = rerun(repo, check, tag, cand, new, deadline, per_host)
            ok, summary = judge(cand, base_res, flaky)
            if ok and not cand.get("unreached"):
                remember(work, tree, cand, pinned, slug, flaky, per_host)
            if unmatched:
                summary += f"; {len(unmatched)} asset(s) not as main declares"
            log("verdict", base=base, repo=repo_name, head=head, main=main_sha, links=pinned, ok=ok, summary=summary,
                host=cand.get("host"),
                secs=int(time.time() - started), assets_copied=copied, assets_unmatched=unmatched[:20],
                **({"check": check["name"], "uncovered": uncovered[:20]} if slug else {}))
            runs.append({"name": run_name(check, outcome(cand, base_res)), "ok": ok, "output": summary})
        return {"runs": runs}


def probe(base, recipe, host, only=None, cfg=None, deadline_s=DEFAULT_DEADLINE_S * 3):
    """Run a recipe's simulator checks on base main, pinned to one host, and return what each found. For proving a
    new placement before its recipe lands: nothing is cached, no verdict is made, and the tree is the probe's own
    (ROOT/probe-<base>), never the one the live server is verifying in. A check that runs nowhere near `host`
    (no placement there) is reported, not run."""
    cfg = cfg or load_config()
    if base not in cfg.get("bases", {}):
        raise Unjudged(f"{base}: not a base in {CONFIG}")
    work = os.path.join(ROOT, f"probe-{base}")
    repo = os.path.join(work, "tree")
    if not os.path.exists(os.path.join(repo, ".git")):
        os.makedirs(work, exist_ok=True)
        subprocess.run(["git", "init", "-q", "--separate-git-dir", os.path.join(work, "git"), repo], check=True,
                       capture_output=True)
    r = subprocess.run([FETCH, base, "-q", "+refs/heads/main:refs/verify/main"], cwd=repo, capture_output=True, text=True)
    if r.returncode:
        raise Unjudged(f"fetch {base}: {(r.stderr or r.stdout).strip()[-160:]}")
    main_sha = git(repo, "rev-parse", "refs/verify/main").strip()
    git(repo, "checkout", "-q", "-f", "--detach", main_sha)
    git(repo, "clean", "-q", "-ffd")
    copied, unmatched = ensure_assets(repo, "refs/verify/main", cfg["bases"][base].get("sources", []))
    out = []
    for check in checks_of(recipe):
        name = check.get("name", "build+test")
        if (only and name != only) or check.get("need", "sims") != "sims":
            continue
        if host not in [p["host"] for p in placements_of(check)]:
            out.append({"check": name, "host": host, "skipped": "no placement on this host"})
            continue
        check, pinned = resolve_links(repo, check, work)
        slug = slug_of(name) if "checks" in recipe else ""
        res = run_job(repo, check, f"probe-{base}-{slug}".rstrip("-"), time.time() + deadline_s, host=host)
        out.append({"check": name, "host": res.get("host"), "job": res["job"], "main": main_sha, "links": pinned,
                    "executed": res["executed"], "skipped": res.get("skipped"), "failing": sorted(res["failing"]),
                    "build_failed": res["build_failed"], "unreached": res.get("unreached"),
                    "assets": {"copied": copied, "unmatched": unmatched[:20]}})
    return out


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
                return self._send(200, {"ok": True, "busy": bool(busy()), "verifying": busy(),
                                        "quarantined": quarantined()})
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
    pr = sub.add_parser("probe")
    pr.add_argument("base")
    pr.add_argument("recipe", help="a .foundry/verify.json to run (the proposed recipe, before it lands)")
    pr.add_argument("--host", required=True, choices=SIM_HOSTS)
    pr.add_argument("--check", help="only the check with this name")
    a = ap.parse_args()
    if a.cmd == "probe":
        with open(a.recipe) as f:
            recipe = json.load(f)
        try:
            print(json.dumps(probe(a.base, recipe, a.host, a.check), indent=1))
        except Unjudged as e:
            sys.exit(f"not run: {e}")
        return
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

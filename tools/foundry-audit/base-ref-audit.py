#!/usr/bin/env python3
"""Base-ref audit (security review 2026-10-22, H3 detective control).

foundry-push can mint a write token for a base repo, so a plain `git push` could land on base with no gate
decision. Until base write tokens are gate-only, this job proves after the fact that every commit on each base
repo's main came from the gate: each first-parent commit must be a decision row's merged_sha, or pre-gate
history (an ancestor of the first gated merge, or the seed of a repo with no merges yet).

  base-ref-audit.py [repo ...]        (default: every base repo that has a gate decision, plus --repos-file)
Exit 0 = clean, 1 = unexplained commits (also posted to fleet-watch as a push-level event), 2 = audit error.
Read-only: fetches into a private cache repo, never pushes.
"""
import json
import os
import subprocess
import sys

SOURCE = os.path.expanduser("~/Developer/foundry-integration/source")
CACHE = os.path.expanduser("~/.cache/foundry-base-audit")
FETCH = os.path.expanduser("~/.config/foundry/bin/foundry-fetch")
FLEET_WATCH = os.path.expanduser("~/.claude/fleet-watch/fleet_watch.py")
EXTRA_REPOS = ["airdeck", "nko-speech"]
# The app-fleet registry (security/app-fleet lane) records each seeded base as foundry_base.
APP_REGISTRY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "docs", "app-fleet", "apps.v1.json")


def registry_bases():
    try:
        d = json.load(open(APP_REGISTRY))
    except Exception:
        return []
    rows = d.get("apps", d) if isinstance(d, dict) else d
    return sorted({r["foundry_base"] for r in rows if isinstance(r, dict) and r.get("foundry_base")})


def d1(sql):
    r = subprocess.run(["npx", "wrangler", "d1", "execute", "foundry-decisions-staging", "--remote", "--json", "--command", sql],
                       cwd=SOURCE, capture_output=True, text=True, timeout=120)
    raw = r.stdout
    i = raw.find("[")
    if r.returncode != 0 or i < 0:
        raise RuntimeError("d1 query failed: " + (r.stderr or raw)[-300:])
    return [row for blk in json.loads(raw[i:]) for row in blk.get("results", [])]


def git(*a, check=True):
    r = subprocess.run(["git", "-C", CACHE, *a], capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError("git %s: %s" % (" ".join(a), r.stderr[-300:]))
    return r.stdout.strip()


def main():
    os.makedirs(CACHE, exist_ok=True)
    if not os.path.exists(os.path.join(CACHE, ".git")):
        # non-bare: foundry-fetch resolves the work tree with `git rev-parse --show-toplevel`
        subprocess.run(["git", "init", "-q", CACHE], check=True)
    # merges per base: the fork name is "<task>--<agent>", the base is the ticket's baseRepo; decisions carry
    # merged_sha and the task id, and tickets map task -> base. Read both.
    merges = d1("select d.merged_sha as sha, t.base_repo as base from decisions d join tickets t on t.fork_repo = d.repo "
                "where d.verdict = 'merge' and d.merged_sha is not null")
    by_base = {}
    for m in merges:
        by_base.setdefault(m["base"], set()).add(m["sha"])
    repos = sys.argv[1:] or sorted(set(by_base) | set(EXTRA_REPOS) | set(registry_bases()))
    findings, report = [], []
    for repo in repos:
        ref = "refs/audit/%s/main" % repo
        r = subprocess.run([FETCH, repo, "+main:" + ref], cwd=CACHE, capture_output=True, text=True, timeout=300)
        if r.returncode != 0:
            g = subprocess.run(["npx", "wrangler", "artifacts", "repos", "get", repo, "--namespace", "foundry-staging"],
                               cwd=SOURCE, capture_output=True, text=True, timeout=120)
            if "name:" not in g.stdout:
                report.append("%s: repo no longer exists (deleted test base), skipped" % repo)
            else:
                findings.append("%s: fetch failed (%s)" % (repo, (r.stderr or "").strip()[-160:]))
            continue
        chain = git("rev-list", "--first-parent", ref).split()
        gated = by_base.get(repo, set())
        if gated:
            first = [c for c in reversed(chain) if c in gated][0] if any(c in gated for c in chain) else None
            parents = git("rev-list", "--parents", "-n", "1", first).split()[1:] if first else []
            pre = set(git("rev-list", parents[0]).split()) if parents else set()  # a root gated commit has no pre-gate history
        else:
            pre = set(chain[-1:])  # a repo with no merges yet may only hold its seed commit
        bad = [c for c in chain if c not in gated and c not in pre]
        report.append("%s: %d commits on main, %d gated, %d pre-gate, %d UNEXPLAINED" % (repo, len(chain), len(set(chain) & gated), len(set(chain) & pre), len(bad)))
        for c in bad:
            findings.append("%s: commit %s on main has no gate decision (%s)" % (repo, c[:12], git("log", "-1", "--format=%an %ad %s", "--date=iso", c)))
    print("\n".join(report))
    if findings:
        print("\n".join("FINDING " + f for f in findings))
        try:
            subprocess.run(["/opt/homebrew/bin/python3", FLEET_WATCH, "say",
                            "BASE-REF AUDIT: %d unexplained finding(s): %s" % (len(findings), findings[0][:200]), "--lane", "base-ref-audit"],
                           timeout=60)
        except Exception:
            pass
        return 1
    print("CLEAN: every commit on every audited base main is a gated merge or pre-gate history")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print("AUDIT ERROR:", e)
        sys.exit(2)

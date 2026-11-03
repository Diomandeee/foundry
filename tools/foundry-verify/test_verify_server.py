#!/usr/bin/env python3
"""Tests for verify_server.py on throwaway repos. No network, no worker: fetch and the job runner are stubbed."""

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import verify_server as vs  # noqa: E402


def sh(cwd, *args):
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def commit(repo, files, msg, delete=()):
    for path, body in files.items():
        full = os.path.join(repo, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w") as f:
            f.write(body)
    for path in delete:
        os.remove(os.path.join(repo, path))
    sh(repo, "git", "add", "-A")
    sh(repo, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg)
    return sh(repo, "git", "rev-parse", "HEAD")


XCODE_PASS = "Test Suite 'All tests' passed\n\t Executed 12 tests, with 0 failures (0 unexpected) in 1.0 (1.0) seconds\n** TEST SUCCEEDED **\n"
XCODE_FAIL = ("\t Executed 12 tests, with 2 failures (0 unexpected) in 1.0 (1.0) seconds\nFailing tests:\n"
              "\tATests.testOne()\n\tBTests.testTwo()\n\n** TEST FAILED **\n")
XCODE_FAIL_CASES = ("Test Case '-[AppTests.ATests testOne]' failed (0.1 seconds).\n"
                    "Test Case '-[AppTests.CTests testPassed]' passed (0.1 seconds).\n" + XCODE_FAIL)
XCODE_BUILD_FAIL = "error: cannot find 'x' in scope\n** BUILD FAILED **\n\nThe following build commands failed:\n"


class Parse(unittest.TestCase):
    def test_pass(self):
        r = vs.parse_xcodebuild(XCODE_PASS)
        self.assertEqual((r["executed"], r["failing"], r["build_failed"]), (12, set(), False))

    def test_failing_tests(self):
        r = vs.parse_xcodebuild(XCODE_FAIL)
        self.assertEqual(r["failing"], {"ATests.testOne()", "BTests.testTwo()"})
        self.assertFalse(r["build_failed"])

    def test_failing_test_ids_for_a_rerun(self):
        self.assertEqual(vs.parse_xcodebuild(XCODE_FAIL_CASES)["ids"], {"ATests.testOne()": "AppTests/ATests/testOne"})

    def test_build_failure(self):
        self.assertTrue(vs.parse_xcodebuild(XCODE_BUILD_FAIL)["build_failed"])

    def test_truncated_log_is_a_build_failure(self):
        self.assertTrue(vs.parse_xcodebuild("Compiling...\n")["build_failed"])


class Judge(unittest.TestCase):
    def res(self, failing=(), build_failed=False):
        return {"executed": 10, "failing": set(failing), "build_failed": build_failed, "job": "job-x"}

    def test_green(self):
        self.assertTrue(vs.judge(self.res(), None)[0])

    def test_failures_main_also_has_pass(self):
        ok, why = vs.judge(self.res(["A.t()"]), self.res(["A.t()", "B.t()"]))
        self.assertTrue(ok)
        self.assertIn("failing as on main", why)

    def test_new_failure_refuses_and_names_it(self):
        ok, why = vs.judge(self.res(["A.t()", "C.t()"]), self.res(["A.t()"]))
        self.assertFalse(ok)
        self.assertIn("C.t()", why)
        self.assertNotIn("A.t()", why)

    def test_flaky_failures_pass_and_are_named(self):
        ok, why = vs.judge(self.res(["A.t()", "F.t()"]), self.res(["A.t()"]), {"F.t()"})
        self.assertTrue(ok)
        self.assertIn("1 flaky", why)
        self.assertIn("F.t()", why)

    def test_build_failure_refuses_unless_main_also_fails(self):
        self.assertFalse(vs.judge(self.res(build_failed=True), self.res())[0])
        self.assertTrue(vs.judge(self.res(build_failed=True), self.res(build_failed=True))[0])


class Tree(unittest.TestCase):
    """build_tree reproduces the gate: base main plus the fork's own changes, whole files."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.repo = os.path.join(self.tmp, "r")
        os.makedirs(self.repo)
        sh(self.repo, "git", "init", "-q", "-b", "main")
        self.fork_point = commit(self.repo, {"a.txt": "a0\n", "b.txt": "b0\n", "gone.txt": "x\n"}, "base")
        sh(self.repo, "git", "checkout", "-q", "-b", "fork")
        self.head = commit(self.repo, {"a.txt": "a-fork\n", "new.txt": "n\n"}, "fork", delete=["gone.txt"])
        sh(self.repo, "git", "checkout", "-q", "main")
        self.main = commit(self.repo, {"b.txt": "b-main\n", "m.txt": "m\n"}, "main moved")

    def read(self, p):
        path = os.path.join(self.repo, p)
        return open(path).read() if os.path.exists(path) else None

    def test_overlay(self):
        paths = vs.build_tree(self.repo, "main", self.head)
        self.assertEqual(sorted(paths), ["a.txt", "gone.txt", "new.txt"])
        self.assertEqual(self.read("a.txt"), "a-fork\n")    # fork's change
        self.assertEqual(self.read("b.txt"), "b-main\n")    # main's newer change kept
        self.assertEqual(self.read("m.txt"), "m\n")         # main's new file kept
        self.assertEqual(self.read("new.txt"), "n\n")       # fork's new file
        self.assertIsNone(self.read("gone.txt"))            # fork's delete applied

    def test_rebuild_resets_the_previous_overlay(self):
        vs.build_tree(self.repo, "main", self.head)
        with open(os.path.join(self.repo, "stray.txt"), "w") as f:
            f.write("left over\n")
        vs.build_tree(self.repo, "main", self.main)  # a fork with no changes of its own
        self.assertEqual(self.read("a.txt"), "a0\n")
        self.assertIsNone(self.read("stray.txt"))

    def test_assets_copied_by_sha_and_survive_rebuilds(self):
        src = os.path.join(self.tmp, "src")
        os.makedirs(os.path.join(src, "Frameworks"))
        with open(os.path.join(src, "Frameworks", "lib.a"), "wb") as f:
            f.write(b"binary")
        want = hashlib.sha256(b"binary").hexdigest()
        sh(self.repo, "git", "checkout", "-q", "main")
        commit(self.repo, {".foundry/assets.json": json.dumps(
            {"stripped": [{"path": "Frameworks/lib.a", "sha256": want}, {"path": "missing.bin", "sha256": "0" * 64}]})},
            "assets")
        copied, unmatched = vs.ensure_assets(self.repo, "main", [src])
        self.assertEqual((copied, unmatched), (1, ["missing.bin"]))
        vs.build_tree(self.repo, "main", self.head)
        self.assertEqual(open(os.path.join(self.repo, "Frameworks", "lib.a"), "rb").read(), b"binary")


    def origin_with_tool(self):
        """A separate origin repo holding an executable tool, as the seed's origin does; returns (url, sha)."""
        origin = os.path.join(self.tmp, "origin")
        os.makedirs(os.path.join(origin, "tools"))
        sh(origin, "git", "init", "-q", "-b", "main")
        sh(origin, "git", "config", "uploadpack.allowFilter", "true")
        with open(os.path.join(origin, "tools", "bin"), "wb") as f:
            f.write(b"tool-bytes")
        os.chmod(os.path.join(origin, "tools", "bin"), 0o755)
        sha = commit(origin, {}, "tool")
        return "file://" + origin, sha

    def manifest(self, entries, **top):
        sh(self.repo, "git", "checkout", "-q", "main")
        commit(self.repo, {".foundry/assets.json": json.dumps({"stripped": entries, **top})}, "assets")

    def test_asset_missing_locally_is_fetched_at_its_origin_commit(self):
        url, sha = self.origin_with_tool()
        want = hashlib.sha256(b"tool-bytes").hexdigest()
        self.manifest([{"path": "tools/bin", "sha256": want, "origin_commit": sha}], origin=url)
        cache = os.path.join(self.tmp, "cache.git")
        self.assertEqual(vs.ensure_assets(self.repo, "main", [os.path.join(self.tmp, "nowhere")], cache), (1, []))
        dst = os.path.join(self.repo, "tools", "bin")
        self.assertEqual(open(dst, "rb").read(), b"tool-bytes")
        self.assertTrue(os.access(dst, os.X_OK))
        self.assertEqual(sh(self.repo, "git", "status", "--porcelain"), "")  # excluded, not untracked work

    def test_a_local_clone_serves_the_blob_without_a_fetch(self):
        url, sha = self.origin_with_tool()
        want = hashlib.sha256(b"tool-bytes").hexdigest()
        self.manifest([{"path": "tools/bin", "sha256": want, "origin_commit": sha}], origin="file:///no/such/origin")
        clone = os.path.join(self.tmp, "clone")
        sh(self.tmp, "git", "clone", "-q", url, clone)
        os.remove(os.path.join(clone, "tools", "bin"))  # objects only: the file need not be checked out
        self.assertEqual(vs.ensure_assets(self.repo, "main", [clone], os.path.join(self.tmp, "c.git")), (1, []))

    def test_blob_with_the_wrong_sha_is_unmatched(self):
        url, sha = self.origin_with_tool()
        self.manifest([{"path": "tools/bin", "sha256": "0" * 64, "origin_commit": sha}], origin=url)
        self.assertEqual(vs.ensure_assets(self.repo, "main", [], os.path.join(self.tmp, "c.git")), (0, ["tools/bin"]))
        self.assertFalse(os.path.exists(os.path.join(self.repo, "tools", "bin")))

class Http(unittest.TestCase):
    def setUp(self):
        self.token = "t" * 40
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), vs.make_handler(self.token))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self._verify, self._root = vs.verify, vs.ROOT
        vs.ROOT = tempfile.mkdtemp()

    def tearDown(self):
        vs.verify, vs.ROOT = self._verify, self._root
        self.server.shutdown()

    def post(self, path, body, with_body=False):
        req = urllib.request.Request(self.url + path, data=json.dumps(body).encode(), method="POST",
                                     headers={"content-type": "application/json"})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, (json.loads(e.read() or b"{}") if with_body else None)

    def test_wrong_token_is_404(self):
        self.assertEqual(self.post("/" + "x" * 40 + "/api/verify", {})[0], 404)
        self.assertEqual(self.post("/api/verify", {})[0], 404)

    def test_unknown_base_is_nothing_checked(self):
        self.assertEqual(self.post(f"/{self.token}/api/verify", {"repo": "nope--claude-x", "headSha": "a" * 40}),
                         (200, {"runs": []}))

    def test_unjudged_asks_the_gate_to_retry(self):
        def boom(_req):
            raise vs.Unjudged("worker down")
        vs.verify = boom
        code, body = self.post(f"/{self.token}/api/verify", {"repo": "x"}, with_body=True)
        self.assertEqual((code, body["retry"]), (503, True))

    def test_crash_asks_for_a_retry(self):
        def crash(_req):
            raise RuntimeError("bug")
        vs.verify = crash
        self.assertEqual(self.post(f"/{self.token}/api/verify", {"repo": "x"})[0], 503)


class EndToEnd(unittest.TestCase):
    """verify() with fetch and the worker stubbed: recipe from base main, docs skip, baseline comparison."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.origin = os.path.join(self.tmp, "origin")
        os.makedirs(self.origin)
        sh(self.origin, "git", "init", "-q", "-b", "main")
        recipe = {"name": "xcodebuild test (mac5)", "host": "mac5", "command": ["xcodebuild", "test"], "skip": ["*.md", "docs/*"]}
        commit(self.origin, {".foundry/verify.json": json.dumps(recipe), "app.swift": "1\n", "README.md": "r\n"}, "base")
        sh(self.origin, "git", "checkout", "-q", "-b", "fork")
        self.code_head = commit(self.origin, {"app.swift": "2\n"}, "code")
        sh(self.origin, "git", "checkout", "-q", "-b", "docs", "main")
        self.docs_head = commit(self.origin, {"README.md": "r2\n"}, "docs")
        sh(self.origin, "git", "checkout", "-q", "main")
        # Stub fetch: a script that fetches from the local origin with the same refspec.
        self.fetch = os.path.join(self.tmp, "fetch.sh")
        with open(self.fetch, "w") as f:
            f.write(f'#!/bin/sh\nremote=$1; shift\nexec git fetch "{self.origin}" "$@"\n')
        os.chmod(self.fetch, 0o755)
        tasks = os.path.join(self.tmp, "tasks")
        os.makedirs(tasks)
        for t in ("app-code-1", "app-docs-1"):
            with open(os.path.join(tasks, f"task-{t}.json"), "w") as f:
                json.dump({"baseRepo": "app"}, f)
        self.saved = (vs.FETCH, vs.TASKS, vs.ROOT, vs.run_job)
        vs.FETCH, vs.TASKS, vs.ROOT = self.fetch, tasks, os.path.join(self.tmp, "verify")
        self.jobs, self.commands = [], []
        self.cfg = {"bases": {"app": {"sources": []}}}

    def tearDown(self):
        vs.FETCH, vs.TASKS, vs.ROOT, vs.run_job = self.saved

    def stub_jobs(self, *results):
        it = iter(results)

        def run_job(repo, recipe, name, deadline):
            self.jobs.append((name, open(os.path.join(repo, "app.swift")).read()))
            self.commands.append(recipe["command"])
            return {**next(it), "job": f"job-{len(self.jobs)}"}
        vs.run_job = run_job

    def test_docs_only_change_is_a_labelled_skip(self):
        self.stub_jobs()
        out = vs.verify({"repo": "app-docs-1--claude-x", "headSha": self.docs_head, "baseBranch": "docs"}, self.cfg)
        self.assertTrue(out["runs"][0]["ok"])
        self.assertIn("skipped", out["runs"][0]["output"])
        self.assertEqual(self.jobs, [])

    def test_code_change_runs_on_the_overlaid_tree(self):
        self.stub_jobs({"executed": 5, "failing": set(), "build_failed": False})
        out = vs.verify({"repo": "app-code-1--claude-x", "headSha": self.code_head, "baseBranch": "fork"}, self.cfg)
        self.assertEqual(out["runs"][0]["ok"], True)
        self.assertEqual(self.jobs, [("verify-app", "2\n")])

    def test_new_failure_refused_after_measuring_main(self):
        self.stub_jobs({"executed": 5, "failing": {"A.t()", "B.t()"}, "build_failed": False},
                       {"executed": 5, "failing": {"A.t()"}, "build_failed": False})
        out = vs.verify({"repo": "app-code-1--claude-x", "headSha": self.code_head, "baseBranch": "fork"}, self.cfg)
        self.assertFalse(out["runs"][0]["ok"])
        self.assertIn("B.t()", out["runs"][0]["output"])
        self.assertEqual([j[1] for j in self.jobs], ["2\n", "1\n"])  # candidate, then main itself

    def flaky_case(self, rerun):
        cand = {"executed": 5, "failing": {"B.t()"}, "build_failed": False, "ids": {"B.t()": "AppTests/B/t"}}
        self.stub_jobs(cand, {"executed": 5, "failing": set(), "build_failed": False}, rerun)
        return vs.verify({"repo": "app-code-1--claude-x", "headSha": self.code_head, "baseBranch": "fork"}, self.cfg)

    def test_new_failure_that_passes_on_rerun_is_flaky(self):
        out = self.flaky_case({"executed": 1, "failing": set(), "build_failed": False})
        self.assertTrue(out["runs"][0]["ok"])
        self.assertIn("flaky", out["runs"][0]["output"])
        # Candidate, main, then the candidate again (not main's tree) with only the new failure selected.
        self.assertEqual([j[1] for j in self.jobs], ["2\n", "1\n", "2\n"])
        self.assertEqual(self.jobs[2][0], "verify-app-rerun")
        self.assertIn("-only-testing:AppTests/B/t", self.commands[2])

    def test_new_failure_that_fails_again_is_refused(self):
        out = self.flaky_case({"executed": 1, "failing": {"B.t()"}, "build_failed": False})
        self.assertFalse(out["runs"][0]["ok"])
        self.assertIn("1 new failing: B.t()", out["runs"][0]["output"])

    def test_a_rerun_that_ran_nothing_proves_nothing(self):
        self.assertFalse(self.flaky_case({"executed": 0, "failing": set(), "build_failed": False})["runs"][0]["ok"])

    def test_main_baseline_is_cached_per_sha(self):
        fail = {"executed": 5, "failing": {"A.t()"}, "build_failed": False}
        self.stub_jobs(fail, fail, fail)
        req = {"repo": "app-code-1--claude-x", "headSha": self.code_head, "baseBranch": "fork"}
        self.assertTrue(vs.verify(req, self.cfg)["runs"][0]["ok"])
        self.assertTrue(vs.verify(req, self.cfg)["runs"][0]["ok"])
        self.assertEqual([j[0] for j in self.jobs], ["verify-app", "verify-app-main", "verify-app"])

    def test_base_without_a_recipe_checks_nothing(self):
        self.stub_jobs()
        self.assertEqual(vs.verify({"repo": "other-1--claude-x", "headSha": self.code_head}, self.cfg), {"runs": []})


class BusyWorker(unittest.TestCase):
    """A worker over its floors is waited on, then forced; any other start failure is unjudged."""

    def setUp(self):
        self.saved = (vs.FABRIC, vs.FORCE_AFTER_S, vs.ROOT, vs.time.sleep)
        self.tmp = tempfile.mkdtemp()
        vs.ROOT, vs.FORCE_AFTER_S = self.tmp, 0.005  # the first attempt runs inside it, the second past it
        vs.time.sleep = lambda s: None
        self.calls = os.path.join(self.tmp, "calls")
        self.fabric = os.path.join(self.tmp, "fabric")

    def tearDown(self):
        vs.FABRIC, vs.FORCE_AFTER_S, vs.ROOT, vs.time.sleep = self.saved

    def fake(self, body):
        with open(self.fabric, "w") as f:
            f.write("#!/bin/sh\necho \"$*\" >> %s\n%s\n" % (self.calls, body))
        os.chmod(self.fabric, 0o755)
        vs.FABRIC = self.fabric

    def test_busy_then_forced(self):
        self.fake('case "$*" in *--force*) [ "$1" = run ] && { echo "started job-v-1 on mac5"; exit 0; } ;; esac\n'
                  '[ "$2" = run ] && { echo "mac5: load: 9/core (use --force to run anyway)" >&2; exit 1; }\n'
                  '[ "$2" = ls ] && echo "job-v-1 mac5 done 0 t cmd"\n'
                  '[ "$2" = log ] && printf "\\t Executed 3 tests, with 0 failures (0 unexpected) in 1 (1) seconds\\n** TEST SUCCEEDED **\\n"\n'
                  'exit 0')
        # fabric's subcommand is $1 = job; normalise the stub's checks to the second word
        with open(self.fabric) as f:
            body = f.read().replace('[ "$1" = run ]', '[ "$2" = run ]')
        with open(self.fabric, "w") as f:
            f.write(body)
        res = vs.run_job(self.tmp, {"command": ["true"]}, "verify-x", time.time() + 600)
        self.assertEqual((res["job"], res["executed"]), ("job-v-1", 3))
        runs = [l for l in open(self.calls).read().splitlines() if l.startswith("job run")]
        self.assertEqual(["--force" in l for l in runs], [False, True])

    def test_other_start_failure_is_unjudged(self):
        self.fake('echo "sync to mac5 failed: no route" >&2; exit 1')
        with self.assertRaises(vs.Unjudged):
            vs.run_job(self.tmp, {"command": ["true"]}, "verify-x", time.time() + 600)


if __name__ == "__main__":
    unittest.main()

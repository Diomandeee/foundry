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
from unittest.mock import patch, Mock
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
# The shapes below are cut from real Mac5 job logs.
XCODE_TEST_COMPILE_FAIL = ("App.swift:1:1: error: cannot find 'x' in scope\nTesting failed:\n\tCannot find 'x' in scope\n"
                           "\tTesting cancelled because the build failed.\n\n** TEST FAILED **\n\n\n"
                           "The following build commands failed:\n\tSwiftCompile normal arm64 App.swift\n(1 failure)\n")
XCODE_NO_SIMULATOR = ("Resolved source packages:\n  SharedServices: /x/SharedServices\n\n"
                      "xcodebuild: error: Unable to find a device matching the provided destination specifier:\n"
                      "\t\t{ platform:iOS Simulator, id:AB9E8270-AF9B-4404-8125-DE25DCDF53AF }\n\n"
                      "\tThe requested device could not be found because no available devices matched the request.\n")
XCODE_RUNNER_NEVER_STARTED = "Testing failed:\n\tEarly unexpected exit, operation never finished bootstrapping\n\n** TEST FAILED **\n"
XCODE_ZERO_TESTS = "\t Executed 0 tests, with 0 failures (0 unexpected) in 0.0 (0.0) seconds\n** TEST SUCCEEDED **\n"
BRIDGE_UNITTEST_FAIL = "Ran 12 tests in 0.1s\n\nFAILED (failures=1)\n"
XCODE_PARALLEL_FAIL = "** TEST FAILED **\n\nTesting started\nTest case 'Suite.test_a()' failed on 'Clone 1 of iPhone (1)' (1.0 seconds)\n"


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

    def test_a_missing_simulator_never_reached_the_code(self):
        r = vs.parse_xcodebuild(XCODE_NO_SIMULATOR)
        self.assertIn("Unable to find a device", r["unreached"])
        self.assertIsNone(r["executed"])

    def test_nothing_that_ran_reads_as_unreached(self):
        for log in (XCODE_PASS, XCODE_FAIL, XCODE_BUILD_FAIL, XCODE_TEST_COMPILE_FAIL, BRIDGE_UNITTEST_FAIL, XCODE_PARALLEL_FAIL):
            self.assertIsNone(vs.parse_xcodebuild(log)["unreached"], log)

    def test_a_compile_failure_under_xcodebuild_test_is_a_build_failure(self):
        r = vs.parse_xcodebuild(XCODE_TEST_COMPILE_FAIL)
        self.assertEqual((r["build_failed"], r["executed"]), (True, None))

    def test_a_runner_that_never_started_is_unreached_and_says_why(self):
        self.assertIn("never finished bootstrapping", vs.parse_xcodebuild(XCODE_RUNNER_NEVER_STARTED)["unreached"])

    def test_zero_tests_and_empty_logs_are_unreached(self):
        self.assertTrue(vs.parse_xcodebuild(XCODE_ZERO_TESTS)["unreached"])
        self.assertTrue(vs.parse_xcodebuild("")["unreached"])

    def test_skipped_tests_are_counted(self):
        # Fabric's UI tests skip without a live bridge (job-verify-fabric-proof-1103-205315 parsed to executed=None)
        log = ("\t Executed 1 test, with 1 test skipped and 0 failures (0 unexpected) in 0.345 (0.346) seconds\n"
               "\t Executed 3 tests, with 3 tests skipped and 0 failures (0 unexpected) in 0.453 (0.455) seconds\n"
               "** TEST SUCCEEDED **\n")
        r = vs.parse_xcodebuild(log)
        self.assertEqual((r["executed"], r["skipped"], r["failing"], r["build_failed"]), (3, 3, set(), False))
        self.assertEqual(vs.judge({**r, "job": "job-x"}, None), (True, "3 tests (3 skipped), 0 failing (job-x)"))


# Cut from Mac5 job logs of 2026-11-10 (fleet, AirDeck, serenity-soother-studio at their gated mains).
UNITTEST_FAIL = ("======================================================================\n"
                 "FAIL: test_doctrine (test_triage.Classify.test_doctrine)\n"
                 "----------------------------------------------------------------------\n"
                 "AssertionError: Lists differ: ['copies', 'sessionstart'] != []\n\n"
                 "----------------------------------------------------------------------\n"
                 "Ran 131 tests in 13.096s\n\nFAILED (failures=1)\n")
UNITTEST_OLD_PYTHON = ("ERROR: test_x (test_mod.Case)\nFAIL: test_y (test_mod.Case)\n"
                       "ERROR: test_gone (unittest.loader._FailedTest)\n"
                       "Ran 9 tests in 0.2s\n\nFAILED (failures=1, errors=2, skipped=3)\n")
UNITTEST_PASS = "Ran 14 tests in 0.208s\n\nOK\n"
SWIFT_FAIL = ("Test Case '-[AirDeckKitTests.TakeShelfTests testTheTracklistIsWhatWentOnAirInOrder]' passed (0.000 seconds).\n"
              "Test Case '-[AirDeckKitTests.LinkFollowTests testFollows]' failed (2.001 seconds).\n"
              "Test Suite 'WaveShapeTests' passed at 2026-11-10 19:43:40.085.\n"
              "\t Executed 3 tests, with 0 failures (0 unexpected) in 0.012 (0.012) seconds\n"
              "Test Suite 'AirDeckKitTests.xctest' failed at 2026-11-10 19:43:40.085.\n"
              "\t Executed 278 tests, with 6 tests skipped and 5 failures (0 unexpected) in 146.709 (146.729) seconds\n"
              "Test Suite 'All tests' failed at 2026-11-10 19:43:40.085.\n"
              "\t Executed 278 tests, with 6 tests skipped and 5 failures (0 unexpected) in 146.709 (146.731) seconds\n"
              "\u25c7 Test run started.\n\u2714 Test run with 0 tests in 0 suites passed after 0.001 seconds.\n")
SWIFT_COMPILE_FAIL = ("/x/Sources/AirDeckKit/Deck.swift:12:9: error: cannot find 'x' in scope\n"
                      "error: fatalError\n")
VITEST_PASS = (" \u2713 tests/export.test.ts (15 tests) 39ms\n\n Test Files  20 passed (20)\n"
               "      Tests  284 passed (284)\n   Start at  19:44:57\n")
VITEST_FAIL = (" \u2713 src/__tests__/site.test.tsx (13 tests) 326ms\n\n"
               " FAIL  src/__tests__/heroPrints.test.ts > hero prints > ships scene art for every hero print\n"
               "AssertionError: scene 1: expected false to be true // Object.is equality\n"
               " FAIL  src/__tests__/broken.test.ts [ src/__tests__/broken.test.ts ]\n\n"
               " Test Files  2 failed | 7 passed (9)\n      Tests  1 failed | 67 passed | 2 skipped (70)\n")
PYTEST_FAIL = ("FAILED tests/test_a.py::CaseA::test_one - AssertionError: 1 != 2\n"
               "ERROR tests/test_gone.py - ModuleNotFoundError: No module named 'cv2'\n"
               "===== 1 failed, 40 passed, 3 skipped, 1 error in 12.34s =====\n")
PYTEST_QUIET_PASS = "1870 passed, 30 skipped in 80.05s (0:01:20)\n"
# MotionMix main on Mac5, 11-10: pytest-subtests adds a two-word count to the closing line.
PYTEST_SUBTESTS = ("ERROR tests/test_motionmix_anchor_color.py - NameError: name 'Mapping' is not...\n"
                   "137 failed, 2067 passed, 34 skipped, 13 warnings, 39 errors, 47 subtests passed in 148.14s (0:02:28)\n")
TSC_FAIL = "src/app/page.tsx(12,7): error TS2322: Type 'string' is not assignable to type 'number'.\n"


# Serenity iOS on Mac5, 11-10: every test is Swift Testing, so XCTest reports none.
XCODE_SWIFT_TESTING_PASS = ("\t Executed 0 tests, with 0 failures (0 unexpected) in 0.000 (0.004) seconds\n"
                            "\u2714 Test run with 237 tests in 55 suites passed after 0.523 seconds.\n"
                            "** TEST SUCCEEDED **\n")
XCODE_SWIFT_TESTING_FAIL = ("\t Executed 0 tests, with 0 failures (0 unexpected) in 0.000 (0.004) seconds\n"
                            "\u2718 Test \"Every moving world has its loop\" failed after 0.002 seconds with 1 issue.\n"
                            "\u2718 Test run with 237 tests in 55 suites failed after 0.523 seconds with 1 issue.\n"
                            "** TEST FAILED **\n")


class Runners(unittest.TestCase):
    """The parsers for runners other than xcodebuild, and how a check's several results become one."""

    def test_unittest_names_the_failure_by_module_class_method(self):
        r = vs.parse_log(UNITTEST_FAIL, ["unittest"], 1)
        self.assertEqual((r["executed"], r["failing"], r["unreached"]),
                         (131, {"test_triage.Classify.test_doctrine"}, None))

    def test_unittest_ids_match_across_python_versions_and_an_import_failure_has_a_name(self):
        r = vs.parse_unittest(UNITTEST_OLD_PYTHON)
        self.assertEqual(r["failing"], {"test_mod.Case.test_x", "test_mod.Case.test_y",
                                        "unittest.loader._FailedTest.test_gone"})
        self.assertEqual((r["executed"], r["skipped"]), (9, 3))

    def test_several_unittest_runs_in_one_command_add_up(self):
        self.assertEqual(vs.parse_log(UNITTEST_PASS + UNITTEST_PASS, ["unittest"], 0)["executed"], 28)

    def test_swift_test_counts_all_tests_once_and_names_xctest_failures(self):
        r = vs.parse_log(SWIFT_FAIL, ["swift"], 1)
        self.assertEqual((r["executed"], r["skipped"], r["failing"], r["build_failed"]),
                         (278, 6, {"AirDeckKitTests.LinkFollowTests.testFollows"}, False))

    def test_a_package_that_does_not_compile_is_a_build_failure(self):
        r = vs.parse_log(SWIFT_COMPILE_FAIL, ["swift"], 1)
        self.assertEqual((r["build_failed"], r["unreached"]), (True, None))

    def test_vitest_names_failures_and_a_file_that_did_not_load(self):
        r = vs.parse_log(VITEST_FAIL, ["vitest"], 1)
        self.assertEqual(r["failing"], {"src/__tests__/heroPrints.test.ts > hero prints > ships scene art for every hero print",
                                        "src/__tests__/broken.test.ts"})
        self.assertEqual((r["executed"], r["skipped"]), (70, 2))
        self.assertEqual(vs.parse_log(VITEST_PASS, ["vitest"], 0)["executed"], 284)

    def test_vitest_failures_the_log_does_not_name_still_fail(self):
        r = vs.parse_vitest(" Test Files  1 failed | 7 passed (8)\n      Tests  1 failed | 67 passed (68)\n")
        self.assertTrue(r["failing"])

    def test_pytest_names_failures_and_files_that_do_not_import(self):
        r = vs.parse_log(PYTEST_FAIL, ["pytest"], 1)
        self.assertEqual(r["failing"], {"tests/test_a.py::CaseA::test_one", "tests/test_gone.py"})
        self.assertEqual((r["executed"], r["skipped"]), (45, 3))
        self.assertEqual(vs.parse_log(PYTEST_QUIET_PASS, ["pytest"], 0)["executed"], 1900)
        r = vs.parse_log(PYTEST_SUBTESTS, ["pytest"], 1)
        self.assertEqual((r["executed"], r["unreached"]), (137 + 2067 + 34 + 39, None))
        self.assertIn("tests/test_motionmix_anchor_color.py", r["failing"])

    def test_xcodebuild_counts_swift_testing_beside_xctest(self):
        r = vs.parse_log(XCODE_SWIFT_TESTING_PASS)
        self.assertEqual((r["executed"], r["unreached"], r["build_failed"], r["failing"]), (237, None, False, set()))
        r = vs.parse_log(XCODE_SWIFT_TESTING_FAIL)
        self.assertEqual((r["executed"], r["unreached"], r["build_failed"]), (237, None, False))
        self.assertEqual(r["failing"], {'"Every moving world has its loop"'})

    def test_ansi_colour_does_not_hide_a_result(self):
        self.assertEqual(vs.parse_log("\x1b[32m Test Files \x1b[39m 20 passed (20)\n\x1b[2m      Tests \x1b[22m 284 passed (284)\n",
                                      ["vitest"], 0)["executed"], 284)

    def test_a_type_error_is_a_failure_named_for_its_file(self):
        r = vs.parse_log(VITEST_PASS + TSC_FAIL, ["tsc", "vitest"], 2)
        self.assertEqual((r["failing"], r["unreached"]), ({"tsc src/app/page.tsx"}, None))

    def test_tsc_says_nothing_when_clean_and_is_not_missed(self):
        self.assertIsNone(vs.parse_log(VITEST_PASS, ["tsc", "vitest"], 0)["unreached"])

    def test_a_named_runner_that_left_nothing_is_unreached(self):
        # npm ci died before vitest: nothing here says anything about the change
        self.assertIn("vitest", vs.parse_log(UNITTEST_PASS, ["unittest", "vitest"], 1)["unreached"])
        self.assertTrue(vs.parse_log("npm error network\n", ["vitest"], 1)["unreached"])
        self.assertTrue(vs.parse_log("", ["unittest"], None)["unreached"])

    def test_a_runner_missing_because_an_earlier_one_failed_is_judged_on_what_ran(self):
        r = vs.parse_log(UNITTEST_FAIL, ["unittest", "vitest"], 1)
        self.assertEqual((r["unreached"], r["failing"]), (None, {"test_triage.Classify.test_doctrine"}))

    def test_zero_tests_is_unreached(self):
        self.assertEqual(vs.parse_log("Ran 0 tests in 0.000s\n\nNO TESTS RAN\n", ["unittest"], 5)["unreached"], "zero tests ran")

    def test_a_failed_command_no_runner_explains_is_unreached(self):
        # the tests passed and something after them did not: not a pass, and not the change's fault either
        self.assertIn("exited 1", vs.parse_log(UNITTEST_PASS, ["unittest"], 1)["unreached"])

    def test_exit_judges_a_step_with_nothing_to_parse(self):
        ok = vs.parse_log("", ["tsc", "exit"], 0)
        self.assertEqual((ok["build_failed"], ok["unreached"], ok["executed"]), (False, None, 0))
        self.assertEqual(vs.judge({**ok, "job": "job-x"}, None), (True, "builds, no tests, 0 failing (job-x)"))
        bad = vs.parse_log("something broke\n", ["tsc", "exit"], 2)
        self.assertEqual((bad["build_failed"], bad["unreached"]), (True, None))
        named = vs.parse_log(TSC_FAIL, ["tsc", "exit"], 2)
        self.assertEqual((named["build_failed"], named["failing"]), (False, {"tsc src/app/page.tsx"}))
        self.assertTrue(vs.parse_log("", ["exit"], None)["unreached"])

    def test_exit_75_is_a_setup_failure_and_never_a_verdict(self):
        for kinds in (["exit"], ["tsc", "exit"], ["vitest"], ["unittest", "swift"]):
            self.assertIn("set itself up", vs.parse_log(VITEST_FAIL, kinds, 75)["unreached"], kinds)

    def test_xcodebuild_build_with_no_tests(self):
        ok = vs.parse_log("CompileSwift ...\n** BUILD SUCCEEDED **\n", ["xcbuild"], 0)
        self.assertEqual((ok["build_failed"], ok["unreached"]), (False, None))
        bad = vs.parse_log("error: cannot find 'x' in scope\n** BUILD FAILED **\n", ["xcbuild"], 65)
        self.assertEqual((bad["build_failed"], bad["unreached"]), (True, None))
        self.assertTrue(vs.parse_log("xcodebuild: error: no such scheme\n", ["xcbuild"], 70)["unreached"])

    def test_the_default_is_xcodebuild_exactly_as_before(self):
        self.assertEqual(vs.parse_kinds({}), ["xcodebuild"])
        self.assertEqual(vs.parse_log(XCODE_FAIL), vs.parse_xcodebuild(XCODE_FAIL))

    def test_xcodebuild_shares_a_check_with_nothing_and_unknown_parsers_are_refused(self):
        for bad in (["xcodebuild", "unittest"], ["nose"], "nose"):
            with self.assertRaises(vs.Unjudged):
                vs.parse_kinds({"parse": bad})


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

    def test_a_real_compile_failure_main_shares_still_passes(self):
        res = {**vs.parse_xcodebuild(XCODE_TEST_COMPILE_FAIL), "job": "job-x"}
        self.assertEqual(vs.reached(res, "x"), res)
        self.assertEqual(vs.judge(res, res), (True, "does not build, and neither does base main"))


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

        def run_job(repo, recipe, name, deadline, host=None):
            self.jobs.append((name, open(os.path.join(repo, "app.swift")).read()))
            self.commands.append(recipe["command"])
            return {**next(it), "job": f"job-{len(self.jobs)}"}
        vs.run_job = run_job

    RED = {"executed": 5, "failing": {"A.t()"}, "build_failed": False}

    def land(self, branch):
        """What the gate does with a passed change: base main becomes a merge whose tree is the tested tree."""
        sh(self.origin, "git", "checkout", "-q", "main")
        sh(self.origin, "git", "merge", "-q", "--no-ff", "--no-edit", branch)

    def next_change(self, files, task="app-code-1"):
        sh(self.origin, "git", "checkout", "-q", "-B", "next", "main")
        head = commit(self.origin, files, "next")
        sh(self.origin, "git", "checkout", "-q", "main")
        return {"repo": f"{task}--claude-x", "headSha": head, "baseBranch": "next"}

    def test_a_passed_change_is_the_next_mains_result_so_main_is_not_run_again(self):
        self.stub_jobs(self.RED, self.RED, self.RED)
        code = {"repo": "app-code-1--claude-x", "headSha": self.code_head, "baseBranch": "fork"}
        self.assertTrue(vs.verify(code, self.cfg)["runs"][0]["ok"])            # the change, then main: two jobs
        self.land("fork")
        out = vs.verify(self.next_change({"app.swift": "3\n"}), self.cfg)      # one job: main is the tree just passed
        self.assertEqual([j[0] for j in self.jobs], ["verify-app", "verify-app-main", "verify-app"])
        self.assertIn("1 failing as on main", out["runs"][0]["output"])

    def test_a_new_failure_is_still_refused_against_a_remembered_result(self):
        self.stub_jobs(self.RED, self.RED, {"executed": 5, "failing": {"A.t()", "B.t()"}, "build_failed": False})
        vs.verify({"repo": "app-code-1--claude-x", "headSha": self.code_head, "baseBranch": "fork"}, self.cfg)
        self.land("fork")
        out = vs.verify(self.next_change({"app.swift": "3\n"}), self.cfg)
        self.assertFalse(out["runs"][0]["ok"])
        self.assertIn("1 new failing: B.t()", out["runs"][0]["output"])
        self.assertEqual([j[0] for j in self.jobs], ["verify-app", "verify-app-main", "verify-app"])

    def test_a_refused_change_is_not_remembered(self):
        self.stub_jobs({"executed": 5, "failing": {"A.t()"}, "build_failed": False},
                       {"executed": 5, "failing": set(), "build_failed": False},
                       {"executed": 5, "failing": {"A.t()"}, "build_failed": False})
        out = vs.verify({"repo": "app-code-1--claude-x", "headSha": self.code_head, "baseBranch": "fork"}, self.cfg)
        self.assertFalse(out["runs"][0]["ok"])
        kept = [n for n in os.listdir(os.path.join(self.tmp, "verify", "app")) if n.startswith("baseline-")]
        self.assertEqual(kept, [f"baseline-t{sh(self.origin, 'git', 'rev-parse', 'main^{tree}')[:16]}.json"])

    def test_a_flaky_failure_is_not_remembered_as_failing(self):
        flaky = {"executed": 5, "failing": {"A.t()", "F.t()"}, "build_failed": False, "ids": {"F.t()": "T/F/t"}}
        self.stub_jobs(flaky, self.RED, {"executed": 1, "failing": set(), "build_failed": False})
        code = {"repo": "app-code-1--claude-x", "headSha": self.code_head, "baseBranch": "fork"}
        self.assertTrue(vs.verify(code, self.cfg)["runs"][0]["ok"])
        tree = sh(self.origin, "git", "rev-parse", self.code_head + "^{tree}")[:16]
        with open(os.path.join(self.tmp, "verify", "app", f"baseline-t{tree}.json")) as f:
            self.assertEqual(json.load(f)["failing"], ["A.t()"])

    def test_a_docs_landing_carries_mains_result_to_the_next_main(self):
        self.stub_jobs(self.RED, self.RED, self.RED)
        vs.verify({"repo": "app-code-1--claude-x", "headSha": self.code_head, "baseBranch": "fork"}, self.cfg)
        self.land("fork")
        docs = self.next_change({"README.md": "r3\n"}, task="app-docs-1")
        self.assertIn("skipped", vs.verify(docs, self.cfg)["runs"][0]["output"])
        self.land("next")
        vs.verify(self.next_change({"app.swift": "4\n"}), self.cfg)
        self.assertEqual([j[0] for j in self.jobs], ["verify-app", "verify-app-main", "verify-app"])

    def test_results_older_than_two_weeks_are_dropped(self):
        work = os.path.join(self.tmp, "verify", "app")
        os.makedirs(work)
        old = os.path.join(work, "baseline-t" + "0" * 16 + ".json")
        with open(old, "w") as f:
            f.write("{}")
        os.utime(old, (time.time() - 15 * 86400,) * 2)
        self.stub_jobs({"executed": 5, "failing": set(), "build_failed": False})
        vs.verify({"repo": "app-code-1--claude-x", "headSha": self.code_head, "baseBranch": "fork"}, self.cfg)
        self.assertFalse(os.path.exists(old))

    def test_docs_only_change_is_a_labelled_skip(self):
        self.stub_jobs()
        out = vs.verify({"repo": "app-docs-1--claude-x", "headSha": self.docs_head, "baseBranch": "docs"}, self.cfg)
        self.assertTrue(out["runs"][0]["ok"])
        self.assertIn("skipped", out["runs"][0]["output"])
        # the gate's receipt keeps the name alone: a docs skip must not read there as a test run
        self.assertEqual(out["runs"][0]["name"], "xcodebuild test (mac5) [skipped: docs only]")
        self.assertEqual(self.jobs, [])

    def test_code_change_runs_on_the_overlaid_tree(self):
        self.stub_jobs({"executed": 5, "failing": set(), "build_failed": False})
        out = vs.verify({"repo": "app-code-1--claude-x", "headSha": self.code_head, "baseBranch": "fork"}, self.cfg)
        self.assertEqual(out["runs"][0]["ok"], True)
        self.assertEqual(out["runs"][0]["name"], "xcodebuild test (mac5) [5 tests]")
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

    # ---- a check placed on two hosts keeps main's result per host ----

    PLACED = {"name": "app test", "need": "sims", "skip": ["*.md"], "placements": [
        {"host": "mac5", "simulator": "11111111-1111-1111-1111-111111111111", "derived_data": "/Volumes/X/dd"},
        {"host": "mac4", "simulator": "22222222-2222-2222-2222-222222222222", "derived_data": "/Users/t/.fleet/dd/x"}],
        "command": ["xcodebuild", "test", "-destination", "platform=iOS Simulator,id={simulator}",
                    "-derivedDataPath", "{derived_data}"]}

    def placed(self, *results):
        """Main carrying PLACED; run_job stubbed to report the host each result names (default mac5)."""
        sh(self.origin, "git", "checkout", "-q", "main")
        commit(self.origin, {".foundry/verify.json": json.dumps(self.PLACED)}, "placed")
        it, self.pinned = iter(results), []

        def run_job(repo, recipe, name, deadline, host=None):
            self.pinned.append((name, host))
            res = next(it)
            self.assertTrue(host is None or res.get("host", "mac5") == host)
            return {"host": "mac5", **res, "job": f"job-{len(self.pinned)}"}
        vs.run_job = run_job

    def test_main_is_measured_on_the_candidates_host_never_taken_from_the_other(self):
        self.placed({**self.RED, "host": "mac4", "ids": {"A.t()": "AppTests/A/t"}}, {**self.GREEN_, "host": "mac4"},
                    {**self.RED, "host": "mac4"})
        tree = sh(self.origin, "git", "rev-parse", "main^{tree}")
        os.makedirs(os.path.join(self.tmp, "verify", "app"), exist_ok=True)
        with open(vs.result_path(os.path.join(self.tmp, "verify", "app"), tree, host="mac5"), "w") as f:
            json.dump({**self.RED, "failing": ["A.t()"], "job": "job-mac5"}, f)   # red on Mac5 alone
        out = vs.verify(self.next_change({"app.swift": "3\n"}), self.cfg)
        self.assertFalse(out["runs"][0]["ok"], "A.t() fails on Mac4 where main passes there: the change's doing")
        self.assertEqual(self.pinned, [("verify-app", None), ("verify-app-main", "mac4"), ("verify-app-rerun", "mac4")])
        self.assertIn(f"baseline-t{tree[:16]}-@mac4.json", self.baselines())

    def test_a_passed_change_is_remembered_for_its_host_alone(self):
        self.placed(self.RED, self.RED, {**self.RED, "host": "mac4"}, {**self.RED, "host": "mac4"})
        self.assertTrue(vs.verify(self.next_change({"app.swift": "3\n"}), self.cfg)["runs"][0]["ok"])
        self.land("next")
        out = vs.verify(self.next_change({"app.swift": "4\n"}), self.cfg)
        self.assertTrue(out["runs"][0]["ok"])
        self.assertEqual(self.pinned, [("verify-app", None), ("verify-app-main", "mac5"),
                                       ("verify-app", None), ("verify-app-main", "mac4")])
        tree = sh(self.origin, "git", "rev-parse", "main^{tree}")
        self.assertIn(f"baseline-t{tree[:16]}-@mac5.json", self.baselines())

    def test_a_docs_landing_carries_each_hosts_result(self):
        self.placed(self.RED, self.RED)
        vs.verify(self.next_change({"app.swift": "3\n"}), self.cfg)
        self.land("next")
        vs.verify(self.next_change({"README.md": "docs\n"}), self.cfg)
        self.land("next")
        tree = sh(self.origin, "git", "rev-parse", "main^{tree}")
        self.assertIn(f"baseline-t{tree[:16]}-@mac5.json", self.baselines())

    GREEN_ = {"executed": 5, "failing": set(), "build_failed": False}

    def test_main_baseline_is_cached_per_sha(self):
        fail = {"executed": 5, "failing": {"A.t()"}, "build_failed": False}
        self.stub_jobs(fail, fail, fail)
        req = {"repo": "app-code-1--claude-x", "headSha": self.code_head, "baseBranch": "fork"}
        self.assertTrue(vs.verify(req, self.cfg)["runs"][0]["ok"])
        self.assertTrue(vs.verify(req, self.cfg)["runs"][0]["ok"])
        self.assertEqual([j[0] for j in self.jobs], ["verify-app", "verify-app-main", "verify-app"])

    def parsed(self, log):
        return vs.parse_xcodebuild(log)

    def req(self):
        return {"repo": "app-code-1--claude-x", "headSha": self.code_head, "baseBranch": "fork"}

    def baselines(self):
        return [n for n in os.listdir(os.path.join(self.tmp, "verify", "app")) if n.startswith("baseline-")]

    def test_the_2026_11_09_hole_a_dead_simulator_on_both_sides_is_unjudged(self):
        # gate merge a5dfd73: exit 70 on the candidate and on main read as "neither builds" and merged.
        self.stub_jobs(self.parsed(XCODE_NO_SIMULATOR), self.parsed(XCODE_NO_SIMULATOR))
        with self.assertRaises(vs.Unjudged) as e:
            vs.verify(self.req(), self.cfg)
        self.assertIn("Unable to find a device", str(e.exception))
        self.assertEqual([j[0] for j in self.jobs], ["verify-app"])  # main is not measured for a run that told us nothing

    def test_main_unreached_is_unjudged_and_not_cached(self):
        self.stub_jobs(self.parsed(XCODE_TEST_COMPILE_FAIL), self.parsed(XCODE_NO_SIMULATOR))
        with self.assertRaises(vs.Unjudged):
            vs.verify(self.req(), self.cfg)
        self.assertEqual(self.baselines(), [])

    def test_compile_failure_main_shares_passes_end_to_end(self):
        self.stub_jobs(self.parsed(XCODE_TEST_COMPILE_FAIL), self.parsed(XCODE_TEST_COMPILE_FAIL))
        out = vs.verify(self.req(), self.cfg)
        self.assertEqual(out["runs"][0], {"name": "xcodebuild test (mac5) [not built, nor is base main]", "ok": True,
                                          "output": "does not build, and neither does base main"})

    def test_compile_failure_on_a_green_main_is_refused(self):
        self.stub_jobs(self.parsed(XCODE_TEST_COMPILE_FAIL), self.parsed(XCODE_PASS))
        self.assertFalse(vs.verify(self.req(), self.cfg)["runs"][0]["ok"])

    def recipe_proposal(self, old, new):
        """A main whose recipe is `old` and a fork whose recipe is `new`; the fork's head."""
        sh(self.origin, "git", "checkout", "-q", "main")
        commit(self.origin, {".foundry/verify.json": json.dumps(old)}, "recipe")
        sh(self.origin, "git", "checkout", "-q", "fork")
        sh(self.origin, "git", "merge", "-q", "--no-edit", "main")
        return commit(self.origin, {".foundry/verify.json": json.dumps(new, indent=1)}, "proposal")

    def test_a_proposal_that_only_swaps_the_simulator_is_run_on_the_new_one(self):
        dead, alive = "AB9E8270-AF9B-4404-8125-DE25DCDF53AF", "C1AB6BF6-049B-4C64-B707-73E33F42E371"
        cmd = lambda sim: ["xcodebuild", "test", "-destination", f"platform=iOS Simulator,id={sim}"]
        head = self.recipe_proposal({"name": "t", "command": cmd(dead)}, {"name": "t", "command": cmd(alive)})
        self.stub_jobs(self.parsed(XCODE_PASS))
        self.assertTrue(vs.verify({**self.req(), "headSha": head}, self.cfg)["runs"][0]["ok"])
        self.assertEqual(self.commands, [cmd(alive)])

    def test_a_proposal_that_changes_anything_else_is_judged_by_mains_recipe(self):
        dead = "AB9E8270-AF9B-4404-8125-DE25DCDF53AF"
        real = ["xcodebuild", "test", "-destination", f"id={dead}"]
        head = self.recipe_proposal({"name": "t", "command": real},
                                    {"name": "t", "command": ["sh", "-c", "echo ** TEST SUCCEEDED **"]})
        self.stub_jobs(self.parsed(XCODE_PASS))
        vs.verify({**self.req(), "headSha": head}, self.cfg)
        self.assertEqual(self.commands, [real])

    def test_a_base_link_is_the_siblings_merged_tree(self):
        # The sibling base: its main has lib/core.swift; a working-tree edit there must not be what is built.
        sib = os.path.join(self.tmp, "sibling")
        os.makedirs(sib)
        sh(sib, "git", "init", "-q", "-b", "main")
        sib_sha = commit(sib, {"lib/core.swift": "merged\n", "other/x": "x\n"}, "sib")
        with open(os.path.join(sib, "lib/core.swift"), "w") as f:
            f.write("dirty\n")
        with open(self.fetch, "w") as f:
            f.write(f'#!/bin/sh\nremote=$1; shift\n[ "$remote" = sib ] && exec git fetch "{sib}" "$@"\n'
                    f'exec git fetch "{self.origin}" "$@"\n')
        recipe = {"name": "t", "command": ["xcodebuild", "test"], "links": {
            "../Sib/lib": {"base": "sib", "path": "lib"}, "../Shared": "/somewhere/Shared"}}
        sh(self.origin, "git", "checkout", "-q", "main")
        commit(self.origin, {".foundry/verify.json": json.dumps(recipe)}, "recipe with a base link")
        sh(self.origin, "git", "checkout", "-q", "fork")
        sh(self.origin, "git", "merge", "-q", "--no-edit", "main")
        head = commit(self.origin, {"app.swift": "3\n"}, "code again")
        seen = []

        def run_job(repo, recipe, name, deadline, host=None):
            seen.append(recipe["links"])
            return {"executed": 1, "failing": {"A.t()"} if name == "verify-app" else set(), "build_failed": False}
        vs.run_job = run_job
        out = vs.verify({"repo": "app-code-1--claude-x", "headSha": head, "baseBranch": "fork"}, self.cfg)
        self.assertFalse(out["runs"][0]["ok"])
        links = seen[0]
        self.assertEqual(links["../Shared"], "/somewhere/Shared")
        self.assertEqual(open(os.path.join(links["../Sib/lib"], "core.swift")).read(), "merged\n")
        self.assertFalse(os.path.exists(os.path.join(os.path.dirname(links["../Sib/lib"]), "other")))
        self.assertIn(sib_sha[:12], links["../Sib/lib"])
        cached = [n for n in os.listdir(os.path.join(self.tmp, "verify", "app")) if n.startswith("baseline-")]
        main_tree = sh(self.origin, "git", "rev-parse", "main^{tree}")[:16]
        self.assertEqual(cached, [f"baseline-t{main_tree}-sib{sib_sha[:12]}.json"])

    def test_a_malformed_base_link_is_unjudged(self):
        with self.assertRaises(vs.Unjudged):
            vs.resolve_links(self.origin, {"links": {"../x": {"base": "sib", "path": "../etc"}}}, self.tmp)

    # ---- a recipe with several checks ----

    MONO = {"name": "mono checks", "host": "mac5", "need": "heavy_jobs", "skip": ["*.md"], "checks": [
        {"name": "web vitest", "when": ["web/*"], "parse": ["vitest"], "command": ["web"]},
        {"name": "ios xcodebuild test", "when": ["ios/*"], "need": "sims", "command": ["ios"]},
        {"name": "tools unittest", "when": ["tools/*", "web/shared/*"], "parse": ["unittest"], "command": ["tools"]}]}

    def mono(self, files):
        """Main carrying the MONO recipe, and a fork that changes `files`; the request for it."""
        sh(self.origin, "git", "checkout", "-q", "main")
        commit(self.origin, {".foundry/verify.json": json.dumps(self.MONO), "web/a.ts": "1\n", "ios/A.swift": "1\n",
                             "tools/t.py": "1\n", "web/shared/s.ts": "1\n", "other/x.txt": "1\n"}, "mono")
        sh(self.origin, "git", "checkout", "-q", "-B", "mono-fork", "main")
        head = commit(self.origin, files, "change")
        sh(self.origin, "git", "checkout", "-q", "main")
        return {"repo": "app-code-1--claude-x", "headSha": head, "baseBranch": "mono-fork"}

    def stub_checks(self, *results):
        it, self.seen = iter(results), []

        def run_job(repo, recipe, name, deadline, host=None):
            self.seen.append((name, recipe["command"][0], recipe.get("need"), recipe.get("host"),
                              open(os.path.join(repo, "web/a.ts")).read()))
            return {**next(it), "job": f"job-{len(self.seen)}"}
        vs.run_job = run_job

    GREEN = {"executed": 7, "failing": set(), "build_failed": False}

    def test_only_the_checks_a_change_touches_run(self):
        self.stub_checks(self.GREEN)
        out = vs.verify(self.mono({"web/a.ts": "2\n"}), self.cfg)
        self.assertEqual([(n, c) for n, c, *_ in self.seen], [("verify-app-web-vitest", "web")])
        self.assertEqual(out["runs"], [{"name": "web vitest [7 tests]", "ok": True, "output": "7 tests, 0 failing (job-1)"}])

    def test_a_check_inherits_host_and_need_and_may_set_its_own(self):
        self.stub_checks(self.GREEN, self.GREEN)
        vs.verify(self.mono({"web/a.ts": "2\n", "ios/A.swift": "2\n"}), self.cfg)
        self.assertEqual([(c, need, host) for _, c, need, host, _ in self.seen],
                         [("web", "heavy_jobs", "mac5"), ("ios", "sims", "mac5")])

    def test_a_path_two_checks_cover_runs_both_and_each_gets_a_run(self):
        self.stub_checks(self.GREEN, self.GREEN)
        out = vs.verify(self.mono({"web/shared/s.ts": "2\n"}), self.cfg)
        self.assertEqual([r["name"] for r in out["runs"]], ["web vitest [7 tests]", "tools unittest [7 tests]"])

    def test_a_change_no_check_covers_is_nothing_checked_not_a_pass(self):
        self.stub_checks()
        self.assertEqual(vs.verify(self.mono({"other/x.txt": "2\n"}), self.cfg), {"runs": []})
        self.assertEqual(self.seen, [])

    def test_docs_are_not_what_makes_a_check_due(self):
        self.stub_checks(self.GREEN)
        out = vs.verify(self.mono({"ios/README.md": "r\n", "web/a.ts": "2\n"}), self.cfg)
        self.assertEqual([r["name"] for r in out["runs"]], ["web vitest [7 tests]"])

    def test_a_docs_only_change_to_a_monorepo_is_one_labelled_skip(self):
        self.stub_checks()
        out = vs.verify(self.mono({"ios/README.md": "r\n"}), self.cfg)
        self.assertEqual([r["name"] for r in out["runs"]], ["mono checks [skipped: docs only]"])

    def test_one_failing_check_refuses_and_the_next_runs_on_the_candidate_again(self):
        red = {"executed": 7, "failing": {"web/a.test.ts > breaks"}, "build_failed": False}
        # web: candidate red, main green, rerun red again. Then ios, which must see the fork's tree, not main's.
        self.stub_checks(red, self.GREEN, red, self.GREEN)
        out = vs.verify(self.mono({"web/a.ts": "2\n", "ios/A.swift": "2\n"}), self.cfg)
        self.assertEqual([r["ok"] for r in out["runs"]], [False, True])
        self.assertEqual([(n, tree) for n, _, _, _, tree in self.seen],
                         [("verify-app-web-vitest", "2\n"), ("verify-app-web-vitest-main", "1\n"),
                          ("verify-app-web-vitest-rerun", "2\n"), ("verify-app-ios-xcodebuild-test", "2\n")])

    def test_a_failure_that_passes_when_the_check_runs_again_is_flaky(self):
        red = {"executed": 7, "failing": {"web/a.test.ts > flickers"}, "build_failed": False}
        self.stub_checks(red, self.GREEN, self.GREEN)
        out = vs.verify(self.mono({"web/a.ts": "2\n"}), self.cfg)
        self.assertTrue(out["runs"][0]["ok"])
        self.assertIn("1 flaky", out["runs"][0]["output"])

    def test_a_whole_rerun_that_ran_less_proves_nothing(self):
        red = {"executed": 7, "failing": {"web/a.test.ts > breaks"}, "build_failed": False}
        self.stub_checks(red, self.GREEN, {"executed": 2, "failing": set(), "build_failed": False})
        self.assertFalse(vs.verify(self.mono({"web/a.ts": "2\n"}), self.cfg)["runs"][0]["ok"])

    def test_each_check_keeps_its_own_baseline(self):
        red = {"executed": 7, "failing": {"x"}, "build_failed": False}
        self.stub_checks(red, red, red, red)
        vs.verify(self.mono({"web/a.ts": "2\n", "tools/t.py": "2\n"}), self.cfg)
        main = "t" + sh(self.origin, "git", "rev-parse", "main^{tree}")[:16]
        of_main = sorted(n for n in self.baselines() if main in n)
        self.assertEqual(of_main, [f"baseline-tools-unittest-{main}.json", f"baseline-web-vitest-{main}.json"])
        self.assertEqual(len(self.baselines()), 4)   # and both, as passed, for the tree the change makes

    def test_a_malformed_checks_list_is_unjudged(self):
        for bad in ([], [{"name": "a"}], [{"name": "a", "command": ["x"]}, {"name": "A!", "command": ["y"]}], "x"):
            with self.assertRaises(vs.Unjudged):
                vs.checks_of({"checks": bad})

    def test_base_without_a_recipe_checks_nothing(self):
        self.stub_jobs()
        self.assertEqual(vs.verify({"repo": "other-1--claude-x", "headSha": self.code_head}, self.cfg), {"runs": []})


class BusyWorker(unittest.TestCase):
    """All admission is unforced. Refusal retries stay within the original deadline."""

    def setUp(self):
        self.saved = (vs.FABRIC, vs.PLACEMENT_RETRY_S, vs.ROOT, vs.time.sleep)
        self.tmp = tempfile.mkdtemp()
        vs.ROOT, vs.PLACEMENT_RETRY_S = self.tmp, 0.01
        vs.time.sleep = lambda s: None
        self.calls = os.path.join(self.tmp, "calls")
        self.fabric = os.path.join(self.tmp, "fabric")

    def tearDown(self):
        vs.FABRIC, vs.PLACEMENT_RETRY_S, vs.ROOT, vs.time.sleep = self.saved

    def runs(self):
        return ["--force" in l for l in open(self.calls).read().splitlines() if l.startswith("job run")]

    def fake_floor(self, refusal):
        """A worker that refuses every unforced start with `refusal`, and runs a forced one."""
        self.fake('case "$*" in *--force*) [ "$2" = run ] && { echo "started job-v-1 on mac5"; exit 0; } ;; esac\n'
                  '[ "$2" = run ] && { echo "%s" >&2; exit 1; }\n'
                  '[ "$2" = ls ] && echo "job-v-1 mac5 done 0 t cmd"\n'
                  '[ "$2" = log ] && printf "\\t Executed 3 tests, with 0 failures (0 unexpected) in 1 (1) seconds\\n** TEST SUCCEEDED **\\n"\n'
                  'exit 0' % refusal)

    def test_every_job_honours_load_refusals(self):
        self.fake_floor("mac5: load: 9/core (use --force to run anyway)")
        for _ in range(3):
            with self.assertRaises(vs.Unjudged):
                vs.run_job(self.tmp, {"host": "mac5", "command": ["true"]}, "verify-x", time.time() + 60.05)
        self.assertGreaterEqual(len(self.runs()), 3)
        self.assertFalse(any(self.runs()))

    def test_a_disk_floor_is_unjudged_without_forcing_or_waiting(self):
        slept = []
        vs.time.sleep = slept.append
        self.fake_floor("mac5: disk: 14 GB < 15 GB (use --force to run anyway; memory is never skipped)")
        with self.assertRaisesRegex(vs.Unjudged, "disk"):
            vs.run_job(self.tmp, {"host": "mac5", "command": ["true"]}, "verify-x", time.time() + 600)
        self.assertEqual(self.runs(), [False])
        self.assertEqual(slept, [])

    def test_an_expired_request_never_submits(self):
        self.fake_floor("mac5: load: 5.4/core (use --force to run anyway; memory is never skipped)")
        slept = []
        vs.time.sleep = slept.append
        with self.assertRaisesRegex(vs.Unjudged, "deadline"):
            vs.run_job(self.tmp, {"command": ["true"]}, "verify-x", time.time() - 1)
        self.assertFalse(os.path.exists(self.calls))
        self.assertEqual(slept, [])

    def test_simulator_jobs_take_turns_and_other_jobs_do_not_wait_for_them(self):
        flag = os.path.join(self.tmp, "first-may-end")
        started, lock = [], threading.Lock()
        real_start = vs._start_and_wait

        def start(cmd, tail, name, deadline):
            with lock:
                started.append(name)
            while name == "sim-1" and not os.path.exists(flag):
                time.sleep(0.01)
            return "job-" + name, ["job-" + name, "mac5", "done", "0"]
        vs._start_and_wait, saved_sleep, vs.time.sleep = start, vs.time.sleep, self.saved[3]
        self.fake('[ "$2" = log ] && printf "\\t Executed 3 tests, with 0 failures (0 unexpected) in 1 (1) seconds\\n** TEST SUCCEEDED **\\n"\nexit 0')
        try:
            run = lambda name, need: threading.Thread(
                target=vs.run_job, args=(self.tmp, {"host": "mac5", "command": ["true"], "need": need}, name, time.time() + 600))
            first, second, light = run("sim-1", "sims"), run("sim-2", "sims"), run("py-1", "heavy_jobs")
            first.start()
            while "sim-1" not in started:
                time.sleep(0.01)
            second.start()
            light.start()
            light.join(5)
            self.assertFalse(light.is_alive())                 # the Python job did not wait for the simulator
            self.assertEqual(sorted(started), ["py-1", "sim-1"])  # the second simulator job has not started
            open(flag, "w").close()
            first.join(5)
            second.join(5)
            self.assertEqual(started, ["sim-1", "py-1", "sim-2"])
        finally:
            open(flag, "w").close()
            vs._start_and_wait, vs.time.sleep = real_start, saved_sleep

    def test_each_base_has_its_own_lock(self):
        self.assertIs(vs.base_lock("a"), vs.base_lock("a"))
        self.assertIsNot(vs.base_lock("a"), vs.base_lock("b"))
        with vs.base_lock("a"):
            self.assertEqual(vs.busy(), ["a"])
            self.assertTrue(vs.base_lock("b").acquire(blocking=False))
            vs.base_lock("b").release()

    def test_a_memory_refusal_is_waited_on_without_force(self):
        count = os.path.join(self.tmp, "n")
        self.fake('[ "$2" = run ] && { echo x >> %s; [ $(wc -l < %s) -lt 3 ] && '
                  '{ echo "mac5: memory: 8%% free < 15%% (use --force to run anyway; memory is never skipped)" >&2; exit 1; }; '
                  'echo "started job-v-1 on mac5"; exit 0; }\n'
                  '[ "$2" = ls ] && echo "job-v-1 mac5 done 0 t cmd"\n'
                  '[ "$2" = log ] && printf "\\t Executed 3 tests, with 0 failures (0 unexpected) in 1 (1) seconds\\n** TEST SUCCEEDED **\\n"\n'
                  'exit 0' % (count, count))
        res = vs.run_job(self.tmp, {"command": ["true"]}, "verify-x", time.time() + 600)
        self.assertEqual((res["executed"], self.runs()), (3, [False, False, False]))

    def test_a_rejected_placement_releases_its_lock(self):
        self.fake_floor("mac5: disk: 14 GB < 15 GB")
        with self.assertRaises(vs.Unjudged):
            vs.run_job(self.tmp, {"host": "mac5", "command": ["true"]}, "verify-x", time.time() + 600)
        self.assertFalse(vs.host_lock("mac5").locked())

    def fake(self, body):
        with open(self.fabric, "w") as f:
            f.write("#!/bin/sh\necho \"$*\" >> %s\n%s\n" % (self.calls, body))
        os.chmod(self.fabric, 0o755)
        vs.FABRIC = self.fabric

    def test_busy_then_available_stays_unforced(self):
        with patch.object(vs, "_start_and_wait", side_effect=[vs.WorkerRefused("busy", True),
                ("job-v-1", ["job-v-1", "mac5", "done", "0"])]) as start:
            self.fake('[ "$2" = log ] && printf "\\t Executed 3 tests, with 0 failures (0 unexpected) in 1 (1) seconds\\n** TEST SUCCEEDED **\\n"\nexit 0')
            res = vs.run_job(self.tmp, {"host": "mac5", "command": ["true"]}, "verify-x", time.time() + 600)
        self.assertEqual(res["executed"], 3)
        self.assertEqual(start.call_count, 2)
        self.assertTrue(all("--force" not in c.args[0] for c in start.call_args_list))

    def test_a_performing_worker_is_never_forced(self):
        self.fake('[ "$2" = run ] && { echo "no host for --host mac5: busy: file:.fleet/performing running '
                  '(stage, held 7.5 h)" >&2; exit 1; }\n'
                  '[ "$2" = ls ] && echo "job-v-1 mac5 done 0 t cmd"\n'
                  'exit 0')
        with self.assertRaises(vs.Unjudged) as e:
            vs.run_job(self.tmp, {"command": ["true"]}, "verify-x", time.time() + 60.3)
        self.assertIn("performing", str(e.exception))
        self.assertTrue(self.runs())
        self.assertFalse(any(self.runs()), "a start was forced past the performing flag")

    def test_other_start_failure_is_unjudged(self):
        self.fake('echo "sync to mac5 failed: no route" >&2; exit 1')
        with self.assertRaises(vs.Unjudged):
            vs.run_job(self.tmp, {"command": ["true"]}, "verify-x", time.time() + 600)


class LateJobs(unittest.TestCase):
    """A job still running at its request's deadline keeps running, keeps the simulator, and the gate's retry of
    the same check takes its result (2026-11-14: Mac5 under renders, every retry stopped its job and restarted)."""

    def setUp(self):
        self.saved = (vs.FABRIC, vs.ROOT, vs.time.sleep, vs.LATE_MORE_S)
        self.tmp = tempfile.mkdtemp()
        vs.ROOT = self.tmp
        real_sleep = self.saved[2]
        vs.time.sleep = lambda s: real_sleep(0.005)
        vs.LATE.clear()
        self.calls = os.path.join(self.tmp, "calls")
        self.state = os.path.join(self.tmp, "state")
        self.set_state("running")
        self.ssh_stub()  # all stop paths, including generic builds, confirm the remote session is gone
        self.fabric = os.path.join(self.tmp, "fabric")
        with open(self.fabric, "w") as f:
            f.write('#!/bin/sh\necho "$*" >> %s\n'
                    '[ "$2" = run ] && { echo "started job-v-1 on mac5"; exit 0; }\n'
                    '[ "$2" = ls ] && { echo "job-v-1 mac5 $(cat %s) 0 t cmd"; exit 0; }\n'
                    '[ "$2" = log ] && printf "\\t Executed 3 tests, with 0 failures (0 unexpected) in 1 (1) seconds\\n** TEST SUCCEEDED **\\n"\n'
                    'exit 0\n' % (self.calls, self.state))
        os.chmod(self.fabric, 0o755)
        vs.FABRIC = self.fabric
        self.repo = os.path.join(self.tmp, "repo")
        os.makedirs(self.repo)
        sh(self.repo, "git", "init", "-q")
        commit(self.repo, {"a.txt": "a\n"}, "one")

    def tearDown(self):
        self.set_state("done")
        for late in list(vs.LATE.values()):
            late.done.wait(5)
        vs.LATE.clear()
        vs.FABRIC, vs.ROOT, vs.time.sleep, vs.LATE_MORE_S = self.saved

    def set_state(self, state):
        with open(self.state, "w") as f:
            f.write(state)

    def test_a_job_past_the_newest_twenty_is_still_found(self):
        """11-14 decision 2520: other lanes started 20 jobs while an adopted one ran, `job ls` stopped listing it,
        and its end was never seen. The row is read from a long list."""
        with open(self.fabric, "w") as f:
            f.write('#!/bin/sh\n[ "$2" = ls ] && [ "$3" = --last ] && [ "$4" -ge 100 ] && echo "job-old mac5 failed 65 t cmd"\n'
                    'exit 0\n')
        self.assertEqual(vs.job_row("job-old"), ["job-old", "mac5", "failed", "65", "t", "cmd"])
        self.assertIsNone(vs.job_row("job-other"))

    def count(self, verb):
        return sum(1 for l in open(self.calls).read().splitlines() if l.startswith("job " + verb))

    def run_sim(self, repo, deadline):
        return self.run_recipe(repo, {"host": "mac5", "command": ["true"], "need": "sims"}, deadline)

    def run_recipe(self, repo, recipe, deadline):
        if deadline < time.time():
            # Admission has time; the already launched job then exceeds its request deadline.
            real_start = vs._start_and_wait
            with patch.object(vs, "_start_and_wait", side_effect=lambda cmd, tail, name, end:
                              real_start(cmd, tail, name, deadline)):
                return vs.run_job(repo, recipe, "verify-x", time.time() + 61)
        return vs.run_job(repo, recipe, "verify-x", deadline)

    def test_a_job_past_its_deadline_keeps_running_and_the_retry_takes_its_result(self):
        with self.assertRaises(vs.Unjudged) as e:
            self.run_sim(self.repo, time.time() - 1)
        self.assertIn("keeps running", str(e.exception))
        self.assertEqual(self.count("stop"), 0)
        self.assertFalse(vs.host_lock("mac5").acquire(blocking=False), "the late job keeps its host")
        self.set_state("done")
        res = self.run_sim(self.repo, time.time() + 60)
        self.assertEqual((res["job"], res["executed"]), ("job-v-1", 3))
        self.assertEqual(self.count("run"), 1, "the retry started no second job")
        self.assertTrue(vs.host_lock("mac5").acquire(blocking=False), "freed once the job ended")
        vs.host_lock("mac5").release()
        self.assertEqual(vs.LATE, {})

    def test_a_retry_before_it_ends_is_unjudged_again_and_the_job_goes_on(self):
        with self.assertRaises(vs.Unjudged):
            self.run_sim(self.repo, time.time() - 1)
        with self.assertRaises(vs.Unjudged) as e:
            self.run_sim(self.repo, time.time() + 30.2)
        self.assertIn("still running", str(e.exception))
        self.assertEqual((self.count("run"), self.count("stop")), (1, 0))
        self.set_state("done")
        self.assertEqual(self.run_sim(self.repo, time.time() + 60)["job"], "job-v-1")
        self.assertEqual(self.count("run"), 1)

    def test_a_job_that_ends_stopped_or_lost_is_unjudged_for_the_retry(self):
        with self.assertRaises(vs.Unjudged):
            self.run_sim(self.repo, time.time() - 1)
        self.set_state("lost")
        with self.assertRaises(vs.Unjudged) as e:
            self.run_sim(self.repo, time.time() + 60)
        self.assertIn("lost", str(e.exception))
        self.assertTrue(vs.host_lock("mac5").acquire(blocking=False))
        vs.host_lock("mac5").release()

    def test_a_late_job_is_stopped_after_its_extra_time(self):
        vs.LATE_MORE_S = 0
        with self.assertRaises(vs.Unjudged):
            self.run_sim(self.repo, time.time() - 1)
        with self.assertRaises(vs.Unjudged) as e:
            self.run_sim(self.repo, time.time() + 60)
        self.assertIn("stopped", str(e.exception))
        self.assertEqual(self.count("stop"), 1)
        self.assertTrue(vs.host_lock("mac5").acquire(blocking=False))
        vs.host_lock("mac5").release()

    def test_without_a_readable_tree_the_job_is_stopped_as_before(self):
        with self.assertRaises(vs.Unjudged) as e:
            self.run_sim(self.tmp, time.time() - 1)
        self.assertIn("stopped", str(e.exception))
        self.assertEqual(self.count("stop"), 1)
        self.assertTrue(vs.host_lock("mac5").acquire(blocking=False))
        vs.host_lock("mac5").release()

    def ssh_stub(self):
        self.ssh_calls = os.path.join(self.tmp, "ssh")
        stub = os.path.join(self.tmp, "ssh-stub")
        with open(stub, "w") as f:
            f.write('#!/bin/sh\necho "$*" >> %s\n' % self.ssh_calls)
        os.chmod(stub, 0o755)
        saved = vs.SSH
        vs.SSH = stub
        self.addCleanup(setattr, vs, "SSH", saved)

    SIM = "11111111-1111-1111-1111-111111111111"

    def run_on_sim(self, repo, deadline):
        recipe = {"command": ["xcodebuild", "test", "-destination", f"platform=iOS Simulator,id={self.SIM}"],
                  "need": "sims", "host": "mac5"}
        return self.run_recipe(repo, recipe, deadline)

    def test_the_simulator_is_read_from_the_destination(self):
        self.assertEqual(vs.sim_of({"command": ["xcodebuild", "-destination", f"platform=iOS Simulator,id={self.SIM}"]}),
                         self.SIM)
        self.assertIsNone(vs.sim_of({"command": ["xcodebuild", "-destination", "generic/platform=iOS Simulator"]}))
        self.assertIsNone(vs.sim_of({"command": ["true"]}))

    def test_a_stopped_late_job_ends_the_app_it_left_on_its_simulator(self):
        """11-14 19:16: a stopped check left MotionMixApp running on C1AB6BF6, and the next check there hung."""
        self.ssh_stub()
        vs.LATE_MORE_S = 0
        with self.assertRaises(vs.Unjudged):
            self.run_on_sim(self.repo, time.time() - 1)
        with self.assertRaises(vs.Unjudged):
            self.run_on_sim(self.repo, time.time() + 60)
        self.assertEqual(self.count("stop"), 1)
        line = open(self.ssh_calls).read().strip()
        self.assertIn("mac5", line.split())
        self.assertIn(f"pkill -f '[C]oreSimulator/Devices/{self.SIM}/data/Containers/Bundle/Application/'", line)

    def test_a_stop_without_a_simulator_confirms_the_job_but_kills_no_app(self):
        self.ssh_stub()
        with self.assertRaises(vs.Unjudged):
            self.run_sim(self.tmp, time.time() - 1)   # no readable tree: stopped at once, recipe has no simulator
        self.assertEqual(self.count("stop"), 1)
        self.assertIn("tmux has-session", open(self.ssh_calls).read())
        self.assertNotIn("pkill", open(self.ssh_calls).read())

    def test_an_unreadable_tree_on_a_simulator_still_clears_it(self):
        self.ssh_stub()
        with self.assertRaises(vs.Unjudged):
            self.run_on_sim(self.tmp, time.time() - 1)
        self.assertIn(self.SIM, open(self.ssh_calls).read())

    def test_the_same_check_is_name_tree_and_recipe(self):
        one = vs.job_fingerprint(self.repo, {"command": ["true"]}, "verify-x")
        self.assertEqual(one, vs.job_fingerprint(self.repo, {"command": ["true"]}, "verify-x"))
        self.assertNotEqual(one, vs.job_fingerprint(self.repo, {"command": ["true"]}, "verify-x-main"))
        self.assertNotEqual(one, vs.job_fingerprint(self.repo, {"command": ["false"]}, "verify-x"))
        commit(self.repo, {"b.txt": "b\n"}, "two")
        self.assertNotEqual(one, vs.job_fingerprint(self.repo, {"command": ["true"]}, "verify-x"))
        self.assertIsNone(vs.job_fingerprint(self.tmp, {"command": ["true"]}, "verify-x"))


class HostPlacements(unittest.TestCase):
    """No real fabric or ssh call is possible in these scheduler/timeout regressions."""
    A = "11111111-1111-1111-1111-111111111111"
    B = "22222222-2222-2222-2222-222222222222"

    def setUp(self):
        self.recipe = {"need": "sims", "placements": [
            {"host": "mac5", "simulator": self.A, "derived_data": "/Volumes/FoundryBuild/fleet-dd/a"},
            {"host": "mac4", "simulator": self.B, "derived_data": "/Users/test/.fleet/dd/b"}],
            "command": ["xcodebuild", "test", "-destination", "platform=iOS Simulator,id={simulator}",
                        "-derivedDataPath", "{derived_data}"]}
        for name, val in (("_HOST_LOCKS", {}), ("_QUARANTINE", {}), ("LATE", {})):
            p = patch.object(vs, name, val)
            p.start()
            self.addCleanup(p.stop)
        self.fingerprint = patch.object(vs, "job_fingerprint", return_value="logical-key").start()
        self.addCleanup(patch.stopall)
        patch.object(vs, "log").start()
        self.reconcile = patch.object(vs, "start_reconcile").start()
        self.process = patch.object(vs.subprocess, "run", return_value=subprocess.CompletedProcess([], 0,
            "\t Executed 3 tests, with 0 failures (0 unexpected) in 1 (1) seconds\n** TEST SUCCEEDED **\n", "")).start()

    def check_recipe(self, recipe=None, name="verify-x", deadline=None):
        return vs.run_job("/unused", recipe or self.recipe, name, deadline or time.time() + 300)

    def finished(self, cmd, tail, name, deadline):
        host = cmd[cmd.index("--host") + 1]
        self.assertTrue(vs.host_lock(host).locked())
        self.assertNotIn("--force", cmd)
        return "job-" + name, ["job-" + name, host, "done", "0"]

    def test_materializes_each_placement_without_mutating_the_recipe(self):
        before = json.dumps(self.recipe)
        a, b = vs.placements_of(self.recipe)
        self.assertEqual((vs.sim_of(a), vs.sim_of(b)), (self.A, self.B))
        self.assertEqual(b["command"][-1], "/Users/test/.fleet/dd/b")
        self.assertEqual(json.dumps(self.recipe), before)

    def test_shell_commands_substitute_only_explicit_tokens(self):
        self.recipe["command"] = ["bash", "-c", "echo $PATH; xcodebuild -destination 'id={simulator}' -derivedDataPath {derived_data}"]
        cmd = vs.placements_of(self.recipe)[1]["command"][-1]
        self.assertIn("$PATH", cmd)
        self.assertIn("id=" + self.B, cmd)
        self.assertIn("/Users/test/.fleet/dd/b", cmd)

    def test_generic_build_needs_no_device(self):
        self.recipe["command"][3] = "generic/platform=iOS Simulator"
        for p in self.recipe["placements"]:
            p["simulator"] = None
        self.assertIsNone(vs.sim_of(vs.placements_of(self.recipe)[0]))

    def test_legacy_recipe_keeps_its_command(self):
        recipe = {"host": "mac4", "command": ["true"]}
        self.assertEqual(vs.placements_of(recipe), [recipe])

    def test_auto_simulator_recipe_reserves_a_concrete_host(self):
        choices = vs.placements_of({"command": ["true"]})
        self.assertEqual([p["host"] for p in choices], ["mac5", "mac4"])

    def test_invalid_placements_fail_before_any_submission(self):
        invalid = [[], {}, [None], [{"host": "mac4"}]]
        for field, value in (("host", "MAC4"), ("host", "mac1"), ("host", "auto"),
                             ("simulator", "not-a-uuid"), ("simulator", None),
                             ("derived_data", "relative"), ("derived_data", "/tmp/$(touch-bad)"),
                             ("derived_data", "/tmp/a b"), ("derived_data", "/tmp/../bad")):
            invalid.append([{**self.recipe["placements"][0], field: value}])
        invalid.append([self.recipe["placements"][0]] * 2)
        invalid.append([{**self.recipe["placements"][0], "command": ["true"]}])
        for placements in invalid:
            with self.subTest(placements=placements), self.assertRaises(vs.Unjudged):
                self.check_recipe({**self.recipe, "placements": placements})
        self.process.assert_not_called()

    def test_invalid_commands_and_unused_placement_tokens_are_rejected(self):
        for command in (None, [], [3], ["true"], ["echo", "id=" + self.A, "{derived_data}"]):
            with self.subTest(command=command), self.assertRaises(vs.Unjudged):
                vs.placements_of({**self.recipe, "command": command})
        with self.assertRaises(vs.Unjudged):
            vs.placements_of({"command": ["echo", "{derived_data}"]})
        with self.assertRaises(vs.Unjudged):
            vs.placements_of({**self.recipe, "need": "heavy_jobs"})

    def test_checks_inherit_placements_but_an_explicit_host_opts_out(self):
        recipe = {**self.recipe, "checks": [{"name": "a", "command": self.recipe["command"]},
            {"name": "b", "host": "mac5", "need": "heavy_jobs", "command": ["true"]}]}
        a, b = vs.checks_of(recipe)
        self.assertEqual(a["placements"], self.recipe["placements"])
        self.assertNotIn("placements", b)

    def test_a_busy_reservation_is_skipped(self):
        with vs.host_lock("mac5"), patch.object(vs, "_start_and_wait", side_effect=self.finished) as start:
            self.assertEqual(self.check_recipe()["host"], "mac4")
        self.assertEqual(start.call_count, 1)
        self.assertFalse(vs.host_lock("mac4").locked())

    def test_two_hosts_execute_at_the_same_time(self):
        entered, finish = threading.Event(), threading.Event()
        errors, results = [], []

        def start(cmd, tail, name, deadline):
            result = self.finished(cmd, tail, name, deadline)
            if result[1][1] == "mac5":
                entered.set()
                if not finish.wait(3):
                    raise AssertionError("second host did not run concurrently")
            return result

        def first():
            try:
                results.append(self.check_recipe(name="first"))
            except Exception as e:
                errors.append(e)

        with patch.object(vs, "_start_and_wait", side_effect=start):
            thread = threading.Thread(target=first)
            thread.start()
            try:
                self.assertTrue(entered.wait(2))
                self.assertEqual(self.check_recipe(name="second")["host"], "mac4")
                self.assertTrue(vs.host_lock("mac5").locked())
            finally:
                finish.set()
                thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(results[0]["host"], "mac5")

    def test_refusals_try_the_other_host_without_waiting_or_forcing(self):
        for reason in ("busy: file:.fleet/performing", "load: 20/core", "memory: 8%", "disk: 14 GB < 15 GB", "offline"):
            with self.subTest(reason=reason):
                def start(cmd, tail, name, deadline):
                    if cmd[cmd.index("--host") + 1] == "mac5":
                        raise vs.WorkerRefused(reason, "disk:" not in reason)
                    self.assertFalse(vs.host_lock("mac5").locked())
                    return self.finished(cmd, tail, name, deadline)
                with patch.object(vs, "_start_and_wait", side_effect=start), patch.object(vs.time, "sleep") as sleep:
                    self.assertEqual(self.check_recipe()["host"], "mac4")
                sleep.assert_not_called()

    def test_all_disk_refusals_are_unjudged_without_retry(self):
        with patch.object(vs, "_start_and_wait", side_effect=vs.WorkerRefused("disk: 14 GB < 15 GB")) as start:
            with self.assertRaisesRegex(vs.Unjudged, "no placement"):
                self.check_recipe()
        self.assertEqual(start.call_count, 2)
        self.assertFalse(any(vs.host_lock(h).locked() for h in vs.SIM_HOSTS))

    def test_all_locked_hosts_respect_the_deadline(self):
        with vs.host_lock("mac5"), vs.host_lock("mac4"), patch.object(vs, "_start_and_wait") as start:
            with self.assertRaisesRegex(vs.Unjudged, "deadline"):
                self.check_recipe(deadline=time.time() + 60.02)
        start.assert_not_called()

    def test_success_fingerprints_the_logical_recipe_and_releases_its_host(self):
        with patch.object(vs, "_start_and_wait", side_effect=self.finished):
            self.check_recipe()
        self.fingerprint.assert_called_once_with("/unused", self.recipe, "verify-x", None)
        self.assertFalse(vs.host_lock("mac5").locked())

    def test_timeout_without_receipt_quarantines_host_and_check(self):
        self.process.side_effect = subprocess.TimeoutExpired(["fabric"], 1)
        with self.assertRaisesRegex(vs.Unjudged, "timed out"):
            self.check_recipe()
        self.assertTrue(vs.host_lock("mac5").locked())
        self.assertFalse(vs.host_lock("mac4").locked())
        with self.assertRaisesRegex(vs.Unjudged, "reconciliation"):
            self.check_recipe()
        self.assertEqual(self.process.call_count, 1, "unknown launch must not be duplicated on Mac4")
        self.assertEqual(vs.quarantined()[0]["host"], "mac5")
        args = self.reconcile.call_args.args
        self.assertEqual(args[:5], ("logical-key", "mac5", "verify-x", vs.host_lock("mac5"), self.A))

    def test_a_receipt_for_another_host_is_quarantined_and_never_reconciled_by_name(self):
        self.process.return_value = subprocess.CompletedProcess([], 0, "started job-verify-x-1115-090000 on mac4\n", "")
        with self.assertRaisesRegex(vs.Unjudged, "expected mac5"):
            self.check_recipe()
        self.reconcile.assert_not_called()
        self.assertTrue(vs.host_lock("mac5").locked())

    def test_a_pinned_host_runs_there_only_and_keys_its_fingerprint(self):
        with patch.object(vs, "_start_and_wait", side_effect=self.finished) as start:
            self.assertEqual(vs.run_job("/unused", self.recipe, "verify-x-main", time.time() + 300, host="mac4")["host"],
                             "mac4")
        self.assertEqual([c.args[0][c.args[0].index("--host") + 1] for c in start.call_args_list], ["mac4"])
        self.fingerprint.assert_called_once_with("/unused", self.recipe, "verify-x-main", "mac4")

    def test_a_pinned_host_that_is_held_waits_and_never_moves_to_the_other(self):
        with vs.host_lock("mac4"), patch.object(vs, "PLACEMENT_RETRY_S", 0.01), \
                patch.object(vs, "_start_and_wait") as start:
            with self.assertRaisesRegex(vs.Unjudged, "deadline"):
                vs.run_job("/unused", self.recipe, "verify-x-main", time.time() + 60.05, host="mac4")
        start.assert_not_called()

    def test_a_pinned_host_the_recipe_does_not_place_is_unjudged(self):
        with self.assertRaisesRegex(vs.Unjudged, "no placement on k11"):
            vs.run_job("/unused", self.recipe, "verify-x-main", time.time() + 300, host="k11")

    # ---- an unknown launch, reconciled ----

    def ledger_and_tmux(self, ledger="", tmux="", ssh_rc=0, kill_rc=0):
        calls = []

        def run(argv, **kw):
            calls.append(argv)
            if argv[:3] == [vs.FABRIC, "job", "ls"]:
                return subprocess.CompletedProcess(argv, 0, ledger, "")
            if argv[0] == vs.SSH and "tmux ls" in argv[-1]:
                return subprocess.CompletedProcess(argv, ssh_rc, tmux, "")
            if argv[0] == vs.SSH:
                return subprocess.CompletedProcess(argv, kill_rc, "", "")
            raise AssertionError(argv)
        self.process.side_effect = run
        return calls

    def held(self, host="mac5"):
        lock = vs.host_lock(host)
        lock.acquire()
        key = vs.quarantine("logical-key", host, "timed out", lock)
        return key, lock

    def test_nothing_started_releases_the_host_and_the_check(self):
        key, lock = self.held()
        self.ledger_and_tmux(ledger="job-verify-x-1114-100000 mac5 done 0 2026-11-14T15:00:00Z cmd\n")
        self.assertEqual(vs.reconcile_once(key, "mac5", "verify-x", lock, self.A, time.time() - 60), "released")
        self.assertFalse(lock.locked())
        self.assertEqual(vs.quarantined(), [])

    def test_a_job_the_ledger_shows_is_adopted_for_the_retry(self):
        key, lock = self.held()
        t0 = time.time() - 60
        at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t0 + 20))
        self.ledger_and_tmux(ledger=f"job-verify-x-1115-090000 mac5 running {at} cmd\n")
        with patch.object(vs, "watch_late") as watch:
            self.assertEqual(vs.reconcile_once(key, "mac5", "verify-x", lock, self.A, t0), "adopted")
        late = vs.LATE[key]
        self.assertEqual((late.jid, late.host, late.sim, late.lock), ("job-verify-x-1115-090000", "mac5", self.A, lock))
        self.assertTrue(lock.locked(), "the watcher, not the reconciler, releases an adopted job's host")
        self.assertEqual(vs.quarantined(), [])
        watch.assert_called_once()

    def test_a_job_on_the_other_host_or_from_before_is_not_this_launch(self):
        key, lock = self.held()
        t0 = time.time() - 60
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t0 + 20))
        old = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t0 - 600))
        self.ledger_and_tmux(ledger=f"job-verify-x-1115-090000 mac4 running {now} cmd\n"
                                    f"job-verify-x-1115-080000 mac5 done 0 {old} cmd\n"
                                    f"job-verify-x-main-1115-090001 mac5 running {now} cmd\n")
        self.assertEqual(vs.reconcile_once(key, "mac5", "verify-x", lock, self.A, t0), "released")
        self.assertNotIn(key, vs.LATE)

    def test_a_session_fabric_never_recorded_is_ended_and_its_app_cleared(self):
        key, lock = self.held()
        calls = self.ledger_and_tmux(tmux="job-verify-x-1115-090000\nlane-dm\n")
        self.assertEqual(vs.reconcile_once(key, "mac5", "verify-x", lock, self.A, time.time() - 60), "released")
        kill = calls[-1][-1]
        self.assertIn("tmux kill-session -t 'job-verify-x-1115-090000'", kill)
        self.assertIn(f"[C]oreSimulator/Devices/{self.A}/", kill)
        self.assertNotIn("lane-dm", kill)
        self.assertFalse(lock.locked())

    def test_an_unreadable_host_keeps_the_quarantine(self):
        for kw in ({"ssh_rc": 255}, {"tmux": "job-verify-x-1115-090000\n", "kill_rc": 1}):
            with self.subTest(**kw):
                vs._QUARANTINE.clear()
                vs._HOST_LOCKS.clear()
                key, lock = self.held()
                self.ledger_and_tmux(**kw)
                self.assertIsNone(vs.reconcile_once(key, "mac5", "verify-x", lock, self.A, time.time() - 60))
                self.assertTrue(lock.locked())
                self.assertEqual(vs.quarantined()[0]["host"], "mac5")

    def test_the_reconciler_retries_until_it_can_tell_then_stops(self):
        key, lock = self.held()
        answers = iter([None, RuntimeError("ssh"), "released"])

        def once(*a):
            v = next(answers)
            if isinstance(v, Exception):
                raise v
            return v
        with patch.object(vs, "reconcile_once", side_effect=once) as rec, patch.object(vs, "RECONCILE_SETTLE_S", 0), \
                patch.object(vs, "RECONCILE_EVERY_S", 0):
            vs.reconcile_unknown(key, "mac5", "verify-x", lock, self.A, time.time())
        self.assertEqual(rec.call_count, 3)

    def test_a_slow_ledger_read_never_quarantines_a_late_job(self):
        lock = vs.host_lock("mac5")
        lock.acquire()
        late = vs.Late("job-late", lock, "mac5", self.A)
        reads = iter([subprocess.TimeoutExpired(["fabric"], 45), vs.Unjudged("fabric job ls failed"),
                      ["job-late", "mac5", "done", "0"]])

        def row(jid):
            v = next(reads)
            if isinstance(v, Exception):
                raise v
            return v
        with patch.object(vs, "job_row", side_effect=row), patch.object(vs.time, "sleep"):
            vs.watch_late("logical-key", late)
        self.assertEqual((late.row, late.error), (["job-late", "mac5", "done", "0"], None))
        self.assertFalse(lock.locked())
        self.assertEqual(vs.quarantined(), [])

    def test_a_ledger_that_stays_unreadable_ends_in_a_stop_not_a_quarantine(self):
        lock = vs.host_lock("mac5")
        lock.acquire()
        late = vs.Late("job-late", lock, "mac5", self.A)
        late.t -= vs.LATE_MORE_S - 15
        with patch.object(vs, "job_row", side_effect=subprocess.TimeoutExpired(["fabric"], 45)), \
                patch.object(vs.time, "sleep", side_effect=lambda s: setattr(late, "t", late.t - 10)), \
                patch.object(vs, "stop_job", return_value=None) as stop:
            vs.watch_late("logical-key", late)
        stop.assert_called_once_with("job-late", self.A, "mac5")
        self.assertIn("stopped", late.error)
        self.assertFalse(lock.locked())
        self.assertEqual(vs.quarantined(), [])

    def test_a_slow_ledger_read_while_waiting_keeps_waiting(self):
        reads = iter([subprocess.TimeoutExpired(["fabric"], 45), ["job-x", "mac5", "done", "0"]])

        def row(jid):
            v = next(reads)
            if isinstance(v, Exception):
                raise v
            return v
        self.process.return_value = subprocess.CompletedProcess([], 0, "started job-x on mac5\n", "")
        with patch.object(vs, "job_row", side_effect=row), patch.object(vs.time, "sleep"):
            self.assertEqual(vs._start_and_wait(["fabric", "job", "run", "--host", "mac5"], ["--", "x"], "verify-x",
                                                time.time() + 300), ("job-x", ["job-x", "mac5", "done", "0"]))

    def test_fabric_job_names_match_fabrics_own(self):
        self.assertEqual(vs.fabric_job_name("verify-serenity-soother-studio-ios-unit-tests-main"),
                         "verify-serenity-soother-studio")

    def test_timeout_with_a_bytes_receipt_adopts_the_known_job(self):
        self.process.side_effect = subprocess.TimeoutExpired(["fabric"], 1, output=b"started job-late on mac5\n")
        with patch.object(vs, "adopt", return_value=True) as adopt:
            with self.assertRaisesRegex(vs.Unjudged, "keeps running"):
                self.check_recipe()
        adopt.assert_called_once_with("logical-key", "job-late", vs.host_lock("mac5"), "mac5", self.A)
        self.assertTrue(vs.host_lock("mac5").locked())

    def test_unknown_submission_does_not_block_other_checks_on_the_other_host(self):
        self.process.side_effect = subprocess.TimeoutExpired(["fabric"], 1)
        with self.assertRaises(vs.Unjudged):
            self.check_recipe()
        self.process.side_effect = None
        self.fingerprint.return_value = "another-check"
        with patch.object(vs, "_start_and_wait", side_effect=self.finished):
            self.assertEqual(self.check_recipe(name="other")["host"], "mac4")

    def test_adoption_retains_selected_host_and_simulator(self):
        with vs.host_lock("mac5"), patch.object(vs, "_start_and_wait", side_effect=vs.PastDeadline("job-late")), \
                patch.object(vs, "adopt", return_value=True) as adopt:
            with self.assertRaises(vs.Unjudged):
                self.check_recipe()
        adopt.assert_called_once_with("logical-key", "job-late", vs.host_lock("mac4"), "mac4", self.B)
        self.assertTrue(vs.host_lock("mac4").locked())

    def test_claiming_a_late_job_does_not_reserve_or_submit_another_host(self):
        with patch.object(vs, "claim_late", return_value=("job-old", ["job-old", "mac4", "done", "0"])), \
                patch.object(vs, "_start_and_wait") as start:
            self.assertEqual(self.check_recipe()["host"], "mac4")
        start.assert_not_called()
        self.assertEqual(vs._HOST_LOCKS, {})

    def test_without_a_fingerprint_stop_uses_the_selected_host(self):
        self.fingerprint.return_value = None
        with vs.host_lock("mac5"), patch.object(vs, "_start_and_wait", side_effect=vs.PastDeadline("job-old")), \
                patch.object(vs, "stop_job", return_value=None) as stop:
            with self.assertRaisesRegex(vs.Unjudged, "stopped"):
                self.check_recipe()
        stop.assert_called_once_with("job-old", self.B, "mac4", None)
        self.assertFalse(vs.host_lock("mac4").locked())

    def test_failed_stop_retains_the_reservation(self):
        self.fingerprint.return_value = None
        with patch.object(vs, "_start_and_wait", side_effect=vs.PastDeadline("job-old")), \
                patch.object(vs, "stop_job", side_effect=vs.Unjudged("ssh failed")):
            with self.assertRaisesRegex(vs.Unjudged, "quarantined"):
                self.check_recipe()
        self.assertTrue(vs.host_lock("mac5").locked())

    def late(self):
        lock = vs.host_lock("mac4")
        lock.acquire()
        late = vs.Late("job-late", lock, "mac4", self.B)
        return late

    def test_late_completion_releases_only_its_host(self):
        late = self.late()
        with vs.host_lock("mac5"), patch.object(vs.time, "sleep"), \
                patch.object(vs, "job_row", return_value=["job-late", "mac4", "done", "0"]):
            vs.watch_late("logical-key", late)
            self.assertTrue(vs.host_lock("mac5").locked())
        self.assertFalse(vs.host_lock("mac4").locked())
        self.assertTrue(late.done.is_set())

    def test_late_cap_stops_recorded_host_when_ledger_row_is_missing(self):
        late = self.late()
        late.t -= vs.LATE_MORE_S + 1
        with patch.object(vs, "stop_job", return_value=None) as stop, patch.object(vs, "job_row", return_value=None):
            vs.watch_late("logical-key", late)
        stop.assert_called_once_with("job-late", self.B, "mac4")
        self.assertFalse(vs.host_lock("mac4").locked())

    def test_late_cleanup_failure_quarantines_without_releasing(self):
        late = self.late()
        late.t -= vs.LATE_MORE_S + 1
        with patch.object(vs, "stop_job", side_effect=vs.Unjudged("cleanup failed")):
            vs.watch_late("logical-key", late)
        self.assertTrue(vs.host_lock("mac4").locked())
        self.assertTrue(late.done.is_set())
        self.assertIn("cleanup failed", late.error)

    def test_stopped_or_lost_late_jobs_clear_their_simulator_before_release(self):
        for state in ("lost", "stopped"):
            late = self.late()
            with patch.object(vs.time, "sleep"), patch.object(vs, "job_row", return_value=["job-late", "mac4", state]), \
                    patch.object(vs, "stop_job", return_value=None) as stop:
                vs.watch_late("logical-key", late)
            stop.assert_called_once_with("job-late", self.B, "mac4", state)
            self.assertFalse(vs.host_lock("mac4").locked())

    def test_stop_cleanup_uses_captured_host_even_without_a_ledger_row(self):
        with patch.object(vs, "job_row", side_effect=AssertionError("should not need the ledger")):
            vs.stop_job("job-old", self.B, "mac4", "running")
        ssh = self.process.call_args_list[-1].args[0]
        self.assertIn("mac4", ssh)
        self.assertNotIn("mac5", ssh)
        self.assertIn(self.B, ssh[-1])

    def test_cleanup_ssh_failure_is_unjudged(self):
        self.process.side_effect = [subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 255)]
        with self.assertRaisesRegex(vs.Unjudged, "not confirmed"):
            vs.stop_job("job-old", self.B, "mac4", "running")

    def test_cleanup_ssh_timeout_is_unjudged(self):
        self.process.side_effect = [subprocess.CompletedProcess([], 0), subprocess.TimeoutExpired(["ssh"], 45)]
        with self.assertRaisesRegex(vs.Unjudged, "cleanup timed out"):
            vs.stop_job("job-old", self.B, "mac4", "running")

    def test_cleanup_pattern_cannot_kill_its_own_remote_shell(self):
        import re
        vs.stop_job("job-old", self.B, "mac4", "running")
        command = self.process.call_args_list[-1].args[0][-1]
        pattern = re.search(r"pkill -f '([^']+)'", command).group(1)
        self.assertIsNone(re.search(pattern, command))
        self.assertIsNotNone(re.search(pattern, f"CoreSimulator/Devices/{self.B}/data/Containers/Bundle/Application/App"))
        self.assertIn("pgrep", command, "cleanup must confirm exit before releasing the lock")

    def test_watcher_start_failure_retains_ownership(self):
        lock = vs.host_lock("mac4")
        lock.acquire()
        with patch.object(vs.threading.Thread, "start", side_effect=RuntimeError("thread limit")):
            self.assertTrue(vs.adopt("logical-key", "job-late", lock, "mac4", self.B))
        self.assertTrue(lock.locked())
        self.assertIn("watcher", vs.LATE["logical-key"].error)
        self.assertTrue(vs.LATE["logical-key"].done.is_set())

    def test_job_row_requires_the_exact_job_id(self):
        self.process.return_value = subprocess.CompletedProcess([], 0, "job-a-long mac4 done 0\njob-a mac5 running\n", "")
        self.assertEqual(vs.job_row("job-a"), ["job-a", "mac5", "running"])

    def test_bad_links_cannot_leak_a_host_reservation(self):
        with self.assertRaises(TypeError):
            self.check_recipe({**self.recipe, "links": {"../pkg": {"unresolved": True}}})
        self.assertFalse(vs.host_lock("mac5").locked())

    def test_generic_stop_also_requires_remote_confirmation(self):
        self.process.side_effect = [subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 255)]
        with self.assertRaisesRegex(vs.Unjudged, "not confirmed"):
            vs.stop_job("job-old", None, "mac4", "running")

    # ---- 11-15 13:50: a finished job's stop timed out and Mac4 was held for every lane until a restart ----
    DONE = ["job-old", "mac4", "done", "0"]

    def called(self, mock):
        for _ in range(200):   # the settle loop starts on its own thread
            if mock.called:
                return mock
            time.sleep(0.005)
        return mock

    def reads(self, *answers):
        it = iter(answers)

        def row(jid):
            v = next(it)
            if isinstance(v, Exception):
                raise v
            return v
        return patch.object(vs, "job_row", side_effect=row)

    def test_a_stop_of_a_job_that_already_exited_is_a_no_op(self):
        for state in ("done", "failed"):
            self.process.reset_mock()
            with self.reads(["job-old", "mac4", state, "0"]):
                self.assertEqual(vs.stop_job("job-old", self.B, "mac4"), ["job-old", "mac4", state, "0"])
            self.process.assert_not_called()   # no fabric stop (it would mark the job stopped), no ssh
            self.assertIsNone(vs.stop_job("job-old", self.B, "mac4", state))
            self.process.assert_not_called()

    def test_a_stop_that_times_out_on_a_finished_job_is_read_back_not_held(self):
        self.process.side_effect = subprocess.TimeoutExpired(["fabric", "job", "stop"], 45)
        with self.reads(subprocess.TimeoutExpired(["fabric"], 45), self.DONE):
            self.assertEqual(vs.stop_job("job-old", self.B, "mac4"), self.DONE)
        self.assertEqual(self.process.call_count, 1)   # the stop; no cleanup ssh for a job that exited

    def test_an_unconfirmed_stop_asks_the_host_itself(self):
        self.process.side_effect = [subprocess.TimeoutExpired(["fabric", "job", "stop"], 45),
                                    subprocess.CompletedProcess([], 0)]
        with self.reads(None, subprocess.TimeoutExpired(["fabric"], 45)):
            self.assertIsNone(vs.stop_job("job-old", self.B, "mac4"))
        ssh = self.process.call_args_list[-1].args[0]
        self.assertIn("mac4", ssh)
        self.assertIn("tmux has-session -t 'job-old'", ssh[-1])

    def test_an_unconfirmed_stop_on_an_unreachable_host_is_StopUnconfirmed(self):
        self.process.side_effect = [subprocess.CompletedProcess([], 1), subprocess.TimeoutExpired(["ssh"], 45)]
        with self.reads(["job-old", "mac4", "running"], ["job-old", "mac4", "running"]):
            with self.assertRaises(vs.StopUnconfirmed):
                vs.stop_job("job-old", self.B, "mac4")

    def test_a_ledger_row_for_another_host_is_not_taken_as_settled(self):
        self.process.side_effect = [subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 0)]
        with self.reads(["job-old", "mac5", "done", "0"]):
            self.assertIsNone(vs.stop_job("job-old", self.B, "mac4"))
        self.assertEqual(self.process.call_count, 2)   # stopped and confirmed on mac4, the host it was placed on

    def test_a_late_job_that_exited_while_unobserved_keeps_its_result_at_the_cap(self):
        late = self.late()
        late.t -= vs.LATE_MORE_S + 1
        with self.reads(self.DONE):
            vs.watch_late("logical-key", late)
        self.assertEqual((late.row, late.error), (self.DONE, None))
        self.assertFalse(vs.host_lock("mac4").locked())
        self.assertEqual(vs.quarantined(), [])
        self.process.assert_not_called()

    def test_the_1350_incident_holds_the_host_only_until_the_job_is_read_back(self):
        """Ledger unreadable for the whole late window, the stop times out, the host cannot be reached: the host is
        held, then freed by the settle loop once the ledger shows the job done, and the retry takes its result."""
        late = self.late()
        late.t -= vs.LATE_MORE_S + 1
        slow = subprocess.TimeoutExpired(["fabric", "job", "ls"], 45)
        self.process.side_effect = [subprocess.TimeoutExpired(["fabric", "job", "stop"], 45),
                                    subprocess.TimeoutExpired(["ssh"], 45)]
        with self.reads(slow, slow), patch.object(vs, "settle_stop") as settle:
            vs.watch_late("logical-key", late)
            self.called(settle)   # inside the patch: the real loop must never start here
        self.assertTrue(vs.host_lock("mac4").locked())
        self.assertEqual(vs.quarantined()[0]["host"], "mac4")
        settle.assert_called_once_with("logical-key", "mac4", "job-late", late.lock, self.B, True)
        self.process.side_effect = None
        self.process.reset_mock()
        with self.reads(slow, ["job-late", "mac4", "done", "0"]), patch.object(vs.time, "sleep"):
            vs.settle_stop("logical-key", "mac4", "job-late", late.lock, self.B)
        self.process.assert_not_called()
        self.assertFalse(vs.host_lock("mac4").locked())
        self.assertEqual(vs.quarantined(), [])
        self.assertEqual(vs.claim_late("logical-key", time.time() + 300), ("job-late", ["job-late", "mac4", "done", "0"]))

    def test_settling_a_running_job_stops_it_and_confirms_on_the_host(self):
        key, lock = "logical-key", vs.host_lock("mac4")
        lock.acquire()
        vs.quarantine(key, "mac4", "stop not confirmed", lock)
        self.process.side_effect = [subprocess.CompletedProcess([], 255), subprocess.CompletedProcess([], 0),
                                    subprocess.CompletedProcess([], 0)]
        with self.reads(["job-late", "mac4", "running"], None, ["job-late", "mac4", "running"]), \
                patch.object(vs.time, "sleep"):
            vs.settle_stop(key, "mac4", "job-late", lock, self.B)
        self.assertFalse(lock.locked())
        self.assertEqual(vs.quarantined(), [])
        self.assertNotIn(key, vs.LATE)   # stopped by the verifier: no result for a retry
        self.assertIn("tmux has-session", self.process.call_args_list[-1].args[0][-1])

    def test_settling_never_frees_a_host_the_ledger_disagrees_with(self):
        key, lock = "logical-key", vs.host_lock("mac4")
        lock.acquire()
        vs.quarantine(key, "mac4", "stop not confirmed", lock)
        with self.reads(["job-late", "mac5", "done", "0"]), patch.object(vs.time, "sleep"):
            vs.settle_stop(key, "mac4", "job-late", lock, self.B)
        self.assertTrue(lock.locked())
        self.assertEqual(vs.quarantined()[0]["host"], "mac4")

    def test_settling_keeps_the_host_while_it_cannot_tell_and_gives_up_bounded(self):
        key, lock = "logical-key", vs.host_lock("mac4")
        lock.acquire()
        vs.quarantine(key, "mac4", "stop not confirmed", lock)
        clock = [time.time()]
        with patch.object(vs, "job_row", side_effect=subprocess.TimeoutExpired(["fabric"], 45)), \
                patch.object(vs.time, "sleep", side_effect=lambda s: clock.__setitem__(0, clock[0] + s)), \
                patch.object(vs.time, "time", side_effect=lambda: clock[0]):
            vs.settle_stop(key, "mac4", "job-late", lock, self.B)
        self.assertTrue(lock.locked())
        self.assertGreater(clock[0], time.time() + vs.STOP_SETTLE_MAX_S - 1)

    def test_a_failed_stop_after_the_deadline_is_settled_not_held_for_good(self):
        self.fingerprint.return_value = None
        with patch.object(vs, "_start_and_wait", side_effect=vs.PastDeadline("job-old")), \
                patch.object(vs, "stop_job", side_effect=vs.StopUnconfirmed("ssh timed out")), \
                patch.object(vs, "settle_stop") as settle:
            with self.assertRaisesRegex(vs.Unjudged, "read back"):
                self.check_recipe()
            self.called(settle)
        self.assertTrue(vs.host_lock("mac5").locked())
        settle.assert_called_once_with("unknown:mac5", "mac5", "job-old", vs.host_lock("mac5"), self.A,
                                                    False)

    def test_adding_placements_cannot_rewrite_the_recipe_judging_the_proposal(self):
        old = {"host": "mac5", "command": ["true"]}
        with patch.object(vs, "git", return_value=json.dumps(self.recipe)):
            self.assertEqual(vs.repointed("/unused", "head", old, [".foundry/verify.json"]), old)


if __name__ == "__main__":
    unittest.main()

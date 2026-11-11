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

        def run_job(repo, recipe, name, deadline):
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
        self.assertEqual(cached, [f"baseline-{sh(self.origin, 'git', 'rev-parse', 'main')[:12]}-sib{sib_sha[:12]}.json"])

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

        def run_job(repo, recipe, name, deadline):
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
        main = sh(self.origin, "git", "rev-parse", "main")[:12]
        self.assertEqual(sorted(self.baselines()), [f"baseline-tools-unittest-{main}.json", f"baseline-web-vitest-{main}.json"])

    def test_a_malformed_checks_list_is_unjudged(self):
        for bad in ([], [{"name": "a"}], [{"name": "a", "command": ["x"]}, {"name": "A!", "command": ["y"]}], "x"):
            with self.assertRaises(vs.Unjudged):
                vs.checks_of({"checks": bad})

    def test_base_without_a_recipe_checks_nothing(self):
        self.stub_jobs()
        self.assertEqual(vs.verify({"repo": "other-1--claude-x", "headSha": self.code_head}, self.cfg), {"runs": []})


class BusyWorker(unittest.TestCase):
    """A worker over its floors is waited on, then forced; any other start failure is unjudged."""

    def setUp(self):
        self.saved = (vs.FABRIC, vs.FORCE_AFTER_S, vs.ROOT, vs.time.sleep)
        self.tmp = tempfile.mkdtemp()
        vs.ROOT, vs.FORCE_AFTER_S = self.tmp, 0.005  # the first attempt runs inside it, the second past it
        vs.WAIT.forced, vs.WAIT.since = False, None   # an earlier test's verification is not this one's
        vs.time.sleep = lambda s: None
        self.calls = os.path.join(self.tmp, "calls")
        self.fabric = os.path.join(self.tmp, "fabric")

    def tearDown(self):
        vs.FABRIC, vs.FORCE_AFTER_S, vs.ROOT, vs.time.sleep = self.saved
        vs.WAIT.forced, vs.WAIT.since = False, None

    def runs(self):
        return ["--force" in l for l in open(self.calls).read().splitlines() if l.startswith("job run")]

    def fake_floor(self, refusal):
        """A worker that refuses every unforced start with `refusal`, and runs a forced one."""
        self.fake('case "$*" in *--force*) [ "$2" = run ] && { echo "started job-v-1 on mac5"; exit 0; } ;; esac\n'
                  '[ "$2" = run ] && { echo "%s" >&2; exit 1; }\n'
                  '[ "$2" = ls ] && echo "job-v-1 mac5 done 0 t cmd"\n'
                  '[ "$2" = log ] && printf "\\t Executed 3 tests, with 0 failures (0 unexpected) in 1 (1) seconds\\n** TEST SUCCEEDED **\\n"\n'
                  'exit 0' % refusal)

    def test_one_verification_waits_once_however_many_jobs_it_runs(self):
        vs.WAIT.forced = False
        self.fake_floor("mac5: load: 9/core (use --force to run anyway)")
        for _ in range(3):       # the check, then main for comparison, then a rerun
            vs.run_job(self.tmp, {"command": ["true"]}, "verify-x", time.time() + 600)
        self.assertEqual(self.runs(), [False, True, True, True])

    def test_a_disk_floor_is_forced_without_waiting(self):
        vs.WAIT.forced = False
        vs.FORCE_AFTER_S = 3600   # only the disk rule can force inside this test
        slept = []
        vs.time.sleep = slept.append
        self.fake_floor("mac5: disk: 14 GB < 15 GB (use --force to run anyway; memory is never skipped)")
        res = vs.run_job(self.tmp, {"command": ["true"]}, "verify-x", time.time() + 600)
        self.assertEqual((res["executed"], self.runs()), (3, [False, True]))
        self.assertNotIn(20, slept)

    def test_time_queued_behind_another_check_is_not_waited_again(self):
        vs.WAIT.forced, vs.FORCE_AFTER_S = False, 180
        vs.WAIT.since = time.time() - 200     # this request arrived 200 s ago and has only now got the lock
        self.fake_floor("mac5: load: 5.4/core (use --force to run anyway; memory is never skipped)")
        vs.run_job(self.tmp, {"command": ["true"]}, "verify-x", time.time() + 600)
        self.assertEqual(self.runs(), [True])

    def test_the_next_verification_waits_again(self):
        vs.WAIT.forced = True
        try:
            vs.verify({"repo": "unlisted-1--claude-x", "headSha": "0" * 40}, {"bases": {}})
        except vs.Unjudged:
            pass                 # no task file here: all that matters is that the wait started over
        self.assertFalse(vs.WAIT.forced)
        self.assertGreater(vs.WAIT.since, time.time() - 5)

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

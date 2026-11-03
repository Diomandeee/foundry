#!/usr/bin/env python3
"""Lane scan, landing preflight, generated-file regeneration and post-land reset, on throwaway git repos.

  python3 -m unittest tools/foundry-ops/test_foundry_ops.py
"""
import hashlib, json, os, pathlib, subprocess, sys, tempfile, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import foundry_ops as fo  # noqa: E402

BASE = "demo"
MAIN = f"refs/foundry/{BASE}/main"
# Writes gen.txt from the sorted names under src/, the way xcodegen derives a project from folders.
GENERATOR = "import os\nopen('gen.txt','w').write(''.join(n + '\\n' for n in sorted(os.listdir('src'))))\n"


def run(*args, cwd):
    p = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if p.returncode != 0:
        raise AssertionError(f"{args}: {p.stderr}")
    return p.stdout.strip()


class Repo:
    """A repo whose Foundry main is a local ref, plus helpers to commit, squash-land and add lane worktrees."""

    def __init__(self, root):
        self.root = root
        self.path = os.path.join(root, "repo")
        os.makedirs(self.path)
        run("git", "init", "-q", "-b", "trunk", cwd=self.path)
        run("git", "config", "user.email", "t@t", cwd=self.path)
        run("git", "config", "user.name", "t", cwd=self.path)

    def write(self, wt, rel, text):
        p = pathlib.Path(wt, rel)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)

    def commit(self, wt, files, msg="c"):
        for rel, text in files.items():
            self.write(wt, rel, text)
        run("git", "add", "-A", cwd=wt)
        run("git", "commit", "-q", "-m", msg, cwd=wt)
        return run("git", "rev-parse", "HEAD", cwd=wt)

    def set_main(self, sha):
        run("git", "update-ref", MAIN, sha, cwd=self.path)

    def lane(self, name, start=MAIN):
        wt = os.path.join(self.root, name)
        run("git", "worktree", "add", "-q", "-b", name, wt, start, cwd=self.path)
        return wt

    def squash_land(self, conf, source_commit, files, log=True):
        """What the gate does: the lane's files as one new commit on main, parent main only. `log=False` is a
        landing this host's land log never saw (made from another Mac)."""
        tmp = os.path.join(self.root, "squash")
        run("git", "worktree", "add", "-q", "--detach", tmp, MAIN, cwd=self.path)
        merged = self.commit(tmp, files, "Merge task")
        run("git", "worktree", "remove", "--force", tmp, cwd=self.path)
        self.set_main(merged)
        if log:
            with open(conf / "land-log.jsonl", "a") as f:
                f.write(json.dumps({"base": BASE, "verdict": "merge", "commits": [source_commit],
                                    "decision": {"merged_sha": merged}}) + "\n")
        return merged


class LaneTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conf = pathlib.Path(self.tmp.name, "conf")
        self.conf.mkdir()
        self._conf = fo.CONF
        fo.CONF = self.conf
        self.r = Repo(self.tmp.name)
        self.r.set_main(self.r.commit(self.r.path, {"app.txt": "a\n", "other.txt": "o\n", "src/a": "",
                                                    "gen.py": GENERATOR, "gen.txt": "a\n"}))

    def tearDown(self):
        fo.CONF = self._conf
        self.tmp.cleanup()

    def lane_by_branch(self, scan, branch):
        return next(l for l in scan["lanes"] if l["branch"] == branch)


class ScanTest(LaneTest):
    def test_squash_landed_lane_reads_landed_not_conflicting(self):
        wt = self.r.lane("landed")
        c = self.r.commit(wt, {"app.txt": "a\nlanded\n"})
        # Main moves on top of the landed change, touching the same file (the StudioMode-after-Tonehouse case).
        merged = self.r.squash_land(self.conf, c, {"app.txt": "a\nlanded\n"})
        tmp = self.r.lane("later", merged)
        self.r.set_main(self.r.commit(tmp, {"app.txt": "guard\na\nlanded\n"}))
        lane = self.lane_by_branch(fo.scan(self.r.path, BASE), "landed")
        self.assertEqual(lane["state"], "landed")
        self.assertEqual(lane["pending"], [])
        self.assertEqual(lane["landed_as"], merged)

    def test_new_work_after_a_landing_is_pending_from_the_merge(self):
        wt = self.r.lane("lane")
        c = self.r.commit(wt, {"app.txt": "a\nfirst\n"})
        self.r.squash_land(self.conf, c, {"app.txt": "a\nfirst\n"})
        self.r.commit(wt, {"other.txt": "o\nsecond\n"})
        lane = self.lane_by_branch(fo.scan(self.r.path, BASE), "lane")
        self.assertEqual(lane["pending"], ["other.txt"])
        self.assertEqual(lane["merge_conflicts"], [])
        self.assertTrue(lane["active"])

    def test_overlap_between_active_lanes_includes_uncommitted_edits(self):
        a = self.r.lane("a")
        self.r.commit(a, {"app.txt": "a\nfrom a\n"})
        b = self.r.lane("b")
        self.r.write(b, "app.txt", "a\nfrom b, not committed\n")
        s = fo.scan(self.r.path, BASE)
        self.assertEqual(len(s["overlaps"]), 1)
        self.assertEqual(s["overlaps"][0]["files"], ["app.txt"])
        self.assertEqual(self.lane_by_branch(s, "b")["dirty"], ["app.txt"])

    def test_hunk_conflict_with_main_is_reported(self):
        wt = self.r.lane("lane")
        self.r.commit(wt, {"app.txt": "lane\n"})
        tmp = self.r.lane("mover")
        self.r.set_main(self.r.commit(tmp, {"app.txt": "main\n"}))
        lane = self.lane_by_branch(fo.scan(self.r.path, BASE), "lane")
        self.assertEqual(lane["state"], "conflicts-with-main")
        self.assertEqual(lane["merge_conflicts"], ["app.txt"])

    def test_unrelated_history_is_named_not_compared(self):
        wt = os.path.join(self.tmp.name, "orphan")
        run("git", "worktree", "add", "-q", "--detach", wt, MAIN, cwd=self.r.path)
        run("git", "checkout", "-q", "--orphan", "orphan", cwd=wt)
        self.r.commit(wt, {"x": "x"})
        self.assertEqual(self.lane_by_branch(fo.scan(self.r.path, BASE), "orphan")["state"], "unrelated-history")

    def test_worktree_whose_branch_ref_is_gone_is_an_orphan_with_its_files(self):
        # MotionMix 2026-11-02: 29 worktrees with deleted branch refs held the only copy of 5,742 files.
        wt = self.r.lane("gone")
        self.r.commit(wt, {"committed.txt": "c\n"})
        self.r.write(wt, "staged.txt", "s\n")
        run("git", "add", "staged.txt", cwd=wt)
        self.r.write(wt, "loose.txt", "l\n")
        run("git", "update-ref", "-d", "refs/heads/gone", cwd=self.r.path)
        lane = self.lane_by_branch(fo.scan(self.r.path, BASE), "gone")
        self.assertEqual(lane["state"], "orphan")
        self.assertEqual(lane["pending"], ["committed.txt", "loose.txt", "staged.txt"])  # app.txt matches main
        self.assertFalse(lane["active"])
        self.assertNotIn(wt, [w["path"] for w in fo.worktrees(self.r.path)])  # land's view is unchanged

    def test_untracked_new_files_are_reported_but_never_pending(self):
        wt = self.r.lane("lane")
        c = self.r.commit(wt, {"app.txt": "a\nlanded\n"})
        self.r.squash_land(self.conf, c, {"app.txt": "a\nlanded\n"})
        self.r.write(wt, "New.swift", "never added\n")
        other = self.r.lane("other")
        self.r.commit(other, {"New.swift": "committed elsewhere\n"})
        s = fo.scan(self.r.path, BASE)
        lane = self.lane_by_branch(s, "lane")
        self.assertEqual(lane["state"], "untracked-only")
        self.assertEqual(lane["untracked"], ["New.swift"])
        self.assertEqual(lane["pending"], [])
        self.assertEqual(s["overlaps"], [])  # preflight and overlaps still see committed and edited files only

    def test_stripped_assets_are_not_untracked_work(self):
        # motionmixapp 2026-11-02: every landed lane read untracked-only over the same 38 binaries from assets.json.
        seeded = b"linked in by land\n"
        tmp = self.r.lane("recipe")
        self.r.set_main(self.r.commit(tmp, {
            ".foundry/generated.json": json.dumps({"format": "foundry.generated.v1", "files": ["gen.txt"],
                                                   "run": ["python3", "gen.py"], "assets": ".foundry/assets.json"}),
            ".foundry/assets.json": json.dumps({"format": "foundry.assets.v1", "stripped": [
                {"path": p, "bytes": len(seeded), "sha256": hashlib.sha256(seeded).hexdigest()}
                for p in ("Frameworks/lib.a", "Frameworks/Echelon.xcframework/Info.plist")]})}))
        wt = self.r.lane("lane")
        c = self.r.commit(wt, {"app.txt": "a\nlanded\n"})
        self.r.squash_land(self.conf, c, {"app.txt": "a\nlanded\n"})
        self.r.write(wt, "Frameworks/lib.a", "linked in by land\n")
        self.r.write(wt, "Frameworks/Echelon.xcframework/Info.plist", "linked in by land\n")
        lane = self.lane_by_branch(fo.scan(self.r.path, BASE), "lane")
        self.assertEqual((lane["state"], lane["untracked"]), ("landed", []))
        self.r.write(wt, "analysis/study.json", "real untracked work\n")
        lane = self.lane_by_branch(fo.scan(self.r.path, BASE), "lane")
        self.assertEqual((lane["state"], lane["untracked"]), ("untracked-only", ["analysis/study.json"]))
        self.r.write(wt, "Frameworks/lib.a", "rebuilt in the lane\n")  # a changed asset is work again
        lane = self.lane_by_branch(fo.scan(self.r.path, BASE), "lane")
        self.assertEqual(lane["untracked"], ["Frameworks/lib.a", "analysis/study.json"])
        run("git", "update-ref", "-d", "refs/heads/lane", cwd=self.r.path)
        self.assertEqual(self.lane_by_branch(fo.scan(self.r.path, BASE), "lane")["pending"],
                         ["Frameworks/lib.a", "analysis/study.json"])

    def test_landing_the_land_log_does_not_know_is_matched_by_patch_id(self):
        # participation/build-139: landed as 5271c2a from another host, so Mac1's land log had none of its shas.
        wt = self.r.lane("lane")
        self.r.commit(wt, {"app.txt": "a\nfix\n"})
        self.r.commit(wt, {"other.txt": "o\nbump\n"})
        mover = self.r.lane("mover")
        self.r.set_main(self.r.commit(mover, {"src/b": ""}))  # main moves first, so no main tree equals the lane's
        merged = self.r.squash_land(self.conf, None, {"app.txt": "a\nfix\n", "other.txt": "o\nbump\n"}, log=False)
        lane = self.lane_by_branch(fo.scan(self.r.path, BASE), "lane")
        self.assertEqual((lane["state"], lane["landed_as"], lane["landed_by"]), ("landed", merged, "content"))
        self.r.commit(wt, {"later.txt": "new work\n"})
        self.assertEqual(self.lane_by_branch(fo.scan(self.r.path, BASE), "lane")["pending"], ["later.txt"])

    def test_recommitted_lane_is_matched_by_content_not_sha(self):
        wt = self.r.lane("lane")
        old = self.r.commit(wt, {"app.txt": "a\nx\n"}, "first wording")
        merged = self.r.squash_land(self.conf, old, {"app.txt": "a\nx\n"})
        run("git", "commit", "-q", "--amend", "-m", "reworded after landing", cwd=wt)  # new sha, same change
        lane = self.lane_by_branch(fo.scan(self.r.path, BASE), "lane")
        self.assertEqual((lane["state"], lane["landed_as"]), ("landed", merged))

    def test_different_change_is_not_matched_by_content(self):
        wt = self.r.lane("lane")
        self.r.commit(wt, {"app.txt": "a\nmine\n"})
        self.r.squash_land(self.conf, None, {"app.txt": "a\nsomeone else's\n"}, log=False)
        lane = self.lane_by_branch(fo.scan(self.r.path, BASE), "lane")
        self.assertNotIn("landed_as", lane)
        self.assertEqual(lane["pending"], ["app.txt"])


class PreflightTest(LaneTest):
    def test_refuses_when_another_lane_edits_the_same_file_differently(self):
        mine = self.r.lane("mine")
        pick = self.r.commit(mine, {"app.txt": "a\nmine\n"})
        other = self.r.lane("other")
        self.r.commit(other, {"app.txt": "a\ntheirs\n"})
        with self.assertRaises(SystemExit) as e:
            fo.preflight(mine, BASE, [pick])
        self.assertIn("--ack-overlap", str(e.exception))
        contested = fo.preflight(mine, BASE, [pick], ack=True)
        self.assertEqual(contested[0]["files"], ["app.txt"])
        self.assertEqual(contested[0]["branch"], "other")

    def test_same_bytes_and_disjoint_files_pass(self):
        mine = self.r.lane("mine")
        pick = self.r.commit(mine, {"app.txt": "a\nshared\n"})
        same = self.r.lane("same")
        self.r.commit(same, {"app.txt": "a\nshared\n"})
        apart = self.r.lane("apart")
        self.r.commit(apart, {"other.txt": "o\napart\n"})
        self.assertEqual(fo.preflight(mine, BASE, [pick]), [])

    def test_generated_files_never_block(self):
        tmp = self.r.lane("recipe")
        self.r.set_main(self.r.commit(tmp, {".foundry/generated.json": json.dumps(
            {"format": "foundry.generated.v1", "files": ["gen.txt"], "run": ["python3", "gen.py"]})}))
        mine = self.r.lane("mine")
        pick = self.r.commit(mine, {"src/b": "", "gen.txt": "a\nb\n"})
        other = self.r.lane("other")
        self.r.commit(other, {"src/c": "", "gen.txt": "a\nc\n"})
        self.assertEqual(fo.preflight(mine, BASE, [pick]), [])

    def test_stale_lanes_do_not_block(self):
        mine = self.r.lane("mine")
        pick = self.r.commit(mine, {"app.txt": "a\nmine\n"})
        other = self.r.lane("other")
        self.r.commit(other, {"app.txt": "a\ntheirs\n"})
        self.assertEqual(fo.preflight(mine, BASE, [pick], active_days=-1), [])


class RegenerateTest(LaneTest):
    RECIPE = {"format": "foundry.generated.v1", "files": ["gen.txt"], "run": ["python3", "gen.py"]}

    def setUp(self):
        super().setUp()
        tmp = self.r.lane("recipe")
        self.r.set_main(self.r.commit(tmp, {".foundry/generated.json": json.dumps(self.RECIPE)}))

    def scratch(self):
        parent = tempfile.mkdtemp(dir=self.tmp.name, prefix="land-")
        wt = os.path.join(parent, "repo")
        run("git", "worktree", "add", "-q", "--detach", wt, MAIN, cwd=self.r.path)
        return wt

    def test_generated_only_conflict_is_resolved_by_regenerating(self):
        lane = self.r.lane("lane")
        pick = self.r.commit(lane, {"src/b": "", "gen.txt": "a\nb\n"})
        mover = self.r.lane("mover")
        self.r.set_main(self.r.commit(mover, {"src/c": "", "gen.txt": "a\nc\n"}))
        wt = self.scratch()
        ok, detail = fo.apply_picks(wt, [pick], fo.generated_spec(self.r.path, MAIN))
        self.assertTrue(ok, detail)
        self.assertEqual(detail["regenerate"], "verified")
        self.assertEqual(detail["regenerated_conflicts"], ["gen.txt"])
        self.assertEqual(run("git", "show", "HEAD:gen.txt", cwd=wt), "a\nb\nc")
        self.assertEqual(run("git", "show", "HEAD:src/b", cwd=wt), "")

    def test_clean_merge_with_stale_generated_file_is_refreshed(self):
        lane = self.r.lane("lane")
        pick = self.r.commit(lane, {"src/b": ""})  # forgot to regenerate
        ok, detail = fo.apply_picks(self.scratch(), [pick], fo.generated_spec(self.r.path, MAIN))
        self.assertTrue(ok)
        self.assertEqual(detail["regenerated_after"], ["gen.txt"])

    def test_untrusted_generator_falls_back_to_a_conflict(self):
        lane = self.r.lane("lane")
        pick = self.r.commit(lane, {"src/b": "", "gen.txt": "a\nb\n"})
        tmp = self.r.lane("bad")
        self.r.set_main(self.r.commit(tmp, {"gen.txt": "hand edited\n"}))  # no longer what the generator makes
        ok, detail = fo.apply_picks(self.scratch(), [pick], fo.generated_spec(self.r.path, MAIN))
        self.assertFalse(ok)
        self.assertIn("base not reproduced", detail["regenerate"])
        self.assertEqual(detail["conflicts"], ["gen.txt"])

    def test_real_source_conflict_is_never_regenerated_away(self):
        lane = self.r.lane("lane")
        pick = self.r.commit(lane, {"app.txt": "lane\n", "src/b": "", "gen.txt": "a\nb\n"})
        mover = self.r.lane("mover")
        self.r.set_main(self.r.commit(mover, {"app.txt": "main\n", "src/c": "", "gen.txt": "a\nc\n"}))
        ok, detail = fo.apply_picks(self.scratch(), [pick], fo.generated_spec(self.r.path, MAIN))
        self.assertFalse(ok)
        self.assertEqual(detail["conflicts"], ["app.txt", "gen.txt"])

    def test_links_must_be_siblings(self):
        bad = dict(self.RECIPE, links={"../../escape": self.tmp.name})
        with self.assertRaises(SystemExit):
            fo.regenerate(self.scratch(), bad)


class ResetTest(LaneTest):
    def test_landed_clean_lane_moves_onto_the_merge(self):
        wt = self.r.lane("lane")
        pick = self.r.commit(wt, {"app.txt": "a\nx\n"})
        merged = self.r.squash_land(self.conf, pick, {"app.txt": "a\nx\n"})
        self.r.write(wt, "untracked.bin", "kept")
        out = fo.post_land_reset(wt, [pick], merged, BASE)
        self.assertEqual(out["reset"], "done")
        self.assertEqual(run("git", "rev-parse", "HEAD", cwd=wt), merged)
        self.assertTrue(os.path.exists(os.path.join(wt, "untracked.bin")))

    def test_unlanded_commits_and_edits_are_never_dropped(self):
        wt = self.r.lane("lane")
        keep = self.r.commit(wt, {"other.txt": "o\nnot landed\n"})
        pick = self.r.commit(wt, {"app.txt": "a\nx\n"})
        merged = self.r.squash_land(self.conf, pick, {"app.txt": "a\nx\n"})
        out = fo.post_land_reset(wt, [pick], merged, BASE)
        self.assertEqual(out["reset"], "skipped")
        self.assertIn("did not land", out["why"])
        self.assertIn(keep, run("git", "rev-list", "HEAD", cwd=wt))

        wt2 = self.r.lane("dirty", merged)
        pick2 = self.r.commit(wt2, {"app.txt": "a\nx\ny\n"})
        merged2 = self.r.squash_land(self.conf, pick2, {"app.txt": "a\nx\ny\n"})
        self.r.write(wt2, "app.txt", "work in progress\n")
        self.assertEqual(fo.post_land_reset(wt2, [pick2], merged2, BASE)["why"], "tracked edits in the worktree")

    def test_head_moved_since_landing_is_left_alone(self):
        wt = self.r.lane("lane")
        pick = self.r.commit(wt, {"app.txt": "a\nx\n"})
        merged = self.r.squash_land(self.conf, pick, {"app.txt": "a\nx\n"})
        self.r.commit(wt, {"other.txt": "o\nnext\n"})
        self.assertEqual(fo.post_land_reset(wt, [pick], merged, BASE)["reset"], "skipped")



class WaitDecisionTest(unittest.TestCase):
    """An `error` row is the gate retrying (e.g. the verifier asked for one), not its verdict."""

    def setUp(self):
        self.sleep = fo.time.sleep
        fo.time.sleep = lambda s: None

    def tearDown(self):
        fo.time.sleep = self.sleep

    def cf(self, *rows):
        seq = iter(rows)

        class CF:
            def d1(self, sql, params):
                row = next(seq, rows[-1])
                return [row] if row else []
        return CF()

    def test_waits_past_error_rows_for_the_verdict(self):
        cf = self.cf(None, {"verdict": "error"}, {"verdict": "error"}, {"verdict": "merge", "merged_sha": "m"})
        self.assertEqual(fo.wait_decision(cf, "f", "s", 60)["verdict"], "merge")

    def test_returns_the_error_if_nothing_better_comes(self):
        clock = iter(range(0, 1000, 10))
        real = fo.time.time
        fo.time.time = lambda: next(clock)
        try:
            self.assertEqual(fo.wait_decision(self.cf({"verdict": "error"}), "f", "s", 50)["verdict"], "error")
        finally:
            fo.time.time = real


class VerifierVerdictTest(unittest.TestCase):
    """A refused lander is told which tests failed, from the verifier's log."""

    def write(self, *rows):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "verify.log")
        with open(p, "w") as f:
            for r in rows:
                f.write((r if isinstance(r, str) else json.dumps(r)) + "\n")
        return p

    def test_latest_verdict_for_the_head(self):
        p = self.write({"event": "unjudged", "head": "abc", "error": "busy"},
                       "not json abc",
                       {"event": "verdict", "head": "other", "summary": "no"},
                       {"event": "verdict", "head": "abc", "summary": "1 new failing: T.test()"})
        self.assertEqual(fo.verifier_verdict("abc", p)["summary"], "1 new failing: T.test()")

    def test_missing_log_is_none(self):
        self.assertIsNone(fo.verifier_verdict("abc", "/nonexistent/verify.log"))

    def test_unknown_head_is_none(self):
        self.assertIsNone(fo.verifier_verdict("abc", self.write({"event": "verdict", "head": "zzz"})))


if __name__ == "__main__":
    unittest.main()

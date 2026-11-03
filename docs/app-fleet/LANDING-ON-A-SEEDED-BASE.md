---
status: current
describes: [tools/app-fleet/onboard.py, ~/.config/foundry/bin/foundry-push, ~/.config/foundry/bin/foundry-fetch]
verified: 2026-10-22 (motionmix trial: 17 lane commits cherry-picked onto the seed with no conflicts, nothing pushed)
---

# Landing a change on a seeded base

`onboard.py` seeds each base as **one orphan commit**: the text files of the GitHub branch it was seeded from,
minus binaries and files over 4 MiB, plus `FOUNDRY-SEED.md` and `.foundry/assets.json` (the stripped
files, with their hashes and the origin commit that still holds them). The base therefore shares **no history**
with your GitHub clone. You land work by replaying your commits onto the base, not by pushing your branch.

## MotionMix family bases (foundry-staging, 2026-10-22)

| base | seeded from | seed |
|---|---|---|
| `motionmix` | `panel/lan-mirror-and-subset-recording` @ a6d7fd8 (registry `seed_branch`; GitHub main is a stale April line) | 5dd7d7e8 |
| `motionmix-ableton` | main @ 95c8243 (57 binaries stripped) | b4ea9614 |
| `lume-motion-state` | main @ d5d4dd5 | 238b6ace |
| `sharedservices` | main | 4d966fd0 |
| `airdeck` | existing base (Air Deck gate run, 2026-10-19) | |
| `motionmixapp` | `trunk/build128-20261021` @ 096805f (pre-direction build-128 line; GitHub main is Aug 14) | 15eafb57 |
| `comp-core` | local `~/Desktop/Comp-Core` @ 17e34234, **path-scoped** to the echelon-live closure (7 subtrees) | d6579408 |
| `lume-commerce` | main, **path-scoped** to stage/mac4 + tools/infra/services/scripts/tests/apps/config/packages + root files | 816460df |

Path-scoped bases hold only the listed subtrees (`.foundry/assets.json` `scope`); a task outside them is refused by
`allowedRoots`. Comp-Core's p1/body-time history holds `.env` files, so it never goes to GitHub; the gate is its path.
Secrets are withheld at seed time (`withheld` entries in assets.json, path and rule only).

The gate diffs trees by object id since hotfix 2ebf8fa and lands file modes, including mode-only changes, since
7674e0f (deployed 2026-10-22, version d820edf6).

## Steps

1. Fetch the base next to your clone:
   `~/.config/foundry/bin/foundry-fetch <base> '+main:refs/remotes/foundry/main'`
2. Replay your unpushed commits onto it:
   `git checkout -b land/<task-id> foundry/main && git cherry-pick <first-unpushed>^..<last>`
   Text only. A commit that adds or edits a binary is refused by the gate; put the binary in Drive and record it
   in `.foundry/assets.json` instead.
3. `git commit --amend --no-edit --date=now` right before pushing (the gate refuses a HEAD authored more than
   300 s earlier).
4. Open the task, subscribe the fork, push, read the verdict: steps 2 to 5 of nko-speech `docs/ONBOARDING.md`,
   with `"baseRepo":"<base>"`. Task files are read through the field allowlist only; `dispatches[].token` is never
   printed.
5. On MERGE, mirror to GitHub by pushing **your original branch** (the commits you replayed), not the gated
   merge commit:
   `git diff <your-branch> foundry/main --stat -- . ':!FOUNDRY-SEED.md' ':!.foundry'` must list only files from
   `.foundry/assets.json` (binaries, oversized files, and symlinks, which seeds since 2026-10-22 record with
   their target), then `git push origin <your-branch>`. Seeds made before that dropped symlinks without a record,
   and merges before 2ebf8fa landed new executables as 100644; mode-only and symlink-only differences from
   those are known defects, not ungated content.
   Push to GitHub only after a MERGE verdict. A GitHub push without a gated MERGE is the ungated path that
   Mohamed retired for this family on 2026-10-22.
6. Keep the fork's history and delete the fork: step 7 of nko-speech `docs/ONBOARDING.md`.

## Parallel lanes (foundry_ops, 2026-11-02)

`tools/foundry-ops/foundry_ops.py land` does steps 1 to 6. Since 2026-11-02 it also coordinates lanes, because nothing
else does: the gate only sees a lane when it lands, compares whole files, and squash-merges.

- **`foundry_ops.py scan REPO BASE`** reads every worktree of the repo against `refs/foundry/<base>/main`.
  - It reports which lanes are landed. It reads the land log, because a squash merge never makes the lane's branch an ancestor of main.
  - It lists which files each lane still has pending, including uncommitted edits.
  - It runs a hunk-level `git merge-tree` against main.
  - It reports which active lanes (activity within 3 days) share pending files.
  - `--cache` writes `~/.config/foundry/lanes/<base>.json`. The SessionStart hook `~/.claude/hooks/mesh-lanes/session_lanes.py` reads it and refreshes it in the background, so a session that starts inside a lane's worktree sees its own state and the other active lanes.
- **Preflight.** Before a task is opened, `land` refuses when another active lane has unlanded edits, with different bytes, to a file this landing changes.
  - The message names the other lane's branch and worktree.
  - Agree on an order with that lane, or pass `--ack-overlap` (or `"ackOverlap": true` in the spec) to land anyway.
  - Generated files never block.
- **Generated files.** A base can declare its generator in `.foundry/generated.json`:

  ```json
  {"format": "foundry.generated.v1",
   "files": ["MotionMixApp.xcodeproj/project.pbxproj", "MotionMixApp/Info.plist"],
   "run": ["xcodegen", "generate", "--quiet"],
   "links": {"../MotionMix": "~/Developer/MotionMix"},
   "assets": ".foundry/assets.json"}
  ```

  `land` builds the scratch worktree inside its own directory, so `links` (siblings only) resolve there. The files listed in `assets` (stripped binaries) are linked in from the lane's worktree or the main checkout.
  - **The generator must earn trust.** On the untouched base it must reproduce `files` byte for byte. If it does not, it is not used, and conflicts are reported as before. On motionmixapp it reproduces all five files only once the stripped assets are linked in.
  - **Once trusted:** a cherry-pick conflict confined to generated files is resolved by regenerating. After the last pick the generated files are regenerated again, because a clean textual merge of a generated file can still be wrong.
  - **A real source conflict** still stops the landing.
- **After a merge.** `land` moves the source worktree onto the merged commit with `git reset --keep`, never `--hard`, and only when that loses nothing. All three must hold:
  - HEAD is the last landed commit.
  - No tracked file is edited.
  - Every commit HEAD has beyond main has landed.

  Otherwise the result carries the command to run. Without this, a lane that keeps working on its branch conflicts with its own landed code.
- **Tests:** `python3 -m unittest tools/foundry-ops/test_foundry_ops.py`. They build throwaway repos and need no network.

## Verified merges (staging gate, 2026-11-02)

The staging gate now builds and tests a merge before it lands, for any base that opts in. motionmixapp is the first.

- **What runs.** After admission, the gate POSTs to its verifier, `tools/foundry-verify/verify_server.py` on Mac1 (`com.foundry.verify`, 127.0.0.1:8803).
  - The verifier rebuilds the tree the gate would write: base main plus the fork's own changes since its fork point.
  - It runs the base's `.foundry/verify.json`, read from main, so a proposal cannot change its own check. The job goes to the recipe's worker (Mac5 for motionmixapp) through `fabric job run --sync/--link`.
- **What it refuses.** A merge that adds a failing test that main does not have, or that stops building, gets `verification_failed` naming the tests.
  - Main's own failures are measured once per main sha, so a red main never blocks the fix for it.
  - Changes confined to the recipe's `skip` globs (docs) pass as a labelled skip.
  - Every `.foundry/assets.json` entry is put in the tree, so each merge proves the manifest complete. It uses an APFS clone of a source checkout's file when the sha256 matches; otherwise the blob at the entry's `origin_commit` (or the manifest's), read from a local clone or fetched blob-by-blob from the manifest `origin` into `~/.fleet/verify/<base>/origin.git`. An asset that still does not match stays a warning in the summary ("N asset(s) not as main declares"), and the verdict log names it (`assets_unmatched`).
  - A new failure is rerun once, alone (`-only-testing`), on the candidate tree. If the rerun executes it and it passes, it counts as flaky: the merge passes and the summary names it. A test that breaks every time fails twice and is refused. Main has at least one such test (`DiffusionServiceModelLoadTests.testGenerateWhileModelsLoadUsesRuleBasedPath`), which passed at d75efd6 and failed at 5de805b.
- **When it cannot judge.** A busy worker is waited on for 3 minutes, then forced.
  - Anything else (fetch failure, deadline, crash) returns 503 `{"retry": true}`. The gate records an `error` row and the queue retries, up to 3 times, then the dead-letter queue. A guarded base fails closed.
  - If the verifier cannot be reached at all, the gate records "not checked" and merges, so other bases are never held up by Mac1.
- **`land`.** It waits up to 30 minutes for a base with `.foundry/verify.json`, and treats `error` rows as a retry in progress.
  - The gate keeps check output out of its ledger, so its reason reads only `failed xcodebuild test (mac5)`. On that refusal, `land` looks up the verifier's verdict for the pushed sha in `~/.fleet/verify/verify.log` and prints which tests failed (`"verification"` in its result). Off Mac1, it prints where to look.
- **How it is wired.**
  - Gate: `VERIFY_URL` is a secret holding the token path, `VERIFY_ENFORCE=1`, `VERIFY_TIMEOUT_MS=840000`, and the `VERIFY_SERVICE` Workers VPC binding. The VPC service is `foundry-verify` (01a19f18).
  - Tunnel: Cloudflare Tunnel `foundry-verify` (fb73dc27), run by `com.foundry.verify-tunnel`. It has no public hostname.
  - The deployed gate source is `gate-hotfix` branch `hotfix/gate-diff-mode-20261019`, not this branch. Port the verify changes before deploying the gate from anywhere else.
  - Verifier config is in `~/.config/foundry/verify.json` (which bases) and `verify-token` (0600); its log is `~/.fleet/verify/verify.log`.
- **Proved on 2026-11-02.**
  - A docs change skipped and merged.
  - A real recipe run gave 363 tests, 0 failing, in 3.5 minutes cold.
  - A first canary that broke a test merged anyway: Mac5 was too loaded to start the job, and "not checked" did not block. It was reverted within 2 minutes, which is why the wait, force and retry rules above exist.
  - Canary 2 (a commit adding one `XCTFail`) was refused: decision 592, `verification_failed`. The verifier's summary read "363 tests, 1 new failing: ToneHouseHubProbeTests.testServerErrorIsUnreachable()", after waiting out a busy Mac5 for the baseline. 6 minutes from push to refusal. Main did not move.
- **To stop guarding a base in an emergency,** remove it from `~/.config/foundry/verify.json`. The verifier then answers "nothing checked" and the gate merges as before. To turn the whole check off, `wrangler secret delete VERIFY_URL --env staging` in the gate checkout.

## Lessons from the first day (2026-10-22/23)

- **No decision row within 2 minutes:** re-run `tools/subscribe-repo.sh staging '<fork>'`, amend the date and push again.
  A fork's push subscription can exist and still not deliver (batch1b, 470 files: nothing reached the gate until
  the re-subscribe, then it merged as decision 146). The gate's own failures now land in the
  `foundry-push-events-staging-dlq` queue, so silence means the event never arrived.
- **Never re-POST a task id.** Opening the same `taskId` again can overwrite `~/.config/foundry/task-<id>.json`, the
  fork's token file. Reuse the existing task file; pick a new task id for a new attempt.
- **Sync a working checkout with `git merge --ff-only`, never `git reset --hard`.** A hard reset on
  `~/Developer/MotionMix` once deleted 469 unlanded files from disk (restored, nothing lost).
- Rows that say "no task ticket for fork <base>" right after a merge are the gate seeing its own push to the base.
  They are expected, not a stranger writing to the base.

## Limits

- 4 MiB per file, 8 MiB of text and 2000 changed paths per merge. No limit on the tree size (M7 fixed in 2ebf8fa).
- File modes (100644/100755) land as pushed. Symlinks and submodules in a change are refused.
- `motionmix` (28 MB text) and `motionmix-ableton` (8.8 MB text) are over 8 MiB in total. The seed bypassed
  the per-merge limit once; ordinary merges are deltas and fit, but a mass rename or reformat will not.
- Edits outside the task's `allowedRoots` are refused.

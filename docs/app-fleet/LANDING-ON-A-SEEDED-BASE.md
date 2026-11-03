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
  - The staging gate deploys from this repository. Since 2026-11-03 14:44Z it is version 51e1dd00, commit 3437371: version 30780716 (commit 9900737, live from 06:50Z), which matches the old gate on every behavior `GATE-PARITY.md` lists as a regression, plus a readable reject for content the gate cannot land (a symlink, a submodule, bytes that are not UTF-8, a file over 8 MiB). At 14:50Z Mohamed rolled back to 30780716 to try the rollback command, and the gate was rolled forward to 51e1dd00 minutes later; both directions worked from `workers/gate`. `gate-hotfix` is retired as a deploy source; merge any gate fix made there into this repository first.
  - History: version 33a0b98c (commit b4d5c8c) ran from 04:57Z to about 05:02Z on 2026-11-03, and Mohamed rolled it back to `gate-hotfix` 9fe6444 (version 20789530). In that window a lane's second push of a change that had already merged (decision 643: same content, new sha, because land retried) errored with "no changed tree and no proven replay" where the old gate answers with the base head. 93c27fe fixed it: merge() returns the base head when the base already equals base plus the change. `merge-http.test.ts` covers it, plus executables, redelivery and a moved base, against real git smart-HTTP remotes. 6ab3dc4 fixed the client side: land waits 300 s before a re-push and waits on every head it pushed.
  - Staging D1 got the receipt schema first: `decisions.verification` and the immutable `verification_receipts` table (both additive, so an older gate version still runs on it). Every decision that reaches the verifier now writes a receipt, including "not checked" ones.
  - This repository's merger checks that the landed tree equals base plus the admitted change (`admissionOverlay`), file by file and mode by mode. Before the deploy it refused executables and file to directory changes; b4d5c8c admits both, and three tests compare the overlay with what `commitForkFiles` lands.
  - Live proof on 30780716, scratch base `gate-repro2-20261103`:
    - Decision 663 merged change A as 4b568750.
    - Decision 664: the same change amended under a new sha (9e5498fd) and force-pushed to the same fork, as land's retry did for 643. Verdict `merge`, answering 4b568750; main did not move and no commit was made.
    - Decision 665, a normal land (a new file plus an edit to an executable), merged as 6ce39fdc; the landed tree equals the proposal's (b022d445) and the mode stays 100755.
    - All three wrote receipts (`policy` enforce, requireChecked false).
  - Live proof on 51e1dd00, same scratch base: decision 674 (a symlink, `src/link`) and 675 (`src/blob.bin`, not UTF-8) were rejected with `invalid_args` and a reason naming the path, one decision row each and no receipt, so the verifier never ran; the base did not move. Decision 676, an ordinary edit as the control, merged as 7bb4f0d with the landed tree equal to the proposal's.
  - First real motionmixapp land on 30780716: decision 666 (lane a367b1c9, `docs/SHIP-READINESS.md` only) merged as d2d5977b. The verifier took the docs skip path, so a full Mac5 build and test under this version is still to be seen.
  - Earlier proof on 33a0b98c: decision 639 on the same base. One merge edited and added executables, added nested files, turned a file into a directory and deleted a file; the landed tree equals the proposal (`git diff --raw` empty).
  - Rollback, from `workers/gate`: to the previous version (9900737, no readable reject) `npx wrangler rollback 30780716-cf1f-4812-a3dc-d80aa3bf6fe8 --env staging`; to `gate-hotfix` 9fe6444 `cd ~/Developer/foundry-integration/one-foundry/workers/gate && npx wrangler rollback 20789530-9f24-4e17-be5b-bf226472e251 --env staging`. Wrangler reads the Worker name and environments from `workers/gate/wrangler.toml`, so it fails with "No environment found ... staging" anywhere else.
  - `node_modules` in a checkout can be empty: run `npm ci` before `npm test` or a deploy.
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

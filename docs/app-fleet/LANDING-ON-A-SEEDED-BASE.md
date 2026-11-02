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

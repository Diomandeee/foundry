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

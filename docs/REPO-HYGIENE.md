---
status: current
describes: [tools/repo-hygiene/]
verified_at: 2026-10-22
verified_commit: 8e6525d
owner_lane: fleet-supervisor-plan
---

# Repo hygiene and the relevance boundary

Foundry prepares the structure. The cleanup itself starts after Foundry is finished and is done by each repo's owner lane. Nothing in `tools/repo-hygiene/` writes to a repo.

## Why

MotionMix ran production code outside git for two months: the render pipeline, the cut compiler, the GCS stage, the kit policy and the Vision sampler. Docs describe states that no longer hold, with no marker of which one is current. 48 refs point at objects lost in the 2026-10-01 filter-repo. Nothing at the end of a work chunk noticed any of it.

## The four structures

| Schema | File | One per | Lives in |
|---|---|---|---|
| Inventory | `schemas/inventory.v1.schema.json` | scan | data plane (large: 8.8k items for MotionMix) |
| Doc status | `schemas/doc-status.v1.schema.json` | tracked doc | the doc's own front matter |
| Ref ledger | `schemas/ref-ledger.v1.schema.json` | repo | `.foundry/hygiene/ref-ledger.json` in the repo |
| Boundary receipt | `schemas/boundary-receipt.v1.schema.json` | work chunk | lane receipts + `.foundry/hygiene/last-receipt.json` |

**Inventory.** Every uncommitted, untracked or deleted file is one item, with these fields:
- `kind`: code, test, doc, data, generated, log, secret-risk or unknown.
- `owner_lane`.
- `last_modified`.
- `imported_by_tracked`: the tracked files that import or invoke it. This field is how the render modules were found.
- `in_build_source_dir`: an untracked .swift file compiled into a tracked target.
- `decision`: filled in by the owner lane during cleanup. One of commit, ignore, move-to-data-plane, delete-after-backup, quarantine-secret or keep-local.

Secret-risk items are flagged by file name or content pattern, and their content is never copied into the inventory.

**Doc status.** Front matter on every plan, architecture, status or runbook doc:

```yaml
---
status: current            # current | superseded | historical | draft
describes: [scripts/motionmix_studio_engine.py, lume-wiring/render/]
verified_commit: 9ce2284   # claims last checked against code at this commit
superseded_by: docs/...    # required when superseded
owner_lane: air-deck-ableton-integration
---
```

A current doc whose `describes` paths changed after `verified_commit` is stale (rule R5). Staleness becomes a diff query instead of a judgement.

**Ref ledger.** One entry per dangling ref, holding the sha, cause and `recovery_status`. The status is one of unchecked, on-remote, in-archive, recovered, superseded or lost-confirmed. Each entry also records where the objects were found and who checked.

## The boundary (end of every work chunk, like the merge gate)

`boundary.py check <repo>` applies six rules:

| Rule | Fails when |
|---|---|
| R1 untracked-but-used | Tracked code imports or invokes an untracked file, or an untracked .swift file is inside a target's sources. |
| R2 generated/data/log | An untracked output, dataset or log is neither .gitignored nor on the data plane. |
| R3 secret-risk | An untracked file looks like a secret. Quarantine it; never commit it. |
| R4 doc-status | A doc under `docs/` or named *PLAN*, *ARCHITECTURE*, *STATUS*, *RUNBOOK*, *CONTRACT* or *PROGRAM* has no status. |
| R5 doc-describes-changed | A current doc's code changed after its `verified_commit`, or after the doc's own last commit if that is later. A doc can't name the commit that contains it, so editing it counts as re-verifying. |
| R6 dangling-refs | A ref points at missing objects and has no ledger entry. |

Modes:
- **ratchet** (default): `boundary.py baseline` freezes today's violations, and only new ones fail. Each repo can adopt it immediately, and the backlog shrinks as owner lanes decide items.
- **enforce**: every violation fails. Use it once a repo's baseline is empty.
- **report**: never fails.

The first ratchet run on MotionMix flagged exactly the two things a lane added minutes earlier. One was a new `.vision.json` under `analysis/` that is not ignored. The other was a new architecture doc with no status. The old backlog was not flagged.

## First scans (2026-10-22, read-only)

| Repo | Machine | Entries | R1 | R2 | R3 | R4 | R6 |
|---|---|---|---|---|---|---|---|
| MotionMix | Mac1 | 8,818 files (git collapses them to 1,769 lines) | 54 | 3,857 | 7 | 93 | 48 |
| MotionMix-Ableton | Mac5 | 6 | 0 | 6 | 0 | 13 | 0 |
| MotionMixApp | Mac1 | 18 | 0 | 0 | 0 | 26 | 0 |
| AirDeck | Mac1 | 2 | 0 | 0 | 0 | 0 | 0 |
| Comp-Core p1/body-time (sparse worktree) | Mac1 | 0 | 0 | 0 | 0 | 116 | 0 |
| Comp-Core a1-multicam-extrinsics | Mac1 | 0 | 0 | 0 | 0 | 115 | 0 |

Comp-Core's working branches live as worktrees of `~/Desktop/Comp-Core` under `~/Developer/.worktrees/Comp-Core/` on Mac1. Mac4's `comp-core-p1-build` is an rsync export with no `.git`. Their only debt is docs without status.

MotionMix's seven R3 items are content-pattern hits in tests and launch scripts. Many are probably test fixtures, but the owner lane decides.

## Cleanup order (after Foundry finishes)

1. Clear R1 first: commit or remove. This is where real code was hiding.
2. Then R3: quarantine secrets to the keychain or a vault, then rotate if real.
3. Then R6: work through the ledger. f7 is checking the cold archive for three refs.
4. Then R2: .gitignore output paths, and move datasets to the data plane per the MotionMix platform contract.
5. Last, R4/R5: add status to each doc, starting with `docs/architecture/`.

Each step re-baselines, and the baseline only shrinks.

## Wiring (when activated)

- **Lane Stop hook:** run `boundary.py check --mode ratchet` for the repo the lane touched, and write the receipt into the lane's receipt chain.
- **Foundry gate:** run the same check on the forked tree before merge. A fail blocks like a test fail.
- **fleet-watch:** surface a lane whose last receipt failed.

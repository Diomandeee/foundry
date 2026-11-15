# Merge -> build/test jobs (fleet reset step 3.5)

Goal: every gate MERGE on a base with a recipe runs that base's build or tests on the right worker, and the
outcome lands in D1 next to the decision. This page is what exists, what each remaining piece fits into, and
what is owner-gated. Status 2026-11-01: planning works against live staging; nothing is submitted.

## What exists

| Piece | Where | State |
|---|---|---|
| Recipes, one BuildProfile per base | `docs/app-fleet/build-recipes.v1.json` | `airdeck` (xcode-build-v1, Mac5 VM) and `comp-core` (linux-build-v1, GCP), both `proposed` |
| Planner | `tools/foundry-job/plan.ts` | validates recipes with the authority's own validator; `comp-core` hashes to the Linux pilot's `serverProfileHash` (`202e9c92…`) |
| CLI | `tools/foundry-job/cli.ts` `recipes`, `pending`, `plan <decision>` | read-only against staging D1; 24 merges pending on 2026-11-01 |
| Job ledger table | `workers/gate/schema.sql` `build_jobs` | proposed, **not applied** (needs migration approval) |
| Submit with a durable intent journal | `tools/foundry-pilot/build-submission.ts` `submitBuild` | exists, owner credential, `buildActionsEnabled` + profile allowlist |
| Authority job flow | `packages/build-jobs` (approve*, submit, claim, stage, verify, `build_receipts`) | tested in-process; `COMPUTE_BUILDS_ENABLED=false` everywhere |

A job id is `<base>-<merged sha 12>-<profile hash 8>`, so planning the same merge twice gives the same id
(the authority refuses a second `submit` of that id with `job-exists`), and a recipe change gives a new job.

## Flow once it is switched on

1. `foundry-job pending` finds MERGE decisions on recipe bases with no `build_jobs` row (join
   `decisions.repo = tickets.fork_repo`, verified on staging: 164 of 164 merges join).
2. Snapshot the merged tree (`git archive <merged_sha>` under the recipe's `input.roots`, plus vendored inputs)
   into the storage broker with `packageProjectInputSnapshot`, which publishes a content-addressed
   `projects/<id>/manifests/<sha>` object.
3. Owner `approveInput` for that manifest (see the decision below), then `submitBuild` with the planned body.
   Row: `planned -> input-approved -> submitted`.
4. The worker's controller (`BuildWorkerController.pollOnce`) claims, runs, stops, stages. A separate verifier
   principal calls `/v1/builds/verify-target`; on success the authority writes its immutable `build_receipts` row.
5. `foundry-job sync` (to build) reads `/v1/builds/result` (owner) or the feed and updates the D1 row:
   `succeeded` with the manifest sha256 and verifier, or `failed` with the exit code. A nonzero exit never yields
   a receipt, so failures come from the feed, not the receipt.

Trigger: a poller (launchd on Mac1 or a job on minenode) running `pending` + submit + `sync` every few minutes,
the same pattern `foundry_ops.py land` already uses to wait for a decision. The gate has no producer queue and
no post-merge hook, and adding one changes the gate worker; a poller keeps the gate untouched.

## Decision for Mohamed: automatic input approval

`packageProjectInputSnapshot` deliberately never approves completeness: every candidate comes back
`reconstructable:false`, and the authority only admits a job whose input is owner-approved and reconstructable.
So "every merge builds" needs one of:

- **A. Recipe-level completeness (recommended).** The owner approves, once per recipe, that "the git tree at the
  merged sha under `input.roots`, plus the listed vendored inputs" is a complete input. The poller then calls
  `approveInput` with the owner credential for each merge of that base, and nothing else. Same trust as today's
  gate: the merged tree is already the gate's decision.
- **B. Owner approves each input.** The poller stops at `planned`; the owner approves each merge's input from the
  operator UI (`tools/foundry-pilot/operator-server.ts`). Safe, but merges wait for a person.

## Owner-gated before anything runs

1. `COMPUTE_BUILDS_ENABLED=true` on `foundry-compute-staging` (`workers/compute/wrangler.toml`).
2. `approveProfile` for each recipe (moves its `status` to `approved` here).
3. A submitter credential (today only owner and verifier are provisioned, `workers/compute/scripts/provision.sh`)
   and a verifier principal separate from submitter and executor.
4. Storage broker origin and credential (`BUILD_BROKER_ORIGIN`, `BUILD_BROKER_CREDENTIAL`) and its GCS bucket.
5. Workers: Mac5 `foundrybuild` GUI login, enrolment, `approveWorker`, `approveVm` (steps 3.1-3.3); the GCP Linux
   VM enrolled (step 3.4). Neither controller factory has a daemon caller yet; that loop is the remaining build work
   (`docs/cloud-workspaces/validation-2026-10-18/ACTIVATION-READINESS.md`).
6. Applying the `build_jobs` table to `foundry-decisions-staging`.

The `airdeck` recipe pins the guest the 2026-10-21 proof used (macOS 27.0.1, Xcode 27A9275, iphoneos27.1).
Step 3.2 re-proves the build on the macOS 27.2 host; if the guest image changes, the recipe's `macos` and
`xcodeBuild` change with it and so does its profile hash.

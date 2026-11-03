---
status: current
describes: [workers/gate/src/decide.ts, workers/gate/src/merge.ts, workers/gate/src/pipeline.ts, workers/gate/src/gate-parity.test.ts, packages/artifacts-port/src/cloudflare.ts]
verified: 2026-11-03 (gate-parity.test.ts run against this tree and against gate-hotfix 9fe6444, the gate deployed until 06:50Z)
---

# Gate parity: one-foundry vs the deployed gate

On 2026-11-03 the staging gate was deployed from this repository for 5 minutes and rolled back. Decision 643, a
lane pushing an already merged change a second time, errored where the deployed gate (`gate-hotfix` 9fe6444,
version 20789530) answers with the base head. This page records every behavior where the two gates differ, as
observed, not as read from the code. Since 06:50Z the staging gate runs this repository's 9900737 (version 30780716);
the "gate-hotfix" column is the gate it replaced and the rollback target (20789530). P6 was proved live as decisions
663 and 664 (`LANDING-ON-A-SEEDED-BASE.md`).

`workers/gate/src/gate-parity.test.ts` runs `handlePush` with the production port (`cloudflarePort` over a fake
Artifacts binding that reads bare repos with git) and the production merger (`IsomorphicMerger` over git smart
HTTP, served by `git http-backend`). The same file was copied into a gate-hotfix 9fe6444 checkout and run there.
`PARITY_OUT=<file>` writes what each scenario got back: every attempt's verdict and reason (an `error` is
redelivered up to 3 times, as the queue does), whether the base moved, and what the verifier was asked.

## Rows where the gates differ

| # | Push | gate-hotfix (deployed until 06:50Z) | one-foundry | Call |
|---|---|---|---|---|
| P6 | Same change pushed again under a new sha after it merged (643) | merge, no new commit | was: error, retried until dropped. Now: merge, no new commit | **Regression, fixed** (93c27fe): `merge()` returns the base head when the base already equals base plus the change |
| P19 | A change touching 2,100 files | merge | was: conflict `admission-path-budget` (cap 2,000). Now: merge | **Regression, fixed**: the cap is 5,000, the port's own diff budget, so it never fires before the port gives up |
| P20 | 9 MB of text in 3 files | merge | was: error `admission text-byte budget`, retried until dropped. Now: merge | **Regression, fixed**: total-size cap removed; the port still refuses any file over 8 MiB, in both gates |
| P8a | Two quick pushes; the first event is handled after the branch fast-forwarded past it | error `merge: proposal moved` on all 4 attempts, the verifier run on each (4 Mac5 builds on a verified base), then dropped | reject at once, no verifier run: "refs/heads/main moved past X (now Y); the newer push is decided on its own" | **Mohamed decides.** Keep: the newer push carries the same commits and merges (P8b, both gates); the old path only burned retries and builds |
| P9a | Two quick pushes; the first was amended and force-pushed over | reject `proposal_not_found` | reject `invalid_args`, same message as P8a | **Mohamed decides.** Keep: both refuse; the new reason says what happened. No client keys on either reason (`land` reads only `verification_failed`) |
| P13 | Push on a fork branch other than main | merge; verifier asked with `baseBranch` = `feature` | was: `main`. Now: `feature` | **Regression, fixed**: tools/foundry-verify fetches the head from the fork at `baseBranch`, so `main` fetched the wrong branch and a verified base went unjudged. The `VerifyRequest` doc now says what the field is |
| P5, P18 | A change that deletes files | merge; the verifier's `files` omits deletions | merge; deletions are in `files` (and in the receipt) | **Mohamed decides.** Keep: truthful, and no verdict changes, because tools/foundry-verify computes the changed paths from the trees and does not read `files` |
| (all) | Any push that reaches the verifier | no receipt | an immutable `verification_receipts` row and `decisions.verification`, written before the merge; a store without receipts refuses to merge | **Mohamed decides.** Keep: evidence of what was checked. Staging D1 has had the schema since 2026-11-03 |

## Same in both gates (checked, no difference)

P1 text edit and new file, P2 executable edit and new executable (modes kept), P3 mode-only change, P4 nested adds
under an allowlist `.gitignore`, P5 deletion and file to directory (landed tree), P7 redelivery of a merged push,
P10 another lane merged a different file, P11 a real conflict, P12 another lane made the identical change, P14 an
unknown sha (`proposal_not_found`), P17 the first merge onto an empty base. In every merge the landed tree equals
base plus the change.

## Content the transport cannot carry (fixed after parity, both gates had it)

The admission path carries file contents as UTF-8 text, so a symlink, a submodule, bytes that are not UTF-8 or a
file over 8 MiB cannot land. Both gates recorded `infra_failure` for these and the queue retried until it dropped
the push, so the lane saw `error` rows and then silence. Since 2026-11-03 the gate rejects them at once, before the
verifier runs, with `invalid_args` and a reason that names the path, for example
"unsupported content: link is a symlink; the gate lands regular and executable UTF-8 text files up to 8 MiB".

- Symlinks and submodules come from the port's tree diff (`CommitInfo.unsupported`). The newest fork-side commit
  that touches a path decides what it is, so a symlink a later commit turned back into a file merges (P15b).
- Bytes that are not UTF-8 and files over 8 MiB come from the port's `readFile`, which throws
  `UnsupportedContentError` instead of a plain error. An outage is still an error and still retried.
- Tests: P15, P15b, P15c, P16, P21 in `gate-parity.test.ts`; the port's typed error and modes in
  `cloudflare.test.ts` and `git.test.ts`.

## Not fixed

- A base over 20,000 files errors in one-foundry's merger (`completeTree` budget); the deployed gate has no such
  cap. The largest base on 2026-11-03 is motionmix with 2,810 files (comp-core 579, motionmixapp 554, airdeck 839).

## Not covered by the harness

- A base that moves between clone and push. one-foundry re-reads the ref before pushing and retries the decision
  once (`StaleBaseError`); the deployed gate fails the push and the queue retries. Both end with a fresh decision.
- The Cloudflare binding itself. The fake implements the documented surface (`log`, `readFile`, `readTree`,
  `readCommit` accept a commit id; an unknown ref is an empty list or null). `listServerRefs` against real
  Artifacts was checked by hand on 2026-11-03 (protocol v1 and v2).

## The landing client (decision 643's root cause)

`foundry_ops land` waited 120 s for a verdict, then amended and pushed again. The gate merged the first push 8 s
after that wait ended (638), and the re-push became a second event (643) while land reported `no-decision` for a
change that had landed. Since 2026-11-03 land waits 300 s before concluding a push was dropped, waits on every head
it pushed and takes the first verdict for any of them, and before deleting the fork lets the gate settle a duplicate
push. Tests: `PushUntilDecidedTest` in `tools/foundry-ops/test_foundry_ops.py`.

# Per-host simulator verification

Design written before implementation, 2026-11-15. Base: `715e41ddf7a0e7f4837b917e9d8955e459d02148`.
This branch is a review artifact. It does not update the running verifier, gate Worker, local config or base recipes.

## Assumptions and rule

There is one verifier process. Base locks still protect each base's synced tree and linked exports.
Simulator work takes a lock keyed by the canonical worker (`mac4` or `mac5`), regardless of base,
simulator or DerivedData path. Non-simulator work does not take that lock. Acquire before submitting
to fabric; retain until terminal completion or confirmed stop plus simulator-app cleanup. Adoption
transfers that same lock to the watcher; a retry collects the same job, never moves it to another host.
The fingerprint remains name + tree + the logical recipe (the entire placements list), before selection.

Try each unlocked placement in declared order. Fabric's unforced `job run --host H` is the admission
gate: no duplicated load/performing policy, and no `--force`, including after waiting. A refusal releases
the unused reservation and tries the next host. Busy/load/memory/performing refusals may be retried
within the original request deadline. Disk-floor and other definitive failures are unjudged; try any
remaining placements first. Never spin on an unstartable worker and never reset the request deadline.

## Recipe contract

Old single-host recipes remain valid and retain their command. New simulator checks may declare:

```json
{
  "need": "sims",
  "placements": [
    {"host": "mac5", "simulator": "11111111-1111-1111-1111-111111111111", "derived_data": "/Volumes/FoundryBuild/fleet-dd/example-verify"},
    {"host": "mac4", "simulator": "22222222-2222-2222-2222-222222222222", "derived_data": "/Users/mohameddiomande/.fleet/dd/example-verify"}
  ],
  "command": ["xcodebuild", "test", "-destination", "platform=iOS Simulator,id={simulator}", "-derivedDataPath", "{derived_data}"]
}
```

Substitute only the two literal tokens in command strings (including existing `bash -c` recipes).
Validate canonical hosts, UUIDs, absolute shell-safe DerivedData paths, nonempty lists, duplicate hosts,
and token use. Values must not introduce shell syntax. A generic simulator build uses only
`{derived_data}` and a null simulator; AirDeck's current app check is such a build, not a C1AB6BF6 test.
Top-level placements may be inherited by checks; an explicit check host opts out of inherited
placements. New placements are read only from main, under the existing recipe trust boundary.
Legacy simulator `host: auto`/omitted host tries canonical Mac5/Mac4 with unchanged command;
recipes containing a machine-specific UUID/path should name its host or use explicit placements.

## Failure and ownership chains

* request deadline → adopt job + concrete host + concrete simulator + held lock → watcher completes
  or stops it → release only its host → retry claims result without any new fabric submission.
* definite refusal → no job exists → release reservation → try next configured placement → bounded
  wait or unjudged. Load, disk, memory and performing never grant an override.
* `TimeoutExpired` during submission → parse any start receipt → adopt known job. Without a receipt,
  the remote launch outcome is unknown; quarantine that host and fingerprint, return unjudged and
  require job/remote-session reconciliation. Never release and fall back into a duplicate launch.
* ledger outage/missing row → keep polling to the late cap → stop recorded job on recorded host →
  cleanup that simulator, even if its row aged out of the newest 500 → release after success only.
* failed stop/cleanup or watcher exception → quarantine reservation with a visible reason. A healthy
  other host remains usable for unrelated checks. An HTTP 503 is not a test failure or a passed check.

The process-local locks do not fence a second verifier process, external lane use of the same
simulator, or a restart that forgets late/uncertain jobs. Deployment must drain requests and late
jobs and reconcile quarantine first. Host preparation must reserve dedicated gate devices and paths.
No fairness guarantee beyond trying all free placements; sustained load can still exhaust a deadline.
Cached baselines are currently keyed by tree/link/check, not toolchain/placement: both hosts must be
equivalent before enabling failover. This branch does not pretend that the observed machines are ready.

## Read-only readiness, 2026-11-15 (initial probe)

| Item | Mac4 | Mac5 |
| --- | --- | --- |
| Xcode | 27.2, build 27B52 | 27.1, build 27A9275 |
| selected developer dir | /Applications/Xcode.app/Contents/Developer | same |
| iOS runtimes | 26.3.1 (23D8133) | 26.3.1 and 27.1 (24A94425) |
| disk available | 29 GiB internal | 24 GiB internal; 76 GiB T7 |
| performing flag | absent at probe | absent at probe |

Mac4 lacks matching Xcode 27.1 and iOS 27.1, dedicated gate simulator reservations, and measured
capacity for three cold DerivedData caches above the 15 GB floor. Its ~14 GiB margin is not proof
that runtime installation plus builds fit. Existing lane simulators are not available for reassignment.
Draft recipes and exact preparation/deployment commands follow below.

## Preparation commands (review only; none executed)

Read-only follow-up confirmed Mac4 has only `/Applications/Xcode.app`, has `xcodegen` at
`/opt/homebrew/bin/xcodegen`, and its existing `~/.fleet/dd` totals 596 MiB. Both device-type names
`com.apple.CoreSimulator.SimDeviceType.iPhone-Duo` and `...iPhone-17e` exist. `xcodebuild -help`
confirms the `-downloadPlatform`, `-buildVersion` and `-importPlatform` syntax below.

First choose and approve a matched toolchain. The following assumes an authenticated, verified
Apple Xcode 27.1 xip has been staged directly on Mac4 at
`/Users/mohameddiomande/Downloads/Xcode_27.1.xip`, with enough free disk for extraction and the
runtime above the 15 GB floor. That artifact was **not** found or downloaded in this task; its origin,
checksum, disk budget and acquisition are open preparation gates, not an executable install receipt.
Do not downgrade or overwrite the existing Xcode.app. After that explicit preparation approval:

```bash
~/fleet/bin/fabric job run --host mac4 --need heavy_jobs --name verify-xcode-unpack --by codex-closeout --cwd /Users/mohameddiomande/Downloads -- bash -c 'set -e; test ! -e Xcode.app; xip --expand Xcode_27.1.xip'
```

The exact owner/admin operations on **Mac4**, after verifying the expanded bundle is 27.1 (27A9275):

```bash
sudo mv /Users/mohameddiomande/Downloads/Xcode.app /Applications/Xcode_27.1.app
sudo xcode-select -s /Applications/Xcode_27.1.app/Contents/Developer
sudo xcodebuild -runFirstLaunch
```

These change machine settings and are approval gates. An agent executes them after authorization;
Mohamed is not being asked to type them. Then run through fabric, without force:

```bash
~/fleet/bin/fabric job run --host mac4 --need heavy_jobs --name verify-ios-runtime --by codex-closeout --cwd /Users/mohameddiomande/Developer -- xcodebuild -downloadPlatform iOS -buildVersion 27.1 -architectureVariant arm64
~/fleet/bin/fabric job run --host mac4 --need sims --name verify-motionmix-device --by codex-closeout --cwd /Users/mohameddiomande/Developer -- xcrun simctl create Foundry-MotionMixApp com.apple.CoreSimulator.SimDeviceType.iPhone-Duo com.apple.CoreSimulator.SimRuntime.iOS-27-1
~/fleet/bin/fabric job run --host mac4 --need sims --name verify-serenity-device --by codex-closeout --cwd /Users/mohameddiomande/Developer -- xcrun simctl create Foundry-Serenity com.apple.CoreSimulator.SimDeviceType.iPhone-Duo com.apple.CoreSimulator.SimRuntime.iOS-27-1
~/fleet/bin/fabric job run --host mac4 --need heavy_jobs --name verify-derived-data --by codex-closeout --cwd /Users/mohameddiomande/Developer -- mkdir -p /Users/mohameddiomande/.fleet/dd/motionmixapp-verify /Users/mohameddiomande/.fleet/dd/airdeck-verify/app /Users/mohameddiomande/.fleet/dd/serenity-verify/ios
```

Read each creation job's log to obtain its actual UUID. Recheck Xcode build number, iOS runtime build
24A94425, device availability and free disk. AirDeck's current recipe is `xcodebuild build` on
`generic/platform=iOS Simulator`, so it needs the matching SDK and DerivedData, **no device**.
Do not change that check into a test or create an unused AirDeck simulator.

## Drafts and activation

`docs/verify-per-host-drafts/<base>/.foundry/verify.json` contains three draft files. Sources and the
exact locally cached main SHAs are in `sources.json`; these are not claims about the latest gate main.
Refresh and rebase the recipe changes before landing. Mac5's existing UUID/path remains declared,
but it was never used by this task. Mac4 device placeholders deliberately fail recipe validation
until replaced by real creation receipts. AirDeck and Serenity's non-simulator checks remain on Mac5.
Only simulator checks get placements, and test commands, flags, filters, links and skip rules are preserved.

Activation order, only after Mohamed's approval:

1. Finish matched-toolchain/device/disk preparation above. Run each proposed concrete command on
   its new Mac4 device/path and compare it with a trusted Mac5 result at the same tree and links.
   Run a controlled two-host concurrency check. This is the outstanding integration gate.
2. Drain new intake for a short maintenance window without disabling guarded bases. Observe zero
   running verifier jobs (newest 500), zero active requests/connections, zero late watchers and zero
   unresolved quarantine. Reconcile any unknown launch against the recorded host's tmux and jobs.
   Never clear quarantine solely because time elapsed. A restart forgets in-memory reservations.
3. Re-read live HEAD, inspect any concurrent changes, and fast-forward the reviewed branch only if
   possible; otherwise reconcile in an isolated branch and retest. Then restart `com.foundry.verify`
   in that drained window, verify the authenticated health response and startup log, and resume intake.
   The closeout `restart-verifier.sh` **must not be used unchanged**: it restarts after 15 minutes even
   without a gap and has broad Mac5 cleanup. If a gap is unavailable, abort the deploy, do not kill jobs.
4. Land each rebased recipe through its base's Foundry gate (one at a time for motionmixapp), then
   submit a scoped follow-up check and read the decision/test count and selected host. A recipe
   landing is judged by the old main recipe; the new scheduler/placements are proven by the next check.
   The renamed host-neutral check names create new baseline cache keys for multi-check recipes.

No gate Worker deployment or `~/.config/foundry/verify.json` edit is required. Rollback is a reviewed
reverse change to the recipes and verifier in another drained window; never hard-reset the shared checkout.

## Review evidence and remaining holes

The Mac4 verifier suite passed **137 tests in 25.966 s**, job
`job-verify-per-host-tests-1114-235833`. The invocation was the requested full suite with
`bash -o pipefail -c 'cd tools/foundry-verify && python3 -m unittest test_verify_server 2>&1 | tail -20'`.
The baseline suite had 102 tests; tests that previously expected a forced start now require an unforced
refusal/retry. No recipe command or real simulator was executed. The suite stubs fabric/SSH and adds
real-thread exclusion/concurrency checks. Existing ResourceWarnings from unclosed fixture files remain.

Review closed two additional ownership holes: generic simulator builds now confirm the remote tmux
session ended even though there is no app to terminate, and the cleanup pattern uses `[C]oreSimulator`
so it cannot match the remote shell carrying that same command. Cleanup polls for app exit and
quarantines on a failed stop, missing tool, SSH failure, timeout or unconfirmed process exit.

The Lean model is in the **lean-proofs repository's isolated worktree**
`~/Developer/lean-proofs-worktrees/verify-per-host`, branch `fleet/verify-per-host-20261115`, based on
`57d04d9` (VerifyLate). This preserves the unrelated uncommitted Audit/MotionMixSession changes in the
main lean-proofs checkout. Proof commit: `58c2c50ec9878903592162a66cb002e686064733`.
It declares 17 ownership/admission/adoption/quarantine theorems and adds
them to the full build and standard-assumption audit. `LEAN_PROOFS_CACHE` supports an isolated build
cache while reusing existing dependency bytes on the worker.

As of the review, **Lean validation is blocked, not passed**: Mac5 fabric admission refused the
`scripts/check.sh` job four times for load (18.8, 5.5, 6.3, 5.3 per core observed). No job was launched and
no override was used. The v4.35.0 toolchain exists on Mac5; Mac4 has no Lean toolchain. The next execution
gate is normal Mac5 admission, followed by successful `scripts/check.sh` and `AUDIT_OK 623` (606 existing
plus 17 new). That number is an expected audit size, not a result.

Remaining chains: overloaded Mac5 → admission refusal → proof still unchecked; mismatched toolchain
and missing devices → no simulator integration result → no activation approval requested in chat;
process restart → lost lock/adoption/quarantine state → drain/reconcile first. The unknown-submission
quarantine intentionally trades availability for preventing duplicate work and has no automatic expiry.

To retry the proof once Mac5 has capacity, from the isolated Lean worktree:

```bash
~/fleet/bin/fabric job run --host mac5 --need heavy_jobs --mem-gb 1.5 --name verify-hosts-lean --by codex-closeout --sync . -- bash -c 'set -euo pipefail; export LEAN_PROOFS_CACHE="$HOME/.cache/lean-proofs/verify-per-host/lake"; mkdir -p "$LEAN_PROOFS_CACHE"; test -e "$LEAN_PROOFS_CACHE/packages" || ln -s "$HOME/.cache/lean-proofs/lake/packages" "$LEAN_PROOFS_CACHE/packages"; bash scripts/check.sh'
```

## Validation and open gates

Run all verifier unit tests through fabric on Mac4, using pipefail so tail cannot mask failure.
Exercise same-host exclusion, distinct-host concurrency, refusal failover, parsing, legacy recipes,
late adoption, unknown launch quarantine, cleanup failure, and recorded-host cleanup.
Model lock ownership and transitions in Lean following VerifyLate; run `scripts/check.sh` on Mac5.
Mocks prove scheduler behavior; no simulator run tonight, so hardware integration remains an open gate.

Questions for Mohamed will be appended to CODEX-QUESTIONS.md: matching-toolchain preparation and
storage budget; dedicated simulator creation; then verifier restart in a drained window and gated
recipe landings. No gate Worker change is expected for this protocol.

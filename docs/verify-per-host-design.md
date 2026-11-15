# Per-host simulator verification

2026-11-15. Before this, one global `SIM_LOCK` in `tools/foundry-verify/verify_server.py` let one simulator
check run fleet-wide, and every sim recipe was pinned to Mac5 (simulator C1AB6BF6, DerivedData on the T7).
On 11-14 every Dancemaxing landing queued behind that one simulator while Mac4 sat at load 3 of 10 cores, and
landings came back unjudged with "waited past the deadline for another base's simulator job".

Thread B (Codex) designed and wrote the first version overnight (35ec874). This branch finishes it: main's
result per host, an unknown launch reconciled instead of held until a restart, a `probe` command to prove a
placement, and real Mac4 placements.

## Rule

- One verifier process. A base lock still guards each base's synced tree.
- Simulator work takes a lock per canonical host (`mac4`, `mac5`), whatever the base, simulator or path.
  Non-simulator work takes none. The lock is taken before fabric is asked and kept until the job ends, is
  stopped and its simulator cleared, or is adopted (the watcher then owns it).
- Placements are tried in the recipe's order. Each is one unforced `fabric job run --host H`: fabric's own
  busy, performing, memory, load and disk checks are the admission rule, and `--force` is never passed. A
  busy, performing, memory or load refusal frees the lock and tries the next placement, then retries within
  the request's deadline. A disk-floor or other definite refusal drops that host for this request.
- A job running at the deadline is adopted on the host it runs on. The retry of the same check (fingerprint:
  name + tree + logical recipe, plus the pinned host for a baseline or rerun) takes its result.

## Recipe

The old single-host form (`"host": "mac5"` and a literal command) is unchanged. A simulator check may list
placements instead; the command uses `{simulator}` and `{derived_data}`:

```json
{
  "need": "sims",
  "placements": [
    {"host": "mac4", "simulator": "49AACE36-E3D0-45AE-9B63-8A5A657D6DF6", "derived_data": "/Users/mohameddiomande/.fleet/dd/motionmixapp-verify"},
    {"host": "mac5", "simulator": "C1AB6BF6-049B-4C64-B707-73E33F42E371", "derived_data": "/Volumes/FoundryBuild/fleet-dd/motionmixapp-verify"}
  ],
  "command": ["xcodebuild", "test", "-destination", "platform=iOS Simulator,id={simulator}", "-derivedDataPath", "{derived_data}"]
}
```

`placements_of` checks hosts (distinct, canonical), UUIDs, absolute shell-safe paths and token use. A generic
build (`generic/platform=iOS Simulator`, AirDeck's app check) has `"simulator": null`. Checks inherit top-level
placements; a check with its own `host` opts out. Recipes are read from main as before, so a recipe that adds
placements is judged by main's single-host recipe and takes effect on the next landing.

## Main's result per host

Mac4 runs Xcode 27.2 with iOS 26.3; Mac5 runs Xcode 27.1 with iOS 27.1. They are not made equal: a test may fail
on one only. So a check with more than one placement keeps main's result per host
(`baseline-<slug>-t<tree>-<links>-@<host>.json`), and a candidate with failures has main (and its rerun) measured
on the host it ran on (`run_job(..., host=)`). A check with one placement keeps the old key, so existing caches
stay valid. `carry` copies each host's record forward on a docs landing.

## An unknown launch

`fabric job run` that times out with no receipt (a slow first sync, a hung ssh) may or may not have started a
job. The host stays locked and the check quarantined, and `reconcile_unknown` settles it in the background
(after 30 s, then every 60 s, for up to 30 min):

- a ledger row for `job-<name>-MMDD-HHMMSS` on that host, started since the submission: adopted as a late job,
  so the retry takes its result and the watcher frees the host;
- no row, and a tmux session of that name fabric never recorded: the session is killed and its simulator's
  app hosts ended, then the host is freed;
- nothing: the host is freed;
- the ledger or the host cannot be read: still quarantined, tried again.

A receipt naming a host other than the one asked for is never reconciled and stays quarantined until a
restart; `/health` lists it.

## A stop that could not be confirmed

`stop_job` never stops a job that already exited. It reads the ledger first: done or failed is a no-op, and
the row is the result (a late job at its cap keeps it, so the retry takes it). `fabric job stop` would mark a
finished job stopped over its done. When `fabric job stop` fails or times out, the job is read back from the
ledger (done or failed: a no-op), and then from the host itself: a tmux session that is gone is a job that is
not running, and its simulator's app hosts are ended as before.

When neither can be read (the host cannot be reached), the host stays held, quarantined, and `settle_stop`
reads it back on its own thread, after 30 s, then doubling to every 10 min, for up to 6 h:

- the ledger shows it done or failed: the host is freed, and the row is kept for the retry of the same check;
- lost, stopped, still running or not in the ledger: stopped again if needed, and freed once the host
  confirms the session gone;
- the ledger names another host, or nothing can be read: still held.

On 11-15 13:50 job-verify-motionmixapp-1115-131409 had ended with exit 0, the ledger was unreadable for the
whole late window, the stop at its cap timed out after 45 s, and Mac4 was quarantined for every lane until a
restart. With this change it is a no-op once the ledger is readable, and the host is freed then.

## Proving a placement

`verify_server.py probe BASE RECIPE --host H [--check NAME]` runs RECIPE's simulator checks on BASE's gate main,
pinned to H, in its own tree (`~/.fleet/verify/probe-BASE`), and prints executed, failing and unreached per check.
Nothing is cached and nothing is judged.

## Hosts, 2026-11-15

| | Mac4 | Mac5 |
| --- | --- | --- |
| Xcode | 27.2 (27B52) | 27.1 (27A9275) |
| iOS runtime used | 26.3.1 (23D8133) | 27.1 (24A94425) |
| MotionMixApp simulator | Foundry-MotionMixApp 49AACE36, iPhone 17e | iPhone Duo C1AB6BF6 |
| Serenity simulator | Foundry-Serenity 1C82AADA, iPhone 17e | iPhone Duo C1AB6BF6 |
| DerivedData | `~/.fleet/dd/<base>-verify` (internal, 20 GB free) | `/Volumes/FoundryBuild/fleet-dd/<base>-verify` |

iPhone Duo needs iOS 27, which Mac4 does not have, so its gate devices are iPhone 17e. Mac4's simulators were made
with `fabric job run --host mac4 --need sims` (job-verify-gate-sims-1115-085500).

Probes on gate main, 2026-11-15, Mac4: MotionMixApp ff05ffa0, 135 tests, 0 failing, the same count as Mac5's last
verdicts (job-probe-motionmixapp-1115-090601, cold build plus the simulator's first boot; Mac4 load peaked at 116).
AirDeck app dfa78a40 builds (job-probe-airdeck-airdeck-app-buil-1115-091532). Serenity's iOS check is not probed
on Mac4: it needs about 3 GB (a 1.5 GB tree, 1.5 GB DerivedData) and Mac4 had 16 GB against its 15 GB floor, so
its recipe keeps Mac5 alone until the storage lane makes room.

Order: MotionMixApp and AirDeck's app build list Mac4 first, so a check leaves Mac5's deck alone when Mac4 is
free. When Serenity's iOS check gets its Mac4 placement it lists Mac5 first: its tree is 1.5 GB and Mac4's disk is the tighter one.

## What this does not cover

- Process-local locks do not fence a second verifier process or a lane using the same simulator by hand.
- A restart forgets locks, late jobs and quarantine: restart in a gap with no running verifier job and no
  ESTABLISHED connection on :8803.
- No fairness beyond trying every free placement; sustained load on both hosts can still use up a deadline.

Lean: `lean-proofs/VerifyHosts.lean` (sections 1-4).

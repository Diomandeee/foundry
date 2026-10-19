# Cumulative validation repair review

Scope: task-start working tree at `BASELINE.json`, not a clean checkout of HEAD. Earlier implementation evidence is retained. `CHANGES.patch` and `SCOPE.json` identify this batch's delta. The final `CHANGE-RECEIPT.json` records executed results; historical failures remain in their logs.

## Repairs and their boundaries

1. Compiler and test discovery now select actual product roots instead of compiling historical source snapshots under documentation. The compiler flags and aliases remain intact. New source roots/extensions must be deliberately admitted.
2. Mixed Node/Cloudflare typings required explicit decoder defaults, safe descriptor/null handling and byte-buffer/request typing. These repairs do not weaken fatal decoding, byte limits or request redirect refusal.
3. Swift ACL calls use the actual installed SDK's enum and pointer representations. C object/helper and Swift host compilation do not prove installed signing, entitlements or VM/kernel behavior. Python validation compiles source bytes for syntax without importing or executing helpers.
4. Enrolled executors now discover pinned authority metadata through `/v1/worker/status`. The owner status endpoint remains owner-only. The worker endpoint requires a managed executor binding and reauthenticates after the body is read; general-worker calls remain fixed-route and pin/epoch checked. Edge behavior was not expanded.
5. Git absence is established with machine-readable ref/object checks. Nonexistent branches and SHA objects can be absent; corruption and wrong object types propagate errors. Gate replay cannot silently treat an unproven no-op as a successful merge.
6. Relay malformed UTF-8/JSON is classified as a fixed 400 failure without echoing supplied bytes. Cancellation and physical occupancy handling remain in place.
7. The local gate hook now persists a hash-bound verification receipt before merge. Exclusive create, no-follow open, private regular-file checks, exact byte readback and fsync preserve evidence and refuse corrupt collisions. Independent review caught lossy UTF-8 readback; this was replaced with byte equality and a specific regression. This is a trusted local hook store, not a kernel-sealed store resistant to its own UID.
8. The demo uses a fresh owned temporary root or exclusively creates the explicit destination. It refuses existing destinations and duplicate root flags. Initial validation encountered the legacy fixed-root reset; `FINDINGS.json` records that incident without asserting the prior fixture was preserved. No original project was used as that fixture.
9. The new `tools/foundry-build-pilot` entrypoint assembles the real controller, isolated adapter, liveness, authenticated transport and scoped SQLite/GCS broker boundaries. Configuration is bounded inert data with independent reference names and explicit approval markers. It attempts one exact job, retains ambiguous state, and never installs resources, reclaims a slot or launches a repeat loop.
10. Independent launcher review identified target verification after finalization and database opening before exact claim admission. The strict `/v1/builds/verify-target` endpoint now binds environment, authority, job, attempt and epoch before mutation/read/replay and at final commit. The client verifies the returned source. The legacy verify endpoint remains compatible; the pilot uses the stricter route. Storage now checks complete controller-branded claim policy before any open, separates input/publication initialization, checks cancellation around each awaited open and retains failed initialization.

The independent reviews are `VALIDATION-FIX-REVIEW.md` and `LAUNCHER-SOURCE-REVIEW.md`. Their original findings and fingerprints remain historical; final addenda give the reviewed repair disposition. Parent additionally traced the strict server target path and read the launcher source and assembly tests. No review is represented as an operating-system containment test.

## Six verification layers

| Layer | Evidence and limit |
| --- | --- |
| Structure | Actual repository/branch/base, dirty-work preimages, scoped hashes/diff, exact entrypoints and route updates |
| Compilation | Root TypeScript, Swift/C native outputs, Python source syntax; executables not installed or invoked |
| Integration | Local workerd HTTP, actual SQLite authority, real controller/broker/provider-adapter composition with synthetic physical/network boundaries; whole-suite logs |
| Content | Exact bytes/digests, target identity, role/epoch/revocation, claim admission, cancellation, receipt persistence and no-overwrite regressions |
| User journey | Usability proof and fixture gate demo; submission/transport and one-attempt assembly tests. No browser-driven fleet or real project build acceptance |
| Deployment | No deployment or activation. Read-only fleet/GCP facts and conditional runbooks only; actual host configuration and matching approvals remain required |

## Remaining boundary

The local candidate supports one bounded Linux attempt and an owner-mediated Apple Silicon VM attempt, within the documented file/output limits. It does not supply automatic Linux repeat-attempt reclamation, unattended Mac image staging/intake, direct native-host Xcode, arbitrary network dependency fetching, signing/release, full project recoverability, original-copy deletion, or K11 execution enrollment. G3 strict-verifier policy remains an owner choice. Existing target schema/migration and rollback compatibility require real target inspection before deployment.

`ACCEPTANCE-MATRIX.md` is the explicit remaining acceptance ledger. `ACTIVATION-READINESS.md` supplies source-derived conditional procedures and approvals; its launcher-gap observation is superseded only by the current launcher implementation and final review, not by installation evidence.

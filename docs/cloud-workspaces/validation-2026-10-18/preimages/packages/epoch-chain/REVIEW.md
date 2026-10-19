# Initial core verification receipt (historical)

This receipt describes the initial42-test core before parent ID/retry fixes and schema-v3 audit evidence. Final package result is53 tests; see REPORT.md and API.md. Current delivery has no lifetime retry cutoff, and current historical authorization evidence has2050 reserved immutable records. Whole-repository results belong to the integration home’s evidence/stacks-dispatch/VERIFICATION.md.

Owned changes: this package only. No commit, deployment, paid action, secret,
network access, or actual compute/HTTP dispatch. Existing dirty files elsewhere
were preserved. Parent owns dispatcher, decoder association checks and workerd
acceptance. This package supplies an authenticated-host domain API, not transport.

Checks executed locally: 42 real Node SQLite tests passed; repository TypeScript
no-emit check passed after the implementation. Tests include disk reopen, stable
IDs/replays, flags-only duplicates, conflicting immutable facts, missing parents,
explicit immutable root, stale revision, same-height/lower forks, Bitcoin path and
anchor constraints, tenure/confirmation policy boundaries, source quarantine,
before-send suppression, post-submit cancellation, delayed response compensation,
recanonicalized generations, leasing/CAS/expiry/retry bound, storage/schema bounds,
and fault injection rolling back projection plus outbox.

Six local verification passes:

1. Structure: package/API/index/core/tests exist under the exact owned directory;
   relational scalar metadata, immutable header/event rows and individual mutable
   generation/intent rows use only epoch_chain_ names. No whole-state blob.
2. Compilation: no-emit TypeScript check passes with the existing repository.
3. Integration: same synchronous atomic transaction port as inbox/compute; exported
   signatures include read/claim/retry/ack/markSubmissionResponse/markSubmitted,
   metadata, getEvent and bounded snapshot. Parent integration still needs its
   real workerd/runtime and end-to-end dispatcher verification.
4. Content: immutable normalized indexed/plain ancestry; provider flags advisory;
   exact checkpoint Bitcoin path and derived confirmations. This trusts the
   reconciler's attestation of anchoring, with no PoW/SPV/consensus claim.
5. Journey: observation -> owner bootstrap -> reconciliation -> lease -> response
   -> reorg/cancel -> recanonicalization, with real SQLite restart/fault tests.
6. Deployment: intentionally gated; no deployment, migration, execution, remote
   calls or physical-stop/exactly-once proof is claimed.

Contrarian checks addressed: a completed first cancellation cannot cover a later
submit response, so late-response compensation has its own intent/command key;
mutable provider flag changes cannot quarantine; full-state JSON could exceed
workerd per-row limits, so rows are normalized; capacity must not prevent safety
withdrawals, so each generation reserves up to three intents and generation
exhaustion suppresses new grants while still permitting cancellation/quarantine.

Limits: 512 headers, 256 event refs, 1024 generations, 3072 intents and <=60s delivery leases (the initial100-attempt
cutoff was removed; current delivery has no lifetime attempt cutoff); no pruning/migrations or production
retention policy. Header/event bodies <=2048 bytes per row. Snapshot pages derived
history (64 generations/100 intents); readIntents pages all intents in ordinals.
Snapshots and reads hydrate bounded stored rows; not optimized for unbounded
history. Trusted host must enforce template allowlist/read-only semantics and
independent expected result digest, preserve exact compute request replay, handle
quota/reservation admission, and authenticate successful submission/cancel replies.
Node crypto compatibility is required in workerd adapter. Lease expiry and a
logical cancellation receipt never establish physical stop or release budget.

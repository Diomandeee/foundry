# Compute authority reference — owner review candidate

This package is an in-memory sequential protocol reference. It is not a deployed compute service. Restart loses workers, jobs, reservations, receipts and audit. Native worker isolation, authenticated enrollment/transport, durable storage and projections, remote pilots, and UI remain unimplemented. The existing merge gate is unchanged and remains the sole merge authority.

## Reference API changes

- `registerWorker(id, slots, workerClass, resources?)` requires an explicit class. Existing IDs cannot switch class. Edge class can never claim, including malformed numeric requests. Trusted control-plane code owns enrollment decisions; the explicit class is not an authentication credential.
- `submitWorkload(id, slots, replayPolicy, maxAttempts, policy, resources?)` requires an intake content-hash policy. The identity digest covers these reference intake fields; it is not the future complete compute.v1 contract. Same identity/content returns current original state; conflicting content rejects. A committed identity never reopens.
- CPU/RAM/individual GPU reservations are checked together before issuing a lease. Without explicit vectors, legacy reference capacity is CPU=slots, RAM=0, GPU=none; a memory/GPU job requires explicit resource capacity and demand. Whole GPU devices are exclusively reserved; independent devices are never pooled. Placement remains a separate pure function, not a durable scheduling/admission integration.
- `requeue(id, expectedGeneration, requestId)` rejects stale generations and deduplicates accepted requests. Replaying an old request cannot fence a replacement. Fencing quarantines all execution on that worker until trusted stop reconciliation; expiry is not physical process termination.
- `expireLeases()` audits expiry, revokes leases, advances safe-retry workloads within attempt caps, and quarantines workers. It is also invoked on claim, renewal, completion and live reads. There is no daemon/timer in this package. Server time is monotonic within this instance only; restart/epoch recovery requires durable work later.
- Completion uses the immutable intake policy and an owner-injected artifact reader. It computes the digest over actual bounded bytes and checks it against the stored expected digest; caller policy overrides reject. An immutable in-memory receipt binds workload/attempt, artifact reference/hash, byte count and policy digest. Identical completion returns its existing receipt. No persisted artifact pointer is claimed.
- `OutboundAgent.reconcileAfterStop(incarnation)` is a trusted adapter hook after independently confirmed stop. It refreshes the agent fence. This method does not itself stop or authenticate a worker.
- `snapshotFor(authority, registry)` uses authority-owned audit, includes quarantine/incarnation/reconciliation, and reaps expiry before taking the snapshot. It remains a partial read model: no deployed route, complete queue/attempt/placement API, UI or D1 projection.

## Disposable executor boundary

`execBounded` no longer accepts arbitrary argv, script files, cwd or environment from a job. It accepts only the pinned immutable `reference-cpu` calculation. The trusted host supplies a canonical Node executable, managed directory, authorization callback, and optional in-memory stdout staging callback. Unknown fields, changed pins, missing authorization, invalid bounds, and staging failures fail closed. Actual stdout bytes can flow to a separately injected reader in a local journey test.

This is a fixed local safety repair, not a general template system or native worker profile. There is no sandbox or enforced filesystem/egress isolation. POSIX process-group cancellation does not contain escaped sessions; Windows cancellation is child-only and has not been validated here. No real workers were installed or run by this repair round.

## Verification and remaining limits

The owner review packet beside this task records the exact base, patch, hashes, 115 passing package tests, 342 passing repository tests, typecheck, usability and disposable gate demo. Existing tests were retained and migrated where the former API was intentionally unsafe. New regressions cover the eight follow-up counterexamples, scalar validation, capacity vectors, stale requeue delivery, reconciliation, snapshot consistency, and actual-byte execution-to-commit.

Audit is coupled to synchronous reference mutations and redelivers until prefix acknowledgement. It is not a durable transactional outbox; no crash rollback, retention bound, persisted authority epoch, or storage concurrency claim is made. Maps and audit history grow with admitted work. The artifact reader and host callbacks are trusted in-process configuration, not worker payloads. Result fencing guarantees neither exactly-once physical execution nor authorization across a network.

Stop at owner review. Do not implement storage, transport, enrollment, platform templates/profiles, pilot or UI from this candidate without the next review decision. Do not commit, push, merge, deploy, provision, rotate secrets, install host agents, or touch other training/database lanes.

# Build authority — local candidate, validation pending

This additive package runs on the existing compute Durable Object's synchronous transaction port and shares its epoch/worker/enrollment state. It does not replace legacy exact-output verification, start a server, enable transport, issue raw worker credentials, provision storage or merge code. New build tables and routes initialize only when `COMPUTE_BUILDS_ENABLED=true` and managed enrollment is enabled. Neither was enabled here.

## Contracts

- `approveInput`: owner supplies project, exact immutable manifest, snapshot hash, optional safe Git lineage, required/missing inputs, and explicit reconstructability approval. Unknown/missing inputs cannot silently become reconstructable.
- `approveProfile`: owner selects `linux-build-v1` or `xcode-build-v1`, structured recipe, CPU/RAM/disk/time/output limits, required output paths, trusted-project policy and mandatory explicit worker opt-in in this pilot.
- `approveWorker`: owner binds `{workerId, revision, profileHash, preference}`. Preference is 0–100; higher eligible preference wins, then lexical worker ID. Initial operator-host priority should be lower; machine names never appear in scheduling logic.
- `census`: enrolled executor sends monotonic `{workerId,sequence,os,architecture,freeBytes,availableRamMib,xcodeBuilds,sdks,macos,optedIn,activeJobs}`. Stored reports bind the enrollment revision/incarnation; a replacement credential needs its own census. Reports are observations, not owner-approved physical capacity or an isolation guarantee. Freshness is 30 seconds; minimum accepted new-report spacing is one second.
- `submit`: `{id,projectId,inputHash,profileHash,maxAttempts}`. No browser argv, URLs, paths or recipes. Inputs and profile must already be approved and share the project.
- `claim`: `{jobId}` from the chosen eligible enrolled worker. Returns approved job/input/profile and a scoped attempt capability. No plaintext capability is persisted in command history or returned in feed.
- `renew`: exact attempt fence plus next sequence; 60 seconds, clipped to absolute profile cap (at most one hour). Latest renewal replay is idempotent; historical sequence reuse cannot extend liveness.
- `stopped`: exact fence, proof digest, actual outcome and confirmed status. An executor reports its actual trusted runtime proof; this is not a server measurement of a process. Uncertainty retains host occupancy. Owner `reconcile` is explicit evidence acceptance for a retained slot.
- `stage`: exact live fence and an issued broker claim for a result manifest. Requires confirmed stop; returns `verified:false`.
- `cancel`: explicit owner job cancellation, not evidence that a process stopped. `requeue`: explicit failed-generation retry after stop reconciliation and within max attempts.

Every command uses `{operation,key,body}` under `{expectedEpoch,command}`. Full JSON is inert/canonical and byte-bounded by the HTTP wrapper. Durable evidence keys are principal/operation/key scoped; changed request content conflicts. Census and renew use bounded latest-head replay storage instead of consuming lifecycle command capacity. Safety-recovery commands have a separate path past normal journal saturation; their accepted transitions are bounded by retained attempts/jobs. Expiry/high-water maintenance commits before the requested operation so rejection cannot revive an expired lease via clock regression.

## HTTP endpoints

All require HTTPS POST and existing authenticated identity. Actors come from host policy or managed enrollment, never body claims. The wrapper reauthenticates after streaming request bodies; verifier/output reads recheck after awaited broker I/O.

| Path | Body beyond `expectedEpoch` | Role |
| --- | --- | --- |
| `/v1/builds/commands` | `command` | Operation-specific |
| `/v1/builds/next` | `profileHash` | enrolled executor |
| `/v1/builds/feed` | `after` event sequence | owner |
| `/v1/builds/preview` | `profileHash,inputHash` | owner |
| `/v1/builds/fence` | `attemptId` | owner/private broker observer |
| `/v1/builds/verify` | `attemptId` | independent verifier |
| `/v1/builds/result` | `jobId` | owner |
| `/v1/builds/result-log` | `jobId,logIndex` | owner |
| `/v1/builds/result-chunk` | `jobId,outputIndex,chunkIndex` | owner |

Feed is bounded to 128 records/family and a shared 192 KiB / 12,000-node row budget; `windows` reports actual returned/total/truncated counts. It is not complete history or a canonical catalog. Attempts include effective expiry state even before command maintenance commits. Activation/validation are not inferred from a response.

## Artifacts and verification

All objects are content-addressed project objects/manifests with positive decimal string generation, SHA-256, size and issued grant ID. Individual broker reads are at most 1 MiB. Output files contain explicit file/tar format, bounded chunk claims, full-file hash and length; approved .app/.dSYM/.xcarchive paths are deterministic tar artifacts, not silently treated as regular files; initial portable profiles permit at most 7MiB across outputs/logs and 24 required output paths; aggregate result chunks are at most 31, plus one manifest (32 grants), constrained further by actual approved durable broker namespace capacity. Result manifest is at most 1 MiB. No grant, generation, provider URL or quota is invented.

The verifier reads actual bytes through server-only `BUILD_BROKER_ORIGIN` and opaque `BUILD_BROKER_CREDENTIAL` binding. These are proposed configuration names, not provisioned secrets. The broker's `/v1/broker/build-read` role is verifier and binds principal, project, worker, attempt and exact reference to a stored grant before existing accounting/read/revocation checks. A configured broker must have real current build authorization and durable quotas, not the legacy workload lookup or an ephemeral observation cache.

Verification requires complete approved output set, successful reported exit, actual chunk/full-file integrity, input/profile/job/attempt lineage, separate submitter/executor/verifier identities, and fences rechecked after I/O. This is build-artifact acceptance, not a claim that app behavior, signing, tests or supply chain are independently proven. Artifact reads fail closed without a configured private reader. Success receipts survive as immutable lineage; retained output access must still have a valid scoped grant/current policy.

## Host/runtime boundaries

Portable owner profile hashes differ from local runtime digests that include account/filesystem/isolation policy; both must be pinned. Linux enforces container boundaries; native macOS execution requires trusted projects and a dedicated account, and lacks Linux cgroup-equivalent hard CPU/RAM isolation. No killed process group is promoted to native descendant proof. Missing containment evidence quarantines. Host configuration, SDK/dependency installation, network policy and physical stop observations remain separate approval/validation gates.

Source-only review is documented in `docs/cloud-workspaces/`. No tests, builds, typechecks, services, provider requests, installs, deployment or secrets changes were run for this package.

Claim history/events retain a pre-allocation candidate/rejection snapshot with reasons, policy, preference and observed facts. Effective read state can show expiry/fencing before maintenance changes the recorded state; neither is a physical stop proof.

# Foundry cumulative source review and repairs — 2026-10-18

Local implementation and source review only. This batch does not validate or activate a worker. The single current route is ../ROUTE.json; earlier batch folders and their evidence remain frozen.

## Review scope and provenance

The candidate is the shared dirty integration branch `codex/foundry-integration-20261016` at `cf27ac662730bb98a509af8d1d1ebea4342eef7a`. All 84 hashes from the previous Linux scope matched at capture. Six independent reviewers covered security/input, concurrency/resources, API/types, platform dependencies, performance/bounds, and operator readiness. S1 deduplicates the packed-input finding; a separate contrarian challenged it and the repairs. Parent integration review covers inherited gate dispositions and route accuracy. This is bounded review, not a claim that every file in the repository has independently passed.

Read S1.json, ROUND1-*.md, CHALLENGES.md, the bounded repair reviews, FINDINGS.json and CHANGE-RECEIPT.json. Historical findings are retained in INHERITED-FINDINGS.json. New source is attributed to this batch against preserved preimages, not against a clean tree that never existed.

## Implemented changes

### Linux filesystem and execution boundary

The broker now requires Docker CLI and Engine 25+, actual daemon user-namespace remapping, and an empty container UsernsMode (daemon default). It no longer opts out with `--userns=host`. Root policy separates nonroot container `buildUid/buildGid` (1000–65535) from actual subordinate `mappedBuildUid/mappedBuildGid` (65536–2147483647) used for work/source ownership. Installation must establish the real mapping; no account, subordinate range, daemon configuration or image was changed here. A mismatched mapping is not automatically repaired.

The additional include-free AppArmor source is `packages/build-runtime/native/foundry-linux-build-v1.apparmor`. It denies ptrace access, capabilities, mount changes and proc/sys writes while preserving inherited execution. Root preflight checks exact installed source bytes, enabled module, global enforce mode, root policy namespace, ptrace feature support, selected profile enforce mode and its kernel-exported compiled-policy hash. The required `apparmorCompiledSha256` is an owner-approved installed-payload reference, never a fabricated source hash. Docker explicitly selects this profile and the broker checks its reported selection before start.

AppArmor alone was rejected during independent review: its target-side incoming checks can skip an unconfined accessor. User-namespace separation is therefore required to close that host accessor path. Root administrators, the daemon and kernel remain trusted. No claim of hostile-root isolation is made.

After permanent cgroup containment and stopped-container observation, capture requires remounting the entire dedicated ext4 filesystem read-only. The broker checks device identity, statvfs readonly state and the ext4 superblock readonly options in mountinfo. A bind-only readonly flag is insufficient. Outstanding writers, remount errors or ambiguous state block capture/publication and retain resources.

Actual cgroup domain type, writable kill/freeze controls and empty initial events are checked before launch. Unauthorized socket peers are rejected without consuming the sole authenticated attempt. The attempt journal is created immediately after the durable slot, before cgroup setup; later failures record fixed operation codes and actual containment/capture flags where the journal remains writable. Missing evidence is never promoted to success.

### Capacity and large inputs

Host bytes and inodes are checked before slot creation. Source-copy profiles also use a conservative image bound before reservation and actual available work-filesystem blocks/inodes after formatting, before streaming. ext4 block/inode parameters are explicit. This is not exact per-project free-space forecasting: `source_dirs=min(65536,files*31)+1`, `source_inodes=files+source_dirs+128`, `source_bytes=inputBytes+(files+source_dirs)*4096`; source-copy admission requires `source_bytes+source_inodes*256 <= maxWorkBytes*7/8`. Thus 8,192 empty flat files produce an approximately 306 MiB bound and are refused by a 256 MiB image's 224 MiB allowance. A larger already-approved image or a smaller project is required; no disk is enlarged automatically.

Native collision handling now uses bounded folded file/directory/component indexes, including original spelling, instead of scanning every earlier path. Packed-input streaming groups files sharing a final object and retains that object across other chunks. Retained cache is at most 1 MiB; cache plus current data object at most 2 MiB, excluding metadata and transport encoding. Read count is bounded by one root plus segments plus declared objects, within the unchanged 8,705-operation ceiling. All reference, content, range, lease and final broker checks remain.

The shared publisher now passes only its actual writer/issuer/capacity route, fixing the source-level excess-property mismatch introduced by narrowing that interface. No compiler result is claimed.

### Mac accounting and operator recovery

Mac CAS provides fresh root-authenticated, nonce-bound accounting of actual private object bytes and partial creates. Installed startup hashes must match client pins. Bounded scans and serialized physical client occupancy prevent a logical deadline from releasing a still-running operation. The VM factory and liveness share the same installed store identity. Accounting combines with controller-managed caches; missing, stale, unsafe or incomplete results remain unknown/incomplete and cannot be reported as zero. Counts are apparent retained bytes, not reclaimable space.

The operator now lists at most 64 durable submission intents independently of worker placement. Existing-intent recovery accepts only the original request/job/selection/epoch/key/body and can replay only that identical pending authority command. It never allocates an intent, alias or attempt. Acknowledgement is submission receipt, not successful build evidence. Credential, profile, epoch, session and CSRF boundaries remain.

For failure before an intent was persisted, a separate same-page retry reuses the unchanged original request/job/selection/repeat flag. It does not create replacement IDs. After reload, only durable intents are recoverable; no browser persistence of private state or credentials was added.

## Supported scope and remaining gates

The Linux adapter remains one owner-mediated attempt, retaining its slot, socket, disk, cgroup and evidence. Automatic reconciliation/reuse/reclamation is unsupported. Mac VM staging/intake remains explicitly owner-mediated. K11 Craft remains carried external context; not enrolled and no natural-canary completion inferred.

No tests were authored or run. No compiler, typecheck, lint, build, executable product import/probe, helper/VM/container/service, installation, mount, provider call, provisioning, spend, credential change, commit/push/merge, deployment, publication or cleanup was performed. Evidence consists of source review, public primary documentation, local edits, diffs and byte hashes.

M4/R6 compilation/tests/operational acceptance remains the next approval boundary. Installation/provisioning/policy changes and R7 progressive activation retain their separate approvals. G3 strict verification policy choice, existing-database migration, actual images/accounts/installed pins/mappings, project completeness and Mac headroom are still prerequisites. Source review cannot establish that the whole fleet is operational.

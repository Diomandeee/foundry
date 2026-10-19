# Source review — six inline passes

Reviewer: implementing Codex agent. These are six distinct inline source passes, not six independent reviewers. No compilation, static-analysis execution, test or operational acceptance was performed. Independent cumulative acceptance remains open.

## 1. Structure and contract pass

Traced the factory through authenticated controller claim, branded context/reservation, verified source streaming, concrete adapter, supervisor stop callback, real publication and stage command. Removed legacy Linux implementation and denied both public legacy methods; controller rejects arbitrary Linux adapters. Checked exports and corresponding Python/TypeScript protocol fields by source reading. Refactored the existing object reader without changing its capacity/grant semantics or inventing a local store. Publication's `publish` parameter now names only the three ports it actually uses; existing callers remain structurally compatible.

## 2. Filesystem and privilege pass

Addressed shared-UID materialization by moving input/work/capture operations under a root-private namespace and a separate build UID. Fixed-size preallocated ext4 bounds writes; source/metadata/capture overhead is included in admission. Docker socket is inaccessible to controller/build. Owner profile supplies all executable/recipe fields; only hashes, relative source paths and bytes cross the request boundary. Exact canonical paths, ACL checks, no symlink ancestors, create-only files, collision/component budgets and explicit no-cleanup behavior are present. Durable event appends handle short writes before acknowledging physical actions. Removed old reflective private launch methods rather than leaving a disabled public wrapper around callable unsafe code.

## 3. Lease, crash and termination pass

Counterexample: killed attach client may leave a delayed daemon start. Repair: root-owned persistent ancestor cgroup, permanent freeze, cgroup.kill and empty/frozen observation; no thaw or task-migration method exists. Each phase requires stopped Docker identity plus empty cgroup before the next. Counterexample: root broker dies while Docker keeps running. Repair: separate-session watchdog, inherited-pipe EOF, bounded protocol, BOOTTIME deadlines and retained root slot. Counterexample: late watchdog pulse revives an expired budget. Repair: check the prior deadline before processing it. Counterexample: malformed watchdog data exits without containment. Repair: error path also freezes/kills. Counterexample: computing hrtime after remainingMs extends TTL under scheduling delay. Repair: capture hrtime first and add the later floored remaining duration. Missing/uncertain acknowledgement remains quarantine, never inferred stop.

## 4. Input, artifact and authority pass

Both metadata versions bind actual manifest generation/hash to job inputHash, Git fields and required inputs. v2 uses existing segment/range/coverage validation. Streamed files are independently hashed on both ends. A single cached blob remains private and bounded; final existing receipt/fence checks precede launch. Outputs require actual successful exit, permanent containment, root capture and controller byte verification. Empty files are hashed correctly and create no zero-byte cloud object. Real scope, durable reservation, actual writer generations and actual issued/current grants remain mandatory. No accepted-upload-to-verified-build promotion was added.

## 5. Capacity, interruption and operator journey pass

Client process occupancy remains until close, including deadline/abort failure. Frames, source files, image size, outputs, logs, paths and metadata scans have explicit limits. Census now includes private storage; stale/unreadable/partial data blocks idle admission. Corrected a topology conflict: applying the 50 GiB workspace reserve to the planned 30 GiB OS disk would reject every job. The broker supplies actual workspace-disk headroom, while controller metadata storage separately requires 64 MiB. Fixed resume behavior is owner reconciliation with retained bytes, not retries. Walked the source journey: choose approved project/revision/recipe -> existing authority placement/claim -> new isolated preparation -> execution/attempt -> immutable artifact stage. Existing views continue consuming authority rows; no installed/validated/activated badge is earned by code presence.

## 6. Contrarian and governance pass

The source does not prove this works on a provisioned Ubuntu/Docker host. In particular, actual cgroupfs paths/controller delegation, delayed Docker starts, watchdog survival under service-manager teardown, ext4 loop mounts, same-clock assumptions, large transfers, grant expiry and platform binary metadata require approved acceptance. The one-attempt pilot retains all root resources even after success; unattended reuse/cleanup is absent and is disclosed. Existing adapter-injection tests will need migration after test authorization. No operational host or cloud commands, tests, installs, secret changes, commits or cleanup were used to make the candidate look complete.

## RTD status

Structure: source reviewed. Compilation: not run, gated. Integration: source call graph reviewed, runtime pending. Content: claims/limits/receipts reviewed. User journey: handlers traced, not exercised. Deployment: not performed or approved. All six require their appropriate later evidence before an operational completion claim.

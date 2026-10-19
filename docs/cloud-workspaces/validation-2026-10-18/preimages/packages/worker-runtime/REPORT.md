# Bounded worker runtime implementation

Scope: ONLY source/packages/worker-runtime. Created with mkdir at the exact authorized directory. No enrollment-worker, parent-compute, transport, root manifest, lockfile or authority changes. No background dispatch, cron, accounts, credentials, remote host actions, installs, image pulls/builds, Docker activation, deployment, commits, pushes or merges were performed.

## API delivered

See API.md and src/index.ts: validateProfile, buildPlan, WorkerRuntime.runBoundedJob, WorkerRuntime.stopEvidence. RuntimePort is injected separately from NodeCliAdapter; staging is independently injected. No bearer field enters the runtime. Host must authenticate the approved specification and bind the current durable lease epoch/generation/incarnation. Durable lease expiry/cancellation still quarantine reservations; this package never calls reconcileStop or releases capacity.

Host allowlisted digest and resource profile are frozen and provenance checked. Plan commands are deterministic, shell-free, with no host mounts, arbitrary commands, URL inputs, devices, GPU requests or inherited secrets. The fixed summary image contract selects /usr/local/bin/node and /opt/foundry/event-summary.cjs; source is included as image-handler.ts. A locally preloaded, owner-vetted image is REQUIRED. No fabricated usable digest/default profile is shipped.

Create flags include pull=never, runtime=runc, network=none, read-only, nonroot UID/GID, explicit unprivileged mode, private cgroup namespace and IPC, all capabilities dropped, no-new-privileges, CPU/RAM/swap/PID/tmpfs/shm/nofile/core bounds and disabled container logging. Daemon preflight rejects unsupported Linux/cgroup-v2 resource controls, missing builtin seccomp, or warnings. Image metadata rejects declared volumes and mismatched digest. Docker adapter is inert without allowActivation:true and a canonical local executable/socket.

Host staging requires an existing absolute canonical owner-private root, no symlink components/traversal, protected ancestors, free-space reserve, exclusive identity directory, private unique run directory and durable marker. Markers persist across runtime instances/restarts; no automatic cleanup or unsafe replay. No host staging path is mounted. Failed reservation/ENOSPC performs no process operation. A trusted same-UID host administrator and daemon remain inside the trust boundary; path checks are not a sandbox against a hostile administrator.

Process identity binds leaseId/epoch/generation/incarnation, a deterministic name/label and full 64-character container ID. Duplicate identity admission fails closed. Stop cannot attest during activation. On interruption, Docker kill is followed by fresh inspect; mismatched IDs, failed kill, failed inspect, unavailable runtime and ambiguous delayed starts retain unknown stop. CLI exit or cancellation alone is never stop evidence. Output is returned only after actual-byte hash match, zero inspected exit, and stopped evidence; partial/error streams are discarded. Errors expose fixed codes, never daemon text or bearers.

## Exact final validation

Executed from /Users/mohameddiomande/Developer/foundry-integration/source:

1. `node_modules/.bin/tsc -p packages/worker-runtime/tsconfig.json` — PASS, strict:true plus exactOptionalPropertyTypes, no emit.
2. `node_modules/.bin/tsc --noEmit` — PASS, repository strict compilation including adjacent current work. This is a point-in-time check, not ownership of adjacent edits.
3. `node_modules/.bin/vitest run packages/worker-runtime/src packages/epoch-jobs/src --cache=false` — PASS: 3 files, 100 tests. Worker-runtime contributes 35 tests (24 runtime/plan + 11 Node/staging/process); existing epoch-jobs contributes 65.

An initial attempt also enabled noUncheckedIndexedAccess, which surfaced existing unchecked indexing in epoch-inbox and epoch-jobs outside this lane. That additional option was removed; TypeScript strict remains enabled. No adjacent code was changed. Final compile commands above passed after fixing local Node/Workers type collisions.

Worker runtime coverage:
- Immutable deterministic branded plans, exact schemas/accessor rejection, fixed argv and resource limits; unpinned/unallowlisted images, arbitrary command/mount/URL/env fields, edge worker, malformed/path-like lease identities, wrong workload, invalid specification, forged profile/plan and unsafe CLI commands reject.
- Injected Docker port: actual pure-summary bytes and output hash; missing daemon, unsupported security, image volumes, duplicate activation across instances, injected disk pressure, midrun interruption, in-flight cancellation, stale process identity, stale incarnation, failed kill, failed inspect, ambiguous create, delayed start, partial/oversize/truncated/nonzero output and preaborted admission.
- Actual local filesystem: private staging permissions and unique directories, persistent identity reservation, relative/traversal/NUL/noncanonical paths, symlink root/ancestor, readable root, writable ancestor, disk reserve denial and racing exclusive reservation.
- Actual disposable benign OS children: timeout kill, cancel kill with PID absence checked after close, independent stdout/stderr overflow termination, missing executable, preaborted spawn, clean environment and inactive Docker gate.
- Fixed image-handler source exercised as an actual benign local Node child: approved summary bytes exactly match epoch-jobs; malformed bearer-like input emits only summary-rejected and exits 1. No Docker process is invoked by these tests.

## RTD evidence and remaining gates

Structure PASS: exact package paths, typed API, separate Node adapter, fixed image entrypoint source, tests and this report; ls verification performed.
Compilation PASS: package and repository strict no-emit commands above.
Integration PASS (local): real epoch-jobs producer/handler/validation plus fake Docker port, existing epoch-jobs durable integration tests, OS child and staging adapters. Parent authenticated transport/enrollment integration remains outside scope.
Content PASS: command flags and fail-closed adversarial cases tested; no live image claim or placeholder default image.
User journey PASS (local): build approved plan -> exclusive staging -> daemon/image checks -> fake create/start -> fresh output validation -> runtime inspect stop evidence. Actual fixed-handler subprocess separately tested. This is not a container journey or fleet journey.
Deployment NOT ATTEMPTED, explicitly gated. Actual container isolation is UNVERIFIED: no Docker executable, daemon, image or container was activated/inspected here. Owner must vet/build/preload the fixed image, allowlist its real digest, validate the local daemon/security/resource semantics and perform an explicitly authorized real container kill/isolation drill before enabling this adapter.

Limits: attachment timeout is 1..30000ms; each control CLI call is separately capped at 5 seconds/64KiB per stream. Kernel/daemon stalls and abrupt host crashes cannot be claimed physically stopped by this library. Runtime history is capped at 1024 identities per instance; persistent markers require explicit host retention/recovery policy. It supplies bounded execution plans and conservative evidence, not durable enrollment, remote deployment, full-fleet connection, artifact publication or authority reconciliation. Docker runtime security semantics remain operationally unverified; no runtime/account network access or web lookup was performed.

## Runtime security repair receipt (2026-10-16)

All four requested findings repaired within this package only. Existing APIs
WorkerRuntime/validateProfile/buildPlan are unchanged. NodeCliConfig adds REQUIRED
privateConfigPath; parent/client owners must provision and pass the empty private directory
before activation. This is the integration handoff; no adjacent package was edited.

- HIGH1: corrected daemon wire key to CpuCfsQuota. Official-contract fake uses the wire
  name and null warnings. Tests accept null/empty warnings and reject wrong-case-only quota,
  false quota, missing/malformed/nonempty warnings, and null/empty/malformed security collections.
- HIGH2: explicit fixed --config directory on every command, canonical trusted ancestry,
  current-UID ownership, mode 0700 and zero entries. No fallback config, contexts or plugins.
  Synthetic proxy-sentinel test checks selected config at the captured process boundary;
  no real credentials/config files are read. This test is not a real Docker behavior proof.
- HIGH3: shared path validation checks every ancestor including filesystem root for trusted
  root/current UID, directory type, no symlinks and no group/world write. Sticky writable
  paths reject too. Executable/socket owners and writable bits checked; config/staging
  leaves private. Synthetic ownership tests cover other-UID 0755, root, writable/sticky
  ancestors, socket ownership and leaf symlinks. Existing actual-filesystem tests pass.
- MEDIUM4: synchronous copies of args/stdin/limits/signal before first await, original
  branded-create validation retained. Async caller mutation regression verifies captured
  process arguments and options remain the validated originals.

Validation performed using existing dependencies, no install:
- `node_modules/.bin/tsc -p packages/worker-runtime/tsconfig.json`: PASS.
- `node_modules/.bin/vitest run packages/worker-runtime/src packages/epoch-jobs/src --cache=false`:
  PASS, 4 files / 125 tests (original 100 plus 25 regression cases). Output: test-results.txt.
- `node_modules/.bin/tsc --noEmit`: FAIL in adjacent worker-client at src/index.ts:52
  (RequestInit credentials type) and :62 (TextDecoder ignoreBOM type). These are outside
  the authorized write boundary and were left untouched. Package strict compilation passes.

RTD: Structure PASS (exact package, API/source/tests/report); Compilation PASS for package,
repository compilation blocked by the two adjacent diagnostics above; Integration PASS for
local existing epoch-jobs and fake ports, parent/client config wiring remains a handoff;
Content PASS (official wire shape, config selection, ancestry and mutation regressions);
User Journey PASS for local fake lifecycle and benign existing children only.
Deployment NOT ATTEMPTED. Actual Docker/container isolation remains UNVERIFIED.

Trusted-administrator boundary: root/current UID and local daemon must not mutate or
replace validated objects during use. These pathname checks reject untrusted owners but
cannot promise race safety against trusted administrators. No Docker executable/daemon,
real credential, accounts, deployment, installation, cloud/spend, commit/push/merge,
background dispatch or external messaging used. All writes, including test fixtures/output,
were inside worker-runtime; no other worker changes reverted.

Primary sources reviewed directly (contract evidence, not live runtime evidence):
- https://raw.githubusercontent.com/moby/moby/master/api/types/system/info.go
  (CPUCfsQuota JSON tag CpuCfsQuota; slice fields SecurityOptions and Warnings).
- https://raw.githubusercontent.com/docker/cli/master/cli/config/config.go
  (home lookup fallback and explicit config directory selection).
- https://raw.githubusercontent.com/docker/cli/master/cli/command/container/create.go
  (configured proxy environment merging).
Also read parent evidence/fleet-enrollment/RUNTIME-PRIMARY-SOURCES.md. Earlier validation
and no-web statements above describe the original implementation, not this follow-up.

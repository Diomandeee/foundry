# Worker runtime API

Host-only dependency injection. No transport, credentials, enrollment, authority mutation or automatic reconciliation.

- `validateProfile(config, imageAllowlist)` returns a deeply immutable, provenance-checked `ExecutionProfile`. All config is host-owned; no default image or live profile is shipped.
- `buildPlan(profile, job)` returns an immutable `ExecutionPlan`: deterministic Docker create argv, fixed image handler, bounded stdin, expected output hash, and identity. Job is exactly `{workerClass,leaseId,epoch,generation,incarnation,workloadId,specification}`. Edge rejects before process/filesystem calls. Parent must authenticate/bind the approved specification and current lease; no capability enters this API.
- `new WorkerRuntime(profile, RuntimePort, StagingPort)` provides `runBoundedJob(plan, signal?)` and `stopEvidence(identity)`. Profiles/plans cannot be forged across the boundary. One exclusive host marker per identity prevents repeat activation across instances/restarts. A failed/ambiguous activation remains reserved for operator reconciliation.
- `RuntimePort.execute(argv, {stdin,maxBytes,timeoutMs,signal?})` executes only the configured local CLI. Node adapter uses spawn with `shell:false`, clean environment, bounded capture, kill and close wait. Runtime stop proof uses Docker inspect of the full immutable container ID and exact identity label; neither CLI exit, cancellation, expiry nor missing inspect is proof. Unknown evidence retains reservation.
- `NodeStagingPort` checks absolute canonical symlink-free host paths, owner/private permissions, disk reserve, and exclusive private per-run directories. No host directory is mounted. Fixed image handler consumes stdin and emits summary bytes only. Run markers intentionally persist; host must manage retention under an explicit owner policy.

Image contract: locally preloaded, owner-vetted digest image with `/usr/local/bin/node` and `/opt/foundry/event-summary.cjs` implementing the epoch-jobs handler. No image is pulled/built here. Runtime validates output against fresh pure-handler output. Unknown image volumes reject. Runtime requires local Linux Docker, cgroup v2 CPU/memory/PID controllers, seccomp, no daemon warnings, runc, no user namespace host override. Actual adapter is inert without explicit `allowActivation:true` host gate. Do not set it until owner verifies the image and daemon isolation.

Limits: profile CPU 0.1..2, RAM 64..512MiB, PIDs 8..64, tmpfs 1..16MiB, output 1..4096 bytes per stream, workload time 1..30000ms; CLI control calls <=5s and <=64KiB. Docker logs disabled; writable space limited to /tmp and /dev/shm tmpfs. No mounts, URLs, shell scripts, event commands, GPU/device requests or host environment passed. This is CPU quota, not dedicated core assignment. Local trusted administrator/daemon and filesystem ownership are prerequisites; not a hostile-host security boundary. Abrupt host crash requires external recovery and stop inspection, not an invented timeout guarantee.

The fixed entrypoint source is `src/image-handler.ts`. Its benign local subprocess test uses the existing TypeScript loader only; it is not a container execution test. Image packaging remains owner-gated. In addition to per-run resource ceilings, an instance refuses further identities after 1024 records rather than silently evicting stop history. Timeout is the attachment CLI deadline; control operations each have a separate 5-second bound, and physical stop can remain unknown afterward. A delayed start that still inspects as created after an attempted start is never attested as stopped. No automatic physical reservation release exists here.

## Security follow-up: Node adapter host configuration

`NodeCliConfig` now requires `{ executable, socketPath, privateConfigPath, allowActivation }`.
Parent/client hosts must supply `privateConfigPath` explicitly; there is no default or fallback.
Provision an existing canonical absolute directory owned by the current UID with mode 0700,
empty of ALL entries (including config.json, contexts, credential helpers and cli-plugins).
Every invocation revalidates it and prefixes exactly `--config <privateConfigPath> --host unix://<socketPath>`.
Only builtin allowlisted commands execute; ambient Docker config/proxy/plugin settings are not selected.
The adapter never provisions or reads the user's Docker configuration. No caller package was edited.

Every path ancestor, including `/`, must be a directory owned by root or the current UID,
with no group/world write bits; symlinks, sticky shared directories and other-UID 0755
ancestors reject. Executable and socket leaves must also be root/current-UID owned and
not group/world writable. The staging root remains current-UID private.
Root/current-UID administrators and the daemon are explicitly trusted: they must not
replace checked paths, alter the empty config, or substitute executable/socket objects
during use. Portable pathname validation is not race protection against those trusted actors.
Argv and execution options are copied synchronously before the first asynchronous check;
the original branded-create guard still applies before copying.

Daemon JSON uses `CpuCfsQuota` (not the Go member spelling `CPUCfsQuota`). Warnings
must be null or an empty array; missing, malformed or nonempty warnings reject.
SecurityOptions must be an array of strings containing builtin seccomp; null, empty,
missing and malformed collections reject. Resource capability booleans remain required.

`profileDigest(profile)` returns a stable digest of the full immutable profile in fixed field order, used for authority approval and pre-claim poll binding. The authority and host must agree on this digest before an attempt is created.

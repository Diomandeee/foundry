# Mac execution safety amendment — source candidate, HOLD

This changes the local engineering direction, not operational authority. Direct native Xcode execution is denied at both placement and local adapter/client entrypoints. ES ancestry remains useful for reviewing historical evidence but cannot close launchd/XPC/shared-service work. No process-group scan or callback is promoted into stop proof.

## Chosen containment boundary

The new `mac-vm-host.swift` implements a whole macOS VM lifecycle using Apple's Virtualization framework on Apple silicon. Guest Xcode and guest services live inside that VM. The configuration creates no network interface, host socket, console, audio, clipboard, USB, writable host-directory share or interactive development channel. The only host directory share is a root-provisioned input tree exposed read-only. Boot, auxiliary and output storage are explicit owner-provisioned per-attempt files. Boot/output raw disks have finite admitted sizes and require actual allocation; no sparse expansion or image download is performed.

This is a stronger candidate boundary than a dedicated native build account for closing guest service descendants. It is not a hostile-code certification. Root administrators and compromised trusted host/control software remain outside the boundary. Guest build accounts, image contents, toolchain/runtime installation and native binary signing/entitlement approval remain owner prerequisites. The source helper is not an installed or compiled program.

Apple documents [macOS virtual machines on Apple silicon](https://developer.apple.com/documentation/virtualization/running-macos-in-a-virtual-machine-on-apple-silicon), [the Virtualization lifecycle](https://developer.apple.com/documentation/virtualization/vzvirtualmachine), [forced stop](https://developer.apple.com/documentation/virtualization/vzvirtualmachine/stop(completionhandler:)), and [read-only shared directories](https://developer.apple.com/documentation/virtualization/vzshareddirectory). Local macOS 15.5 SDK headers and the Virtualization Swift interface were also read as source references. No SDK compiler, simulator or helper was invoked.

## Launch, cancellation and stop evidence

`launchMacVmContainment` is deliberately a separate experimental API, not a production `RuntimeAdapter`. It requires an approved runtime plan, owner activation policy, branded guest-job data, actual installed helper digest and exact configuration. It reserves the real `HostJournal` before launch and persists the VM identity. A second attempt or restart encounters the retained slot; this API never clears it, even after a clean observed VM stop.

Identity is `vm:` plus SHA256 of the exact JSON array `[jobId,attemptId,localRecipeHash]`. The staged job digest binds its complete encoded recipe, declared source root and file list to the helper configuration. This byte binding does not prove that the file list equals the approved immutable snapshot; that production integration remains required.

The helper creates fresh one-use nonce challenges. Deadlines use host continuous time and are anchored when the helper creates a challenge, not when a buffered permit arrives. The parent checks its current lease/cancellation/deadline synchronously and supplies its actual continuous-time remaining budget, floored and capped to 1,000 ms. The helper anchors that budget to challenge creation (conservatively earlier than the parent check), caps it by its own lifetime, supersedes challenges every 500 ms, and rechecks immediately before physical start. This avoids granting a full second when only a few milliseconds of the real lease remain. Channel loss, missing permit, expiry or cancellation closes admission and initiates whole-VM stop. A delayed asynchronous start callback cannot reopen admission; it must drain before positive stop evidence. No resume or automatic rerun exists.

Positive client stop evidence requires the exact terminal helper message, clean terminal helper closure, and durable journal finish. The helper must have observed VZ `.stopped` with all start/stop callbacks drained. Startup/stop/observation uncertainty resolves to `unknown` and retains quarantine. PID loss, EOF, guest shutdown request and `xcodebuild` exit never establish positive stop. The session always reports `result: not-collected`. This evidence cannot itself stage a successful build or lift authority eligibility.

## Guest job and resource behavior

`mac-vm-job.ts` serializes only locally approved structured recipes and selected source metadata. It never copies operator credentials or host environment variables. The preparatory encoder is bounded to 1,024 files, 2 GiB source, and the existing canonical-data byte/node limits; the broader segmented library input limits remain unchanged. Required inputs must be selected. Snapshot completeness/equality still needs a verified production handoff before any job activation.

`mac-vm-guest.py` is source for a one-shot, owner-installed guest boot runner. It requires a secret-free image, a dedicated standard guest build user, the read-only input mount, a private output volume and a fresh workspace. Python itself and the launch configuration are not installed by this change. It checks exact guest macOS/Xcode build/SDK, uses per-job `DEVELOPER_DIR`, disables signing and automatic package resolution, drops supplementary groups/UID/GID for the build, and builds within the VM. Host Xcode observations are not evidence about guest toolchains.

Guest source and output copies use no-follow descriptor-relative traversal, hash/copy the same regular-file descriptor, enforce byte allowances before and during copy, detect changed metadata and reject links/special files/mount crossings. Traversal and observations are bounded. The whole-VM watchdog is still needed for a blocked guest syscall; Python deadline checks alone cannot interrupt one. Output and log bytes together retain the 7 MiB pilot budget. Guest receipts remain untrusted input to later independent verification. Some real app bundles use symlinks and will be rejected under this conservative source policy.

## Filesystem exclusion

The previous generic writable `ManagedTreeSeal` prerequisite is not solved by permissions, Node path checks, flock or a callback that simply runs its argument.

`createMacReadonlyTreeSeal` instead implements a separate read-side capability. Its actual native guard requires an already root-mounted local APFS/HFS volume with `MNT_RDONLY`, exact fsid/source/volume UUID/root device+inode pins, secure root-owned ACL-free ancestry, bounded full-tree inspection, no nested/alias mounts, and no symlinks or hardlinks. It holds directory descriptors across the callback and rechecks identity after release. The kernel read-only mount supplies unprivileged writer exclusion; the metadata scan does not.

The packaging APIs can explicitly select this guard for immutable source capture and output collection. Local CAS writes and restore/materialization retain their separate writable seal requirement. A failed or uncertain guard poisons the instance and cannot be retried as success. This code never creates images, mounts/remounts volumes, sanitizes/chowns guest output, or deletes anything. Owner-approved readable root-owned trees are required; raw guest output is not automatically compatible.

## Remaining local engineering and gates

1. Bind the full selected file list to an independently verified immutable snapshot; prepare the per-attempt guest job/input image without a mutable host writer race.
2. Implement stop-gated read-only output-disk intake, sanitize only approved contents with explicit policy, verify actual result/allowlist/lineage, and feed the existing immutable artifact/verifier boundary. Do not trust guest receipt hashes alone.
3. Compose a production VM `RuntimeAdapter` with controller lease/cancel/recovery and guest capability/capacity reporting. Keep native placement denied until this exists and acceptance is separately approved.
4. Resolve the writable CAS/materialization seal prerequisite and inherited integration HOLD findings. The read-only guard does not close those.

No test/build/typecheck, runtime import/probe, helper/VM/service start, trial build/restore, image preparation, installation, cloud/provider operation, provisioning, spending, credential change, Git integration, deployment, publication or cleanup occurred. R7 remains unstarted. Physical activation, validation, installation, resource allocation, secret changes and merge/deployment remain separately gated.

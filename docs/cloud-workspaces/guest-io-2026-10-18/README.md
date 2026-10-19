# Guest input staging and stopped-result intake

Status: **M1 and M2 implemented and source-reviewed; validation pending; production HOLD.**

This closes the local guest-IO assignment. It does not close M3 production integration, M4 operational validation, inherited merge-gate findings, or R7 activation. No tests, test authoring, compilation/typechecking/linting, product imports/probes, VM/helper execution, installation, cloud operations, spending, secret changes, Git integration, deployment or cleanup occurred. Source inspection, source/document edits, local diff construction and file hashing are the evidence.

Read `SOURCE-REVIEW.md`, `FINDINGS.json`, `DEFERRED-ACCEPTANCE.md`, and `CHANGE-RECEIPT.json` alongside the parent `ROUTE.json`. Prior freezes remain historical evidence. The implementation is in the existing dirty candidate at `Developer/foundry-integration/source`, branch `codex/foundry-integration-20261016`, base `cf27ac662730bb98a509af8d1d1ebea4342eef7a`.

## Implemented source journey

1. **Verify approved input.** `verifyMacVmInput` requires the real private claim context, now pinned to inputHash and projectId as well as compute/profile/source identity. It verifies the actual manifest and every v2 metadata segment against generation-pinned references; validates complete metadata/required-input sets; and verifies the actual readonly source tree. Whole-file hashes and reconstructed v1 chunk/v2 packed-object hashes must both match. Unknown files/directories, links, collisions, missing inputs and unsupported modes refuse.
2. **Encode and prepare staging.** `encodeMacVmGuestJob` consumes that private receipt; callers cannot supply an alternative file list. `prepareMacVmStaging` returns bounded inert request bytes/hash for the exact approved job and source identity. It performs no privilege escalation, image creation, mount or installation.
3. **Concrete offline assembly.** The supplied `native/mac-vm-io.py` requires explicit root invocation and the exact owner-reviewed request SHA. With an installed, SHA-pinned native guard it observes the actual source mount, copies files through no-follow descriptors with expected hashes into a fresh fixed per-attempt namespace, writes job/provenance bytes, and creates/attaches a UDRO HFS+ image readonly. It emits actual observed mount identity, never guessed inode/fsid/UUID values. No default installed hash or generated mount receipt is supplied in the source.
4. **Accept and hold input.** `acceptMacVmStaging` consumes a concrete `createMacReadonlyTreeSeal` configured from the actual operation receipt and checks all mounted bytes and exact tree membership itself. `launchMacVmContainment` requires the private staged receipt; it repeats verification and holds the guard through physical launch, whole-VM stop and guard postflight. The native host now accepts a separate readonly input filesystem while requiring all its descendants to stay on that device. Guard failures abort pending launch work and can only produce unknown/quarantine.
5. **Prepare intake only after stop.** `prepareMacVmIntake` requires the actual private successful stop binding AND an observed startup event. The binding includes the exact plan/job, helper hash and opened output-disk inode/device/size/UID. It hashes that same stable backing file and creates a one-shot request. A JSON `stopped:true`, guest exit code, PID absence, old receipt or lease expiry is insufficient.
6. **Copy, extract and seal.** In intake mode the offline root helper copies the exact stopped raw bytes into a new root-owned file and verifies the expected digest before mounting the copy readonly. It never mounts the original writable backing disk. It traverses only the bounded result envelope without following links, copies into a fresh root-owned tree, rehashes the protected raw copy, and creates a separate readonly collection image. Failures retain partial trees, images and mounts for explicit reconciliation.
7. **Independently verify the guest result.** `acceptMacVmIntake` checks actual provenance bytes and result v2 against the private stop/request/job chain; requires exit 0, not limited, exact source/toolchain/attempt/profile identity; and verifies every output/log byte, declared directory, required selection and executable mode. Empty bundles are preserved. A structural object cannot substitute for the private verified result.
8. **Publish through existing boundaries.** `publishMacVmIntake` re-verifies the tree under its concrete guard, requires the real scope/compute binding and owner profile/output classifications, and composes `collectOutputs`, `writeResultManifest`, actual broker/capacity/writer ports and `verifyPublish`. A request-wide one-shot latch prevents duplicate acceptance handles from publishing twice. Failures abort outstanding local/provider work and retain partial evidence. It returns a real manifest claim, **not** authority acceptance or verified build success. Authority submission, independent server verification and slot reconciliation remain M3.

## Provisioning and invocation contract — not executed

The owner must separately approve and supply a dedicated unprivileged host identity, native signed VZ helper, native readonly guard, Python runtime, secret-free macOS guest image/boot configuration, guest build account, pinned toolchain, fully allocated boot/output disks and root-owned ACL-free namespace. No service or installer is added here. The Python source must be installed root-owned in a protected location, with a trusted interpreter; never run an unreviewed user-writable script as root or grant blanket sudo access to this tool.

The guard path used by the assembler is fixed: `/Library/Foundry/bin/mac-tree-guard`. Its actual installed binary digest is an explicit request field. The new native `--describe-readonly-v1` mode is root-only observation; unprivileged clients still use independently pinned held `--readonly-v1` guards. SDK headers were read for the ACL APIs; no native binary was built.

The invocation contract is an owner-controlled process receiving exact request bytes on stdin and that request's SHA-256 as its sole argument. The receiver must keep the private in-memory request/plan/stop chain alive to accept the result. The helper does not deserialize private authority or stop brands and is not exposed to workers/browser requests. Restart loses those brands and requires quarantine reconciliation; it never imports a JSON stop receipt as authority.

Fixed paths beneath `/Library/Foundry/VM/attempts/<attemptId>`:

| Path | Purpose |
|---|---|
| `io-stage/` | Create-only request marker, source-copy tree, sealed image, actual receipt |
| `input/` | Actual readonly input mount; `job.json`, `provenance.json`, `source/` |
| `outputs.raw` | Existing dedicated-UID writable VM output disk; unchanged by intake |
| `io-intake/` | Create-only request marker, protected `stopped.raw`, readonly raw mount, sanitized tree/image, actual receipt |
| `intake/` | Actual readonly collection mount; `result.json`, `provenance.json`, `payload/` |

Source roots must be owner-provisioned readonly trees under `/Library/Foundry/VM/sources/`. The helper checks root ownership/permissions and ACLs using descriptor-based Darwin security APIs, not text rendered by `ls`. Root administrators, the dedicated trusted supervisor process and host kernel remain trusted. This is not a claim that mounting a hostile filesystem is kernel-safe; the initial pilot remains restricted to explicitly approved trusted projects.

## Bounds and supported envelope

- Inputs: at most 1,024 files, 64 MiB/file, 2 GiB including staged job/provenance overhead, 16 MiB aggregate metadata, 128 MiB maximum reconstructed segment blobs. Modes 0600/0644/0700/0755; guest job bytes at most 256 KiB. Snapshot lineage is preserved; no new complete-Git-history claim is made by this verifier.
- Root helper: 512 KiB request, 30-minute deadline, create-only one-shot operation markers, fixed OS executables with bounded stdout. It checks 50 GiB free **after** additional estimated copy/image space. Output raw-copy intake cap is 16 GiB; current VZ host output disks remain capped at 8 GiB. The broader helper cap does not widen VZ admission.
- Staged guard: explicitly configure at least job timeout + 120 seconds, with an overall maximum 65 minutes. The default five-minute guard is insufficient for a one-hour job and is rejected before launch. Timeout does not imply safe reuse.
- Results: guest result **v2** includes directories and executable modes. Older v1 receipts refuse. At most 20,000 observed tree entries including wrapper paths; up to 7 MiB raw outputs+log and 1 MiB result metadata. Packaging additionally charges real TAR headers/padding and existing 31-chunk + 1-manifest/8-MiB namespace limits. Source/content limits can reject an archive that needs more framing; no silent truncation.
- Selected `.app`, `.dSYM`, `.xcarchive` paths are directory bundles; other outputs must be regular files. Empty bundles and executable file bits survive. Symlinks, special files, hardlinks, undeclared result entries, aliasing names, reserved log-path collisions and unsupported paths refuse. This intentionally excludes symlink-heavy framework bundles until a separately reviewed representation exists.
- The raw result envelope is `files/`, `build.log`, `result.json`. Named OS metadata outside it (`.fseventsd`, `.Trashes`, `.Spotlight-V100`, `.TemporaryItems`, `.DocumentRevisions-V100`, `.metadata_never_index`, `.DS_Store`) is type-checked but never traversed/copied. Other root entries, including `failure.json`, refuse successful intake. Raw disk digest still binds every byte, including excluded OS metadata.
- Both input and result final images are root-mounted kernel-readonly, ACL-free and independently checked by the concrete guard. A cooperative lock, claimed readonly flag, chmod alone or user-supplied callback is not substituted for that capability.

## Exact stop

**M1/M2 local source implementation and review are finished. No runtime behavior has been validated.** M3 production RuntimeAdapter/controller, claim/renewal/guest capability wiring, durable authority submission and explicit slot reconciliation are still open. Generic writable CAS/materialization isolation and inherited integration findings are also open. This batch consumes genuine existing storage ports; it does not invent a working writable seal.

M4 compile/tests/acceptance and R7 activation require matching approvals. No new approval question is needed to understand this stop. Xcode placement remains explicitly ineligible, direct native execution remains denied, and stopped VM sessions retain quarantine. No background work or operational rollout is running.

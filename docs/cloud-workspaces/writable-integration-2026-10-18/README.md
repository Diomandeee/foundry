# Writable storage and cumulative integration repair

State: **implemented and source-reviewed for the bounded Mac VM path; validation pending; production HOLD**. This is a local source batch, not an installation, test result, activation receipt, or declaration that the entire Foundry fleet works.

The previous M3 composition accepted a generic `ManagedTreeSeal` for writable CAS operations. That contract requires exclusion of concurrent same-UID writers and cannot be implemented by a Node mutex or repeated lstat. This batch removes that dependency from the Mac VM production path. It also repairs inherited gate/revocation integration defects and reconciles K11's separate Craft rollout.

## Concrete storage boundary

`packages/build-storage/native/mac-cas.py` contains a complete, explicitly started root service and unprivileged client. `src/mac-isolated-store.ts` is its bounded Node adapter. No service has been installed or started.

The service accepts only `put` and `read`, a version, SHA-256, size, and (for put) canonical base64 bytes. There is no requested filesystem path, shell, executable, destination, overwrite, list, delete, cleanup, image, or mount operation. A single serialized service owns `/Library/Foundry/CAS/objects`, with root-owned 0700 directories and root-owned 0400 objects. All object access is descriptor-relative, O_NOFOLLOW, same-device, regular-file and single-link checked. Darwin ACL checks reject extended ACLs on namespace components and opened files. Root and the installed runtime remain trusted administrators.

The Unix socket is in a root-controlled ACL-free directory. The service checks the exact approved kernel peer UID; the client checks that its peer is root. Group membership alone is insufficient. No TCP listener is implemented. Client-side construction is inert. Operations invoke only the fixed isolated Python interpreter and helper, each with an actual owner-supplied installed hash; `-I -S` excludes user Python paths and site customization. The entire interpreter/standard-library installation must be owner-trusted, not merely the script hash.

Objects are at most 1 MiB. The sharded-v2 ref is derived entirely from the digest. Every put verifies bytes before creation and reads/hash-verifies the stored object before acknowledgment. Every read rechecks the actual content and exact returned reference. Existing objects are never overwritten. A failed partial create remains and fails integrity checks; there is no automatic repair. Lost successful replies may be reconciled by an explicit same-content operation without creating another object.

Owner policy has exact fields `version`, `workerUid`, `workerGid`, `maxBytes`, `maxObjects`, `reserveBytes`. It permits at most 20 GiB and 200,000 objects, and requires at least 50 GiB remaining disk space. Additional headroom is checked before shard creation. Startup inventories retained objects, including incomplete creates, to reconstruct quota. Inventory and each shard are bounded. Disk checks are conservative admission observations, not an OS reservation against unrelated system writers.

One client call per store and at most four per process remain occupied until the helper actually closes. Abort/deadline kills the client; a root-side write already admitted may finish as a retained immutable object. It does not confer cloud publication authority. The root server serializes requests, bounds wire data and socket deadlines, and never begins a second request while filesystem work is unresolved. A stale socket prevents restart until owner reconciliation; the service never deletes it automatically. This is deliberately not an unattended restart/cleanup facility.

The exact UID is a trusted controller principal, not a per-project tenant. It can read its local CAS by known digest and consume its bounded quota. Untrusted project code belongs in the separate guest; do not run it under the controller UID or expose this socket to a guest. Cloud access remains independently scoped by the storage broker.

## Integration

`MacVmAdapterConfig.storage` now takes installed interpreter/helper pins. The adapter constructs the concrete store itself. Intake requires the factory-created store brand, verifies the actual stopped guest and readonly output tree, and supplies the real post-claim writer/issuer/capacity ports explicitly. Source/result packaging permits a genuine readonly guard without a fictitious writable seal. Mutable restoration APIs still require their original exclusive-tree contract.

The journey remains: authenticated claim → actual guest capability/source validation → owner-mediated image staging → current fenced VM execution → actual stop → owner-mediated readonly result intake → isolated local CAS → scoped immutable cloud write/readback → authority staging → independent verification. No accepted local object or cloud upload alone marks a build verified.

**Limits retained:** owner-mediated image staging/intake; actual image/toolchain/account/capability/provider approvals; 2 GiB guest source and existing 7 MiB result pilot limits; 128 required paths in the authority input contract; unknown/incomplete storage inventory blocks admission. The service is not a general workspace materializer. Generic Linux writable workspace isolation remains an explicit engineering gap and does not acquire a fabricated seal from this batch. Native host Xcode execution stays denied.

## Cumulative gate and revocation repairs

- Cloudflare tree enumeration compares additions, deletions, and every intersection entry by hash/type/mode. Missing parents/trees and budget exhaustion produce unknown/conflict, never partial complete diffs.
- File/history operations no longer infer absence from broad exception strings. Local Git establishes absence through successful tree/ref queries; Cloudflare uses documented null/empty results. UTF-8 decoding is fatal and preserves BOM bytes.
- Both merger implementations compare the whole landed tree with the approved overlay, including object IDs, modes, kinds, deletions and untouched base entries. Production independently fetches the exact proposal using its read credential before writing.
- The text admission transport currently supports regular nonexecutable UTF-8 files. Unsupported executable/symlink/gitlink or non-roundtripping content is refused, not silently converted. This is a supported-scope restriction, not arbitrary-blob support.
- Local genesis creates the documented wrapper parent explicitly. Production genesis requires positive empty-ref evidence and an actual root commit. Existing-destination movement refuses; local push uses the exact expected-ref lease, including the empty case.
- Replay reuses only the current landed head whose parent/trailer and complete tree match the exact admitted overlay. An ambiguous or later-head replay is held for reconciliation. No unchanged-worktree shortcut counts as proof.
- A bounded verification receipt binds event, proposal, base, changed/deleted content digest, selected policy, and returned check outcomes. It is stored and read back before merge; its reference is also persisted with the decision. D1 receipts are immutable. Missing receipt storage/schema prevents merge. This records the trusted verifier's response; it is not independent evidence that a remote verifier actually executed the requested checks.
- `VERIFY_REQUIRE_CHECKED` implements an explicit positive-evidence policy, including when no verifier URL exists. Its default preserves the prior policy. It has not been enabled or approved for deployment. The owner policy finding therefore remains approval-pending.
- The short-job client itself now observes environment/authority/epoch before work and again before execution/upload, so calling it outside the pilot wrapper cannot skip server pin checks. Its HTTP calls also retain process-wide occupancy through actual settlement and quarantine uncertain cancellation.
- Revocation HTTP occupancy is process-wide. Logical timeout returns to the caller but actual credential/fetch/read/cancellation settlement owns the slot. Constructing another relay does not clear occupancy. Four permanently unresolved operations hold the process closed for reconciliation.

The new receipt table and the existing `decisions.verification` column must both exist before any future deployment. Older databases may lack the column. No migration was run. See `DEFERRED-ACCEPTANCE.md` for preflight, validation and rollback boundaries.

## Evidence and exact stopping point

`SOURCE-REVIEW.md` records six inline review passes by the implementing agent. `FINDINGS.json` supersedes the relevant current dispositions without rewriting frozen earlier evidence. `K11-INTEGRATION.md` and `K11-SOURCES.json` preserve the external lane's provenance. `SCOPE.json`, `changes.patch`, and `CHANGE-RECEIPT.json` bind this batch to actual baseline and final bytes.

No tests were authored or executed; no compilation, imports, builds, service/VM starts, installation, cloud actions, secret changes, cleanup, commit, merge, or deployment occurred. M4 validation and R7 activation remain separate gates. The full end goal is not reached: no newly functioning fleet, Mac build, Linux worker, restore, or storage reclamation is claimed.

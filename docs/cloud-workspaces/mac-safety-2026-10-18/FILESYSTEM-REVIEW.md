# macOS read-only filesystem seal — source review, 2026-10-18

Status: source implementation only. No compilation, import, executable start,
installation, runtime probe, test execution or test authoring was performed.
This does not resolve the generic writable `ManagedTreeSeal` requirement.

## Scope and supported use

`packages/build-storage/src/mac-readonly-seal.ts` exports
`createMacReadonlyTreeSeal`, returning `ReadonlyManagedTreeSeal`, a subtype of
the parent's separate `ManagedReadonlyTreeSeal`. It deliberately has no
`withExclusiveTrees` method or writable adapter. It supports exactly one pinned
root per invocation, on an already mounted local APFS or HFS volume with
`MNT_RDONLY` and `f_owner == 0`. Construction performs no I/O.

The intended consumers are source capture and output collection through optional
`readSeal.withReadonlyTrees`. The parent's `PackagingPorts` and
`ProjectInputPackagingPorts` additions and v1/v2 packaging/collection selection
were read for source compatibility; this lane did not modify them. Local CAS
retains its independent writable seal. Restore/materialization and CAS `put`
cannot use this interface. There is no mutable-tree fallback inside this factory.

The kernel read-only mount is the writer exclusion mechanism. Holding a directory
FD, checking metadata, or scanning before/after does not itself exclude writers.
Apple documents `MNT_RDONLY`, `MNT_LOCAL`, filesystem identity and the mounting
user in [`statfs(2)`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/statfs.2.html).

## Provisioning prerequisites

These are trusted owner/root administration inputs, never actions this code takes:

- A root-created local volume is mounted read-only by root. The expected mount
  source is an exact `/dev/diskN[sN...]` path. Remote, FUSE, devfs, mutable
  directories, guessed identities and absent UUIDs are refused.
- The managed root, mountpoint and every directory from `/` to each must be
  UID 0, have no group/world write bits, and have no extended ACL entries.
  Every mounted ancestor must be local and root-mounted. No symlink components.
- The entire managed subtree must consist of readable root-owned directories
  and single-link regular files, without group/world write bits, extended ACLs,
  symlinks or special nodes. All descendants must stay on the pinned filesystem.
  This intentionally rejects common unsanitized application bundles with symlinks.
- **Guest UID 501 output is not directly ingestible.** An explicitly authorized,
  separate sanitization/provisioning step must produce a readable root-owned tree
  satisfying these restrictions before this seal can accept it. This code never
  chowns, copies, cleans, remounts or sanitizes guest output. Setting
  `ManagedRoot.uid` to 501 does not weaken native checks; compatible consumers
  must use UID 0 for this provisioned tree.
- There must be no nested mount anywhere below the containing mountpoint and no
  second mount with the same fsid or mount source. The namespace is not writable
  by the unprivileged host UID. Root administrators must not replace, remount or
  change this namespace during the operation.
- The helper must be a reviewed root-owned native Mach-O executable, without
  setuid/setgid bits, multiple hardlinks, group/world write access, extended ACLs,
  or writable/ACL-bearing directory ancestors. Its actual installed binary SHA256
  is an explicit owner pin. There is no embedded example digest or auto-install.
  The configured path must exactly match the kernel-reported executable and
  mapped-image paths; aliases that do not match are refused.
- The host runs unprivileged, with real/effective UID and GID equal. It must not
  expose the seal, subprocess handles or trusted configuration to workers.

Root-created mounting alone cannot establish protected backing storage. Owner
provisioning must also exclude worker/same-UID access to raw block writes, mutable
image backing files, or privileged services capable of changing the mount. A
read-only mount over attacker-writable backing storage is outside supported use.
No image/backing attestation or privileged-service policy is invented here.

The helper installation's ACL-free hierarchy is a **bootstrap trust prerequisite**:
Node checks ownership/mode, effective `W_OK`, native magic, bounded bytes, stable
descriptor/path metadata and SHA256 before direct execution. Node's public fs API
does not expose Darwin ACLs, and `W_OK` is not a complete ACL proof. The authentic
native helper independently rejects all ACL entries in its hierarchy and checks
its actual loaded-image vnode. This must not be presented as securely bootstrapping
an executable from an already attacker-controlled ACL namespace. Trusted root
installation and no concurrent root mutation are required.

## Exact native protocol

The TS host directly spawns the pinned helper with `shell:false`, an empty
environment, working directory `/`, and three private stdio pipes. No shell,
`sudo`, executable search, mount tool or injected success-verdict callback exists.
Arguments, in order, are:

1. `--readonly-v1`
2. Absolute installed helper path
3. Fresh 32-character lower-case hex nonce (correlation, not an authentication key)
4. Absolute managed root path
5. Absolute containing mountpoint path
6. `apfs` or `hfs`
7. Expected signed 32-bit fsid component 0
8. Expected signed 32-bit fsid component 1
9. Expected mount source
10. Expected volume UUID
11. Expected root device as an unsigned decimal string
12. Expected root inode as an unsigned decimal string

Root/mount/helper/source paths are canonical absolute printable ASCII, fewer than
1024 bytes, without `.`/`..`, empty components or trailing slash. Source filenames
inside the tree are not restricted to ASCII by this protocol. There is no generic
command interpreter or request body.

Native startup:

1. Refuse UID 0, mismatched real/effective IDs and `issetugid()` execution. Compare
   `proc_pidpath` with the expected executable path. Compare the vnode backing the
   helper's own image mapping (`proc_pidinfo`, `PROC_PIDREGIONPATHINFO`) against
   the securely opened helper's inode/device, ownership, mode and size.
2. Walk helper, mountpoint and root from `/` with `openat`, `O_NOFOLLOW` and
   directory descriptors. Refuse every extended ACL, including deny-only ACLs.
   Use `fstatx_np` and `filesec_query_property` to distinguish an absent ACL from
   failure; do not confuse `acl_get_fd_np` returning NULL with a confirmed absence.
   This distinction follows Apple's
   [stat/filesec implementation](https://github.com/apple-oss-distributions/Libc/blob/main/sys/statx_np.c).
   `no_acl` captures `acl_get_entry`'s errno **before** `acl_free`; Darwin's
   `-1/EINVAL` empty-ACL behavior is checked against Apple's
   [Libc implementation](https://github.com/apple-oss-distributions/Libc/blob/main/posix1e/acl_entry.c).
3. Retain the root and mountpoint FDs. Obtain `fstat`, `fstatfs` and pathname
   `statfs` observations, requiring read-only/local flags and mount owner 0.
   Compare fsid, filesystem type, mount source, mountpoint, root device/inode
   against owner-supplied expectations.
4. Read the volume UUID with `fgetattrlist` on the retained **mountpoint FD** and
   independently with pathname `getattrlist` at the volume root. Volume attributes
   require that root even when the managed tree is a subdirectory. Use byte-copy
   parsing with explicit returned-length checks,
   returned-attribute checks for the FD query, and no structure-padding assumptions.
   Unsupported/missing UUIDs fail closed. See Apple's
   [`getattrlist(2)`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/getattrlist.2.html).
5. Use bounded `getfsstat` observations to refuse nested mounts, same-source/fsid
   mount aliases and non-root-mounted ancestors. Table size changes refuse the
   operation. This uses the real mount table, as described in Apple's
   [`getfsstat(2)`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/getfsstat.2.html).
6. Enumerate the managed subtree using `fdopendir`/`readdir`, `fstatat` with
   `AT_SYMLINK_NOFOLLOW`, and `openat` with `O_NOFOLLOW`/`O_NONBLOCK`. Match opened
   inode/device and filesystem identity. Bound enumeration to 200,000 entries and
   depth 128; bound the mount table to fewer than 4,096 entries. Inaccessible or
   over-budget metadata refuses instead of skipping entries. File bytes are not read.

Only after startup succeeds does stdout contain one newline-terminated JSON frame:

`protocol`, `event`, `nonce`, `path`, `mountPoint`, `filesystem`, `fsid`,
`mountSource`, `volumeUuid`, `rootDevice`, `rootInode`, `mountOwner`, `readonly`,
`local`.

The protocol is `mac-tree-guard/1`; the first event is `ready`. Identity values come
from actual native observations, not echoed expectations. Mount owner is 0 and
read-only/local are true only after those checks. TS checks the exact key set,
nonce, event and every pinned identity value before invoking the host callback.
TS accepts at most 8,192 bytes per frame and 16,384 stdout bytes per operation,
printable ASCII only. Native paths are bounded, JSON strings escape quotes and
backslashes, and the native program emits exactly two bounded frames. Any stderr
content poisons the operation; diagnostics are constant and never include file
content or paths. TS drains failed output without retaining arbitrary payloads.

The child then blocks on stdin while retaining the root FD. Any input byte is an
error. **EOF is the sole release instruction.** On callback success TS closes
stdin, after which the child reopens and verifies the namespace, compares held
root/mountpoint inodes, repeats identity/UUID/mount-table/tree checks and executable
identity checks, emits `released`, closes descriptors and exits 0. TS returns the
callback result only after the matching second frame and clean child `close`.
A ready frame alone never establishes operation success.

## Failure and lifetime semantics

Startup and post-callback close deadlines are 10 seconds each. The whole operation
defaults to 300 seconds and has an explicitly bounded configurable deadline up to
30 minutes. The instance rejects concurrent/reentrant calls. A callback can perform
authorized work outside the read-only root, but this seal supplies no guarantee for
those destinations and no provider rollback.

Abort, callback rejection, guard exit, malformed/oversized output, stdout loss,
identity mismatch, I/O error or deadline failure permanently poisons the instance.
No retry or writable fallback occurs. The operation cannot report success after a
failure even if a delayed child later reports `released`.

Arbitrary host callback code cannot be forcibly cancelled by rejecting a promise.
If it remains pending when abort/failure is reported, TS keeps guard stdin open
until that callback actually settles; the authentic child retains the root FD.
If the child has already died, the operation fails, while the provisioned mount
remains kernel-read-only. TS never kills the child, unmounts the volume, removes
files, assumes termination, or rolls back effects. `state()` retains poison,
callback-pending status, PID and observed `close` status, including late child
closure. Owners must retain failed instances for inspection. A hung callback or
unconfirmed child can therefore retain resources indefinitely; it is uncertainty,
not a successful release. Parent host-process termination is outside this lifetime
guarantee; a surviving child's stdin EOF still triggers native postflight/exit.

## Source review receipt and remaining gaps

Only these files are owned/written by this lane:

- `packages/build-storage/src/mac-readonly-seal.ts`
- `packages/build-storage/native/mac-tree-guard.c`
- `docs/cloud-workspaces/mac-safety-2026-10-18/FILESYSTEM-REVIEW.md`

Exact directories were created with `mkdir -p`; outputs are inspected with
`ls -la`. Parent edits and captured baseline preimages are preserved.

| RTD level | Evidence in this lane |
| --- | --- |
| Structure | Source files and documentation inspected at the exact authorized paths. |
| Compilation | Deferred by explicit instruction; neither TS nor C was compiled/imported. |
| Integration | Source-only signature/use review against generic read seal and optional ports; exports/wiring belong to parent. |
| Content | Local SDK declarations and Apple documentation/source reviewed; fail-closed branches and protocol manually traced. |
| User journey/runtime | Deferred; no helper, mount, child process, packaging flow or adversarial race was exercised. |
| Deployment | Deferred; no helper binary, hash, install, provisioning, release or deployment receipt exists. |

Remaining admission evidence includes actual supported-SDK compilation/linking,
native image-vnode reporting, ACL/attribute behavior on the supported macOS version,
real read-only provisioned-volume identity and kernel writer rejection, lifecycle
handling under failure, and parent integration. The source deliberately refuses
unknown outcomes; manual review is not runtime evidence. No particular installed
filesystem, root hierarchy or executable is declared eligible by this review.

This is not writable restore/CAS containment, general live workspace confinement,
VM disk isolation, or an APFS capacity guarantee. **Separate APFS quota verification
for a future VM work share is unsupported and not implemented.** No quota, snapshot,
VM, image-backing or provider capacity approval is inferred from `MNT_RDONLY`.

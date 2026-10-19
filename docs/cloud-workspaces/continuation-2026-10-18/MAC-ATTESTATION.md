# Mac native attestation sidecar — source candidate, HOLD retained

Assigned repository: `/Users/mohameddiomande/Developer/foundry-integration/source`.
Parent-supplied base: `codex/foundry-integration-20261016` at
`cf27ac662730bb98a509af8d1d1ebea4342eef7a`, already-dirty candidate. Existing baseline:
`docs/cloud-workspaces/continuation-2026-10-18/BASELINE.json`.

**Native termination attestation is not complete.** Added useful public Apple ES
collection source and a concrete supervisor protocol client/verifier. No native path
returns `stopped:true`; process-only evidence cannot clear quarantine. No privileged
companion was supplied, installed, entitled, started or claimed operational.

## Exact changed paths

All repository-relative below; no edits outside these paths were made by this sidecar:

1. `packages/build-runtime/src/mac-attestation.ts` — new concrete
   `NativeDescendantAttestor`, launch ticket/checkpoint protocol, public-key pins,
   bounded root-owned signed-journal reader, continuity/lineage replay and recovery review.
2. `packages/build-runtime/src/adapters.ts` — replace old callback interface with that
   concrete class; remove native process-table scan/success callback; optional supervisor
   client branch; no-observer execution still returns unknown stop. Linux class unchanged.
3. `packages/build-runtime/src/index.ts` — export the concrete class and four protocol types.
4. `packages/build-runtime/native/mac-es-observer.c` — new opt-in C library using real
   public ES client/subscription APIs and durable, bounded unsigned event collection.
5. `packages/build-runtime/native/mac-es-observer.h` — explicit observer lifecycle API;
   no stop-proof API, executable main, installer or automatic invocation.
6. `packages/build-runtime/MAC-SUPERVISOR-PROTOCOL.md` — exact wire/command shapes,
   trusted-supervisor obligations, durable recovery rules, primary sources and blockers.
7. `packages/build-runtime/README.md` — accurately describe source and retained HOLD.
8. `packages/build-runtime/src/receipts.ts` — **only the requested empty regular-file
   compatibility fix** in `verifyPublish` (the actual function name), plus tar framing
   checks and explanatory hash-fold comment. **Write scope released to parent** after
   that fix; parent owns the subsequent v2 branch and any later contents of this file.
9. `docs/cloud-workspaces/continuation-2026-10-18/MAC-ATTESTATION.md` — this report.

No edits to `controller.ts`, `storage-integration.ts`, broker/routes/common docs,
baseline/preimages, test files, package/build scripts or unrelated work. No Git mutations.
No background agents, services or continuing work are left by this sidecar.

## Concrete source and interfaces

The native library explicitly calls `es_new_client`, `es_unmute_all_paths` and
`es_subscribe` for `NOTIFY_FORK`, `NOTIFY_EXEC`, `NOTIFY_EXIT`. It checks message
version before reading versioned members, requires >=5, and records actual audit
token words/start times, global and per-type counters, and Mach timestamps. It does
not scan UIDs or infer descendants from a process group. Every subscribed event,
including unrelated-account events, advances continuity. Gap, wrap, order regression,
storage error and bounded journal exhaustion poison observation. Destruction errors
retain poisoned state to avoid freeing callback state. No signals, authority, launch
adoption or process/service termination proof are implemented by that library.

The C stream is explicitly unsigned and cannot satisfy the TypeScript reader. A
privileged owning supervisor must integrate the collector with launch and signed
projection; the code does not manufacture an ARMED receipt, signature or final seal.
There is no implementation of the future privileged IPC/run/signing companion, and
the C source is not wired into any build or service. That gap is deliberate and open.

`NativeDescendantAttestor` was an interface accepting arbitrary `inspect` callbacks;
it is now a concrete exported class. `NativeMacAdapter` accepts that class or no
observer and rejects a plain callback object. No in-repository non-test consumer of
the old interface was found outside build-runtime during source tracing.

Configuration: `MacSupervisorConfig {clientExecutable, clientSha256,
supervisorSha256, evidenceRoot, publicKeyPem}`. Pins are public, owner-only inputs;
private PEMs, setuid/setgid helpers, unsafe paths and linked evidence files reject.
Construction has no filesystem/process/provider activity. Explicit invocation checks
the root-owned pinned executable and only uses the fixed `reserve`/`run`/`stop` protocol
documented in the package. This is local file/command transport, with no custom
HTTP endpoint reads or network listener. No companion was invoked in this task.

Before RUN, existing durable journal callbacks persist the random correlation ticket,
intent/account marker and authenticated ARMED payload digest; the existing pre-run
entry already pins profileHash. These reconstruct `MacLaunchCheckpoint` after a
worker restart. The nonce is not an authority token. Missing/ambiguous markers never
permit adoption, re-execution or release. `reviewRecovery(checkpoint)` is evidence-only;
it does not signal anything or mutate host/authority state.

The reader verifies Ed25519 signatures and the payload hash chain, ticket/profile/
intent/account bindings, one boot/session, original ARMED anchor, global/per-event
continuity, explicit FORK/EXEC/EXIT lineage, prior observed prefixes, stable bounded
file reads and final seal shape. PID reuse/unknown identity transitions and prefix
replacement fail closed. EXEC preserves a lifetime across audit identity changes.
An authentic process-only seal with an empty replayed live set remains diagnostic:
`MacEvidenceAssessment.blocker` is always `native-service-containment-unimplemented`.

## Exact release boundary and parent handoff

Current native release conditions: **none**. Both native branches return
`{stopped:false,basis:'unknown',identity}` even for exit zero or a valid process-only
seal. Source trace: `LongJobSupervisor` retains `outcome:'quarantined'`;
`HostJournal.finish` does not remove the host slot; controller reports unconfirmed
stop and does not enter publication. Server-side independent authority gates remain
the parent's responsibility. There is no fake grant/readiness/termination proof.

Remaining blockers before any future native activation or credible proof:

- A genuinely entitled/TCC-approved, continuously owned privileged supervisor and
  authenticated IPC, suspended launch/kernel identity binding, durable ticket closure,
  raw-event projection/signing, audited muting/subscriptions and crash/drop handling.
  A signed field is a trusted-supervisor assertion, not independent measurement of
  entitlement, executable provenance, fsync or OS coverage by TypeScript.
- Closure or enforceable rejection of **all** launchd/XPC/shared-service work,
  including requests to already-running services and queued future activations.
  Public `AUTH_EXEC` cannot alone reject fork-only code or invisible shared-service
  work. This collector deliberately uses notifications and provides no exec policy.
  There is no assumed public `AUTH_FORK` API. Unsupported escape is rejected by the
  native release boundary: there is no true stop proof in this version.
- The worker fence currently guards proxy invocation. It cannot establish that a
  delayed privileged RUN resumes under a current lease/cancel fence. The supervisor
  needs actual authority/deadline/disconnect handling before physical activation.
  Native preflight `xcodebuild -version/-showsdks` also occurs outside the new launch
  interval; it needs coverage before any complete-containment claim.
- Root-protected directory/ACLs, local durable storage and explicit trusted approved
  project/build-script inputs. No hostile-code sandbox, hard native quota, cleanup,
  installation, signing, cloud spend or owner-reconciliation grant is implied.

Parent retains controller/storage/broker integration and HOLD. The parent-requested
`restoreInput` fourth-argument `BuildAttemptContext` and receipts v2 verification
branch are parent work; this sidecar does not edit those interfaces. No additional
wire change is required merely to retain conservative native quarantine.

## Empty regular-file fix requested during the sidecar

`verifyPublish` previously required positive size and at least one chunk for every
output. It now accepts `format:'file', sizeBytes:0, chunks:[]`; the existing SHA-256
fold over zero chunks must equal the declared SHA-256(empty), so arbitrary hashes
still reject. Nonempty regular files require chunks. Tar requires at least 1,024
bytes, a size divisible by 512 and nonempty chunks. Individual provider objects
remain positive-sized, with no invented zero-byte grant/object. Existing whole-file
hash/size, object count, complete approved path and output budget checks remain.

Static comparison used `build-storage/src/packaging.ts` empty-file chunk generation,
`build-jobs/src/validation.ts` result constraints and the authority's whole-output
hash fold. No test or runtime validation was authored/executed. The parent was told
the fix was complete and receipts write scope released before its later v2 edits.

## RTD verification and limits

- **Structure:** inspected real source files, exports, protocol definitions, C
  open/observe/close paths and existing journal/controller callsites. Local source
  review only; no compiler or SDK header/import probes.
- **Compilation:** DEFERRED / FORBIDDEN. TypeScript and native C have not been compiled,
  typechecked, imported or linked. No build script or dependency changes.
- **Integration:** static shape/callsite reasoning only. The optional companion is
  missing; raw C collection is not a signed supervisor or end-to-end integration.
- **Content:** no stubs returning success, fake signatures, fabricated OS events,
  invented grants or termination/readiness receipts. Protocol tuples in the package
  documentation are schema descriptions, not fabricated evidence fixtures.
- **User journey:** source trace only: native unknown → quarantine → no slot release/
  publication. No actual job, observer, lease, restore, publish or service exercised.
- **Deployment:** gated; no activation. No tests authored/executed, builds, typechecks,
  imports, OS-process probes, process/service starts, installs, custom endpoint reads,
  cloud operations/spend, private token reads, secret changes, cleanup or Git mutations.

Source review found and corrected a signed-prefix replacement weakness before handoff
(longer journals must preserve the prior exact prefix), private-PEM acceptance,
setuid/linked client acceptance, and unchecked ES destruction errors. These are
source reasoning outcomes, not passing tests. Native implementation remains incomplete.

## Primary official research

- Apple [ES client creation](https://developer.apple.com/documentation/endpointsecurity/es_new_client(_:_:))
  and [entitlement](https://developer.apple.com/documentation/BundleResources/Entitlements/com.apple.developer.endpoint-security.client)
  establish root/entitlement/TCC prerequisites; no such grant is asserted here.
- Apple [global sequence](https://developer.apple.com/documentation/endpointsecurity/es_message_t/global_seq_num)
  and [per-type sequence](https://developer.apple.com/documentation/endpointsecurity/es_message_t/seq_num)
  document dropped-event detection; global counter requires message version >4.
- Apple [process structure](https://developer.apple.com/documentation/endpointsecurity/es_process_t)
  documents audit tokens and start time. Apple OSS [XNU identity validation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_proc.c)
  validates audit-token PID version; PID-only lookup is insufficient.
- Apple [NOTIFY_FORK](https://developer.apple.com/documentation/endpointsecurity/es_event_type_notify_fork)
  and [AUTH_EXEC](https://developer.apple.com/documentation/endpointsecurity/es_event_type_auth_exec)
  distinguish notification from authorization. No AUTH_FORK behavior is invented.
- Apple [launch constraints](https://developer.apple.com/documentation/Security/applying-launch-environment-and-library-constraints)
  distinguishes parent and responsible processes, including launchd-created XPC service
  launches. This motivates retaining the unproved shared-service boundary; it is not
  a claim that responsibility tokens prove all delegated work is quiescent.
- Apple OSS [launchd manual](https://github.com/apple-oss-distributions/launchd/blob/main/man/launchd.plist.5)
  limits AbandonProcessGroup behavior to remaining processes in the same process
  group; it does not establish general escaped-descendant containment.
- Apple [client destruction](https://developer.apple.com/documentation/endpointsecurity/es_delete_client(_:))
  documents possible shutdown errors/resource leaks, reflected in the C failure path.

Public official documentation was read through web tooling. No local OS process tools
were run and no private endpoint, account, token or live readiness state was queried.

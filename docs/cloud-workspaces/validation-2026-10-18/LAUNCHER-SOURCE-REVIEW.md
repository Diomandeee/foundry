# Build pilot launcher — bounded source review

Date: 2026-10-18. Repository: `/Users/mohameddiomande/Developer/foundry-integration/source`.

**Current disposition after final repair readback: F1 and F2 are resolved at source level. No additional actionable high-risk finding in this bounded readback.** This is not runtime, deployment or containment approval. The original findings and initial fingerprints below remain as historical evidence; their descriptions of missing checks do not describe the repaired files.

Read-only product review of `tools/foundry-build-pilot/{config,host,storage,verify,cli,index}.ts` and its TypeScript config, with targeted tracing into the runtime controllers, liveness, journal, isolated adapters, broker factories, claim resolvers and server verification path. Only this report was written. No tests, compilation, product imports, CLI execution, credentials, SQLite opening, helper/VM/container/mount operations, networking, activation, deployment, subagent or cron occurred.

## Final repair readback — 2026-10-18

The parent confirmed both launcher repairs had landed and requested this final bounded readback. Reviewed the actual current files rather than inferring repair from that notification. Product source was read only; this report is the only write. No tests, typecheck, product execution, SQLite opening or operational actions were performed.

### F1 resolved — strict target travels through client and server

- `tools/foundry-build-pilot/verify.ts:6`–18 now requires environment/authority alongside job/attempt/epoch in its copied, frozen configuration. Lines 38–40 send all five target fields only to `/v1/builds/verify-target`; there is no legacy-route fallback. Lines 51–57 require exact successful identifiers and an exact source object matching environment, authority and epoch, including replay replies. The verifier credential remains separate and is the only reference resolved on this path.
- `workers/compute/src/authority.ts:128`–134 admit the new route with exactly those five fields and reauthenticate after body parsing. Lines 146–148 construct the strict target, await verification, and only then add the wrapper's actual environment/authority source. Those identities are the same constructor values passed to `BuildAuthority` at line 62. The legacy `/v1/builds/verify` contract remains available for compatibility; the launcher does not use it.
- `packages/build-jobs/src/authority.ts:135`–144 retain verifier-role and epoch enforcement, snapshot/validate the target, and compare actual environment/authority and the attempt's stored job before replay, build clock/sweep or artifact reads. `epoch` at line 20 is a read/validation operation. The capture transaction repeats target admission. Line 147 repeats it inside the final transaction before receipt insertion and success updates, alongside existing generation/state/deadline fences. The copied target cannot be changed by the caller during artifact awaits. A wrong target therefore cannot finalize a different job via the new route, nor receive an accepted cross-target replay.
- Source-read regression evidence: `verify.test.ts:9`–23 asserts the exact new URL/body and rejects wrong source/identifiers; `packages/build-jobs/src/authority.test.ts:125`–144 checks no reads/table mutations on mismatch, matching replay and caller mutation; `workers/compute/src/enrollment-runtime.test.ts:274`–283 covers strict route target/role/epoch/shape rejection. These tests were read, not run here.

### F2 resolved — exact admission and cancellation precede scoped opens

- `tools/foundry-build-pilot/storage.ts:45`–57 copies validated owner config and defines admission against branded context plus source, project/input, server/local profile, job, worker, authority, epoch, generation, incarnation and actual attempt/lease. Input and result entry points at lines 80–89 invoke admission before initialization and again after its await; result resolution additionally validates job identity/profile before opening.
- Lines 48–49 and 71–89 use separate cached input/result assembly promises. Input assembly opens only input pairs; result assembly opens only the publication pair. Rejected initialization remains cached, so cancellation/open failure does not silently reset or retry it.
- Lines 59–62 pass the signal to each physical open and check cancellation before the first and after each awaited open, before proceeding to another. The namespace loops also check before/after awaits. Native opening at lines 23–35 checks before/after each asynchronous filesystem boundary and around synchronous SQLite opening. Abort observed while the first open is pending prevents subsequent opens. Already-returned handles remain retained; no close/reset is introduced underneath late provider work. Native cleanup closes only its own not-yet-returned handle when admission fails.
- Downstream `workers/library-broker/src/claim-inputs.ts:43`–55 still enforces the actual-claim match and one-compute binding before constructing namespaces; the launcher admission agrees with those checks. Source-read `assembly.test.ts:100`–131 covers a genuine mismatched-generation claim with zero opens, cancellation during a pending open, retained failures, result-only paths and an untrusted context. Its input-phase assertion at line 63 checks that publication handles have not opened. Tests use boundary fakes/in-memory databases; none were executed during this review.

### Verification limits and fingerprints

Parent reports root TypeScript checking passed for the current files and 58 strict core/workerd tests passed. Those are parent-reported results, not independently executed results of this review. The original RTD limits remain: source tracing supports these two repairs, not native filesystem race resistance against the trusted same-UID owner, physical cancellation/containment, or service readiness. HTTP cancellation can still leave a server outcome unknown; the launcher correctly does not turn that into success or an automatic retry.

Read commands used `nl -ba`/`sed` for the cited source and tests, `rg -n` for target/route/controller validation, and `shasum -a 256` for readback identity. `git rev-parse HEAD` remained `cf27ac662730bb98a509af8d1d1ebea4342eef7a`. Report directory command: `mkdir -p /Users/mohameddiomande/Developer/foundry-integration/source/docs/cloud-workspaces/validation-2026-10-18`; report write is verified with `ls -la` at the exact assigned path.

Launcher storage/verify changed from the initial review fingerprints below. The following repaired product files had identical hashes at the beginning and end of this final readback; config/host also retained their original hashes. This remains a shared-tree observation, not an atomic snapshot or approval of subsequent edits.

| Final reviewed file | SHA-256 |
| --- | --- |
| `tools/foundry-build-pilot/storage.ts` | `c9edf43e693a479a863da9dcf83068c4775c5c6ce928e1a20aac8c2bbe0e4348` |
| `tools/foundry-build-pilot/verify.ts` | `fa95f3feade9f86d3d760749d4cee45612201a6310f1436a11dff263a40c81d0` |
| `packages/build-jobs/src/authority.ts` | `5dcbe1777f8fbfc27a23994732c1d7244b33dad26668ab4241a8cfe1eea906a8` |
| `workers/compute/src/authority.ts` | `4397f3e0fa0c2e58bda23e314c5721232451891a7a8ede164b9f594f6ab39b6c` |
| `tools/foundry-build-pilot/assembly.test.ts` | `9b8d63b0816d56b51a0c043d389ab8d968c563f5f58a0fee225b998d676d004f` |
| `tools/foundry-build-pilot/verify.test.ts` | `6d242b0b3f43cf204e409b9f375a6dd83d3d7b8d0f16c9b5687c8913ad1dc520` |

## Original review and findings — preserved history

Everything below records the initial review before the repairs above, including the original line numbers and open-finding wording.

### F1 — P1: Bind the approved verification target before the server finalizes it

Primary evidence: `tools/foundry-build-pilot/verify.ts:38`–39 (mutating request), `:51`–52 (job validation only after response), and `:6`–12 (no environment or authority pin in config).

The parser accepts any syntactically valid `jobId` and `attemptId` pair. `verifyAttempt` sends only `{expectedEpoch, attemptId}` to the mutating endpoint and checks the configured job only after receiving a successful response. A config pairing intended job A with an existing, otherwise verifiable attempt of job B therefore finalizes B before the launcher rejects the returned `jobId`. A client-side failure does not undo the server mutation.

This follows the actual server path: `workers/compute/src/authority.ts:129` accepts exactly epoch/attempt for verification, and `:146` invokes `BuildAuthority.verify`. In `packages/build-jobs/src/authority.ts:138`, the server derives the job from the supplied attempt; `:141` inserts the receipt and marks that job/attempt `SUCCEEDED` before returning its identifiers. The caller's configured job is never available to enforce as a precondition. This is a source-derived counterexample, not an executed request.

The same target-binding boundary is also missing environment/authority pins. `VerifyConfig` cannot express them, and the verifier response has no `source` identity. The launcher can report `verified` after an origin is rerouted to another authority accepting the credential if the local job/attempt identifiers and epoch coincide. Unlike worker execution and broker access, this path has no authority-source check. This does not assert a forged TLS endpoint or universal credential reuse: the failure condition is an accepted credential at an unintended authority behind the configured origin.

**Required repair:** carry the owner-approved job and environment/authority identity into an authenticated verification precondition and enforce it on the server before finalization (including replay identity checks); then bind the returned result to that identity as well. A response-only check or a non-atomic preflight is insufficient to undo a wrong-job finalization or protect against a subsequent routing change. The current exact-body server contract must be coordinated with the parent; do not silently append fields that it rejects. Preserve independent verifier-role enforcement and do not resolve an owner credential as a fallback.

**Suggested parent acceptance cases, not run here:** mismatched job/attempt makes no verification-state mutation; wrong authority/environment is rejected before commit; matching target succeeds; matching completed target can return an explicitly verified replay; uncertain HTTP outcomes do not become success.

### F2 — P2: Admit the exact claim and cancellation state before opening namespace databases

Primary evidence: `tools/foundry-build-pilot/storage.ts:45`–62 (signal-free initialization of all input and result DB pairs), `:64`–69 (initialization precedes resolver matching). Native RW open is at `:26`–31.

`resolveInputStorage` and `resolveResultStorage` establish only that the context is controller-branded and the signal is initially live, then await `ready()`. That operation opens **every** configured input DB pair and the result DB pair. Exact job/input/profile/epoch/generation/incarnation/worker matching runs only afterward inside `workers/library-broker/src/claim-inputs.ts:43`–55. A genuine controller context for a newer generation than the configured approval consequently opens the approved paths before being rejected. Branding proves provenance, not that this particular owner policy authorized the claim.

Cancellation has a concrete additional failure path: if abort occurs during the first `await ports.openDatabase(...)`, initialization has no signal and continues opening the broker DB, all remaining input pairs and the result pair. Only the downstream resolver notices cancellation after those opens finish. Native SQLite opens are read/write; they are not inert metadata checks. Even an input-only resolution is coupled to availability of the result DB, so an inaccessible output DB prevents input resolution before output storage is needed. Handles are intentionally retained until process exit, amplifying unnecessary opens.

**Required repair:** validate the complete actual-claim match against the immutable policy before any file open; propagate cancellation through initialization and check it before and after each awaited open. Separate lazy input/result assembly so a read phase does not open the publication namespace. Preserve rejection of a failed assembly rather than automatically resetting/retrying it. Do not close handles underneath already-started provider operations as a shortcut.

**Scope of this finding:** later resolvers do still reject unmatched/cancelled contexts, so this is not evidence that foreign-claim grants, source bytes or physical builds are authorized. It is a violation of the scoped opening and cancellation boundary, with unnecessary RW DB access and readiness failures. The file-path checks themselves are not the identified defect.

**Suggested parent acceptance cases, not run here:** genuine mismatching claim causes zero database opens; abort while the first open is pending prevents all subsequent opens; valid input resolution opens only input namespaces; valid publication opens only its result namespace; previously failed initialization cannot silently reset.

## Other reviewed boundaries

### Config and preparation

- `config.ts:56` copies bounded canonical inert data before validation; `:120` recursively freezes the result. `prepareHost` parses again and uses that private snapshot. Mutation of the caller's raw JSON after preparation does not repoint stored paths, profiles, namespace approvals or credential reference names.
- Profile/job hashes and exact claim policy are cross-checked at `config.ts:62`–78. Namespace approval project/profile/publication roles are checked at `:86`–98. Paths and credential references are bounded; control and broker paths and namespace names must be distinct.
- The config's `activationReceiptSha256` is an explicit operator confirmation marker compared for equality at `host.ts:28`, not a cryptographically verified approval artifact or a hash recomputed from the entire config. The report does not treat it as attested approval provenance. The owner-controlled private config and explicit matching invocation remain trust inputs.
- `prepare` calls constructors and pure validators, not the run path. The GCS validator's throwing ports in `config.ts:100` are intentionally inert validation dependencies; production provider methods are supplied in `storage.ts:56`. The readonly tree-seal validator likewise does not run its helper during construction.
- Mac preparation can establish the existing process-local CAS singleton's pin identity through the concrete factory. This is an in-memory lifetime constraint, not filesystem/helper activation; a single process cannot freely prepare unrelated CAS pin sets afterward.

### Actual composition and credentials

- `host.ts:18`–20 calls `createLinuxIsolatedBuildWorkerController` or `createMacVmBuildWorkerController`. Their real `NodeWorkerLiveness`, concrete isolated adapters, `BuildWorkerController` and `NodeBuildTransport` are present. Linux uses the actual project-input resolver; Mac uses a real broker reader for metadata with an independently checked readonly source image.
- `storage.ts:61`–62 uses the real claim resolvers. They construct `createBuildNamespaceSet`, actual GCS reader/writer, online authority access client, durable broker capacity/issuer/reader ports and namespace binding checks. There is no success stub for publication or verification.
- The throwing `authConfig` callback at `storage.ts:55` is not an unimplemented required port on the launcher path: no broker HTTP handler is exposed or called; direct scoped ports enforce their existing claim and principal checks. Invoking that host's HTTP handler would fail closed.
- `config.ts:60`–61 requires distinct executor/access/verifier reference names; `:98` excludes them from provider reference names. Only the needed named environment reference is resolved. No discovery of ambient gcloud/SDK identity is added. Different reference names are not proof of distinct underlying token values or principals; server roles and verifier independence remain necessary.
- Run does not resolve the verifier reference. Verify resolves only its own reference, rechecks it before reporting success, and does not resolve the listed `otherCredentialRefs`. The server's verifier check also rejects the attempt executor and job submitter principal. There is no automatic owner fallback.

### Existing SQLite files and namespace identity

- Native opening checks a canonical symlink-free path, a private owner directory, owner/private regular-file metadata and one link before RW open. It checks device/inode/link identity afterward and closes on failure (`storage.ts:21`–32).
- Distinct string paths and private ancestors reduce accidental alias/replacement; the code does not claim to isolate against the trusted same-UID owner. Node's SQLite open lacks a create-disabled option here, so checking existence is not an atomic no-create guarantee against such an owner racing the pathname. No hostile same-UID containment claim is made.
- The downstream broker control DB compares its full persisted schema and binding to the approval when nonempty; it rejects mismatched recovery rather than rebinding. Empty pre-provisioned DB files are initialized by the explicit factory path. Thus `run` can create schema/state inside approved existing files; it is not a readonly DB operation.
- A supplied result namespace is immutable for the actual claimed compute binding once constructed. There is no namespace rollover, budget reset, filesystem cleanup or listener in the launcher. F2 addresses *when* these handles open.

### Restart, cancellation and outputs

- The host closure is one-shot (`host.ts:27`, `:34`), and the durable controller intent is created before first HTTP. `HostJournal.controllerIntent` uses exclusive controller slot and per-key journal creation (`packages/build-runtime/src/host.ts:60`–63). Existing controller/host slots and retained attempt evidence prevent silently rerunning an ambiguous attempt. Changing an in-memory `invoked` flag through process restart does not remove these disk fences.
- Worker execution is subject to explicit activation flag/receipt, OS/architecture and real/effective UID/GID gates at `host.ts:26`–33. Installed pins, host accounting, broker access, source verification and runtime reservation checks remain in their concrete implementations. None were probed here.
- The CLI installs cancellation handlers scoped to `main`, passes the signal, uses exit codes rather than forced `process.exit`, and sanitizes errors/output. It does not add an automatic retry loop, slot reclamation or cleanup. Storage's late opening gap is F2.
- Verification has a bounded response, native-fetch cancellation, monotonic deadline checks and fail-unknown error handling. It can receive a server replay after a previously completed verification, which is explicitly distinguished. Cancelling HTTP does not prove that an already accepted server operation rolled back; no such proof is claimed by its error path. F1 must still be fixed before its success means the complete owner-approved target was verified.

## RTD and evidence limits

| Level | Review evidence |
| --- | --- |
| Structure | Seven initial launcher files existed and were read; assigned report directory created explicitly and report verified by `ls -la`. |
| Compilation | Not run or inferred from source. Parent owns checks. |
| Integration | Static tracing through actual factories, auth, journal, namespace and server verification implementations. No runtime execution. |
| Content | Concrete authorization ordering and cancellation counterexamples with line evidence above. |
| User journey | Source-traced prepare → run → claim → storage → stage and separate verify, including prior-run/cancel paths. Not an operational proof. |
| Deployment | Not authorized and not performed. No installation/activation/provisioning or kernel-containment evidence. |

## Concurrent editing and fingerprints

All seven initial launcher files had identical SHA-256 values at the initial inventory and final product readback. Banach added test files during review: `fixtures.test.ts` appeared transiently, followed by `test-fixtures.ts`, `config.test.ts` and `verify.test.ts`. Their presence is noted only; no test result or complete test review is claimed. Future source changes require rechecking affected findings. This is a shared working tree, not an atomic repository snapshot.

| Reviewed file | SHA-256 |
| --- | --- |
| `tools/foundry-build-pilot/config.ts` | `7bf0eaeb917a2b31db9df2bc84a7481c26b808791466f1be697e6b91db48ef3a` |
| `tools/foundry-build-pilot/host.ts` | `b05dc266e6f84034fefd1da4683272115006a6cc0ad16e93e8cbbd8bdecfcc9c` |
| `tools/foundry-build-pilot/storage.ts` | `8e68688e801193d72bffe9a3dd8fd996ee27b2c213c1c9fdc4ba17c3fd29a693` |
| `tools/foundry-build-pilot/verify.ts` | `10d8b3207253ebd262c0fde5d8c2e59e86c7dafae74b2057449b10db65d62561` |
| `tools/foundry-build-pilot/cli.ts` | `9d08b1da1943624b2b22f277f4fdb0a87f5c40b09d4a4cbb61f888688a2db0fc` |
| `tools/foundry-build-pilot/index.ts` | `73c7607b1078f84c1dc9b7afcb56717e15388c0e955ecd928d1d7eb1a63b38ad` |
| `tools/foundry-build-pilot/tsconfig.json` | `021dda24f79968f0a4747a310e78df2000c7c5fbb46e681587ddb5fcb029a32c` |

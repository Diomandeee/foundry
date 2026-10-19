# BUILD launcher implementation receipt — 2026-10-18

Status: **implemented, scoped strict compilation passed, 43 scoped tests passed;
product/test source frozen; operational activation HOLD.** No live build,
verification, installation or service execution is claimed.

Repository: `/Users/mohameddiomande/Developer/foundry-integration/source` (shared
dirty checkout). Only new files in `tools/foundry-build-pilot/` and this assigned
report were written by this task. Existing runtime/server sources were not
edited. Parent owns coordinated `/v1/builds/verify-target` server implementation
and cumulative validation. No agents, cron, credential access, installation,
server listen, helpers/VMs/containers, provider/SSH/cloud operations, spend,
commit, merge or deployment were used.

## Concrete implementation

- `config.ts`: bounded private data-only JSON, exact fields, real approved parent
  profile binding, job/claim/liveness pins, distinct role references, actual
  object allowlists, finite namespaces and Linux/Mac installed-policy fields.
  No executable module loading or synthesized operational config.
- `host.ts`: real calls to `createLinuxIsolatedBuildWorkerController` and
  `createMacVmBuildWorkerController`, real `NodeBuildTransport`, existing
  liveness and controllers, Mac factory's concrete isolated CAS. Construction
  is inert; explicit receipt plus owner activation flag and host identity gates
  precede one `controller.run` call. No loop, replay or autoactivation.
- `storage.ts`: separate lazy input/result assembly through the actual
  `createClaimInputResolver` / `createClaimResultResolver`, actual
  `GcsBuildBrokerConfig` with pre-existing SQLite handles, real namespace/GCS
  reader/writer/reservation/issuer/online-authority ports. Mac metadata reads use
  the real admitted `projectObjectReader`; source image remains independently
  guarded. Handles are retained; no cleanup/reset/rollover/listener is added.
- `verify.ts`: one independently credentialed POST to new exact
  `/v1/builds/verify-target`; request `{expectedEpoch,attemptId,jobId,environment,
  authorityId}`. Exact success response binds `source:{environment,authorityId,
  epoch}`, job and attempt, with optional `replayed:true`. No legacy-route or
  owner/executor-credential fallback. No RequestInit casts hide Node options.
- `cli.ts`, `index.ts`: explicit prepare/run/prepare-verify/verify entry points,
  SIGINT/SIGTERM cancellation, awaited controller resolution, sanitized output,
  exitCode without forced process exit. Existing controller durable intent,
  trusted stop, quarantine and retained history own recovery semantics.
- `README.md`: complete config field reference, command shapes, gates,
  supported/unsupported paths, exact no-installation behavior and evidence
  limits. `tsconfig.json` is a scoped strict no-emit configuration using the
  existing dependencies. Three `*.test.ts` files and `test-fixtures.ts` are
  exclusively local synthetic test support, never installed owner values.

## Independent review repairs

Read `LAUNCHER-SOURCE-REVIEW.md` and incorporated the requested fixes.

**F2 repaired locally:** Before any DB open, validate genuine controller context
and exact owner claim policy: source environment/authority/epoch, job/project,
input, both profile hashes, worker, generation/incarnation, workload and actual
attempt/lease. Input and result assemblies are independently lazy. Cancellation
is checked before/after every awaited database open and assembly await. Failed
assembly promises remain failed; no automatic reset or retry. Tests prove a
genuine mismatched generation opens zero DBs; abort during the first pending
open prevents subsequent opens and stays failed; opening failure stays failed;
input resolves only input DBs; result-only resolution opens only result DBs.

**F1 coordinated with parent:** Original legacy verifier endpoint could finalize
an unintended job before the client rejected its response. Launcher now requires
authority identity and approved job in config and sends them as atomic server
preconditions to `/v1/builds/verify-target`, validating returned source and replay
shape. Parent stated the matching server implementation and strict targeted
checks are passing; no cumulative suite result is claimed here. Launcher tests
reject wrong environment, authority, epoch, job, attempt, unknown/missing fields,
HTTP errors, oversized data and cancelled late responses.

## Validation receipts and RTD

Executed from the explicit repository workdir:

```sh
node_modules/.bin/tsc --project tools/foundry-build-pilot/tsconfig.json --noEmit
node_modules/.bin/vitest run tools/foundry-build-pilot --maxWorkers=1 --no-file-parallelism
```

Final scoped result: strict compile exit 0; **3 files / 43 tests passed**, Vitest
reported 803 ms (13:39:05 local run). A preceding run exposed a test-only
Buffer/Uint8Array comparison mismatch; it was corrected before the final run.
No product/test edits occurred after this final green scoped run. Parent also
reported root typecheck passing for current launcher + target-bound server and
is running the cumulative suite. Only README/this report followed the freeze.

| RTD level | Evidence / limitation |
| --- | --- |
| Structure | Actual executable CLI, bounded owner config and direct real factory callers in the new directory. |
| Compilation | Scoped strict no-emit compile passed with existing node_modules; parent reported root compile passed. |
| Integration | Real Linux controller/supervisor/transport → branded claim → actual broker SQLite/GCS adapter/issuer/reservation → byte readback → stage path, with physical boundaries faked locally. Both platform factory constructions and concrete Mac CAS construction are inertly tested. |
| Content | No operational configuration or installed hashes/objects fabricated; test data explicitly synthetic. All required values fail closed. |
| User journey | Configure/prepare → one claim → admitted input read/publication → stage; cancellation → stop; denied access → quarantine; independent target-bound verifier responses. Tests are boundary-fake evidence, not a physical build or deployed verification receipt. |
| Deployment | HOLD. No install, activation, deployment or live helper/provider/verification operation occurred. |

## Explicit remaining assembly and operational gates

1. **Verifier broker route:** Compute's `BUILD_BROKER_ORIGIN` and
   `BUILD_BROKER_CREDENTIAL` must reach an independently authorized reader of the
   exact SQLite namespaces this host publishes. The launcher intentionally
   exposes no HTTP service/auth config, copies no grants and provisions no
   route. Until a separate approved deployment supplies that connection,
   publication/staging does not establish end-to-end independent verification.
2. **Parent-reported read-only inventory:** Mac1 ~29 GiB, Mac4 ~14.27 GiB, Mac5
   ~12.71 GiB free, all required `/Library/Foundry` helper/CAS/image paths absent.
   Existing 50 GiB plus job reserve and installed-pin gates remain HOLD.
3. **GCP:** selected-project Compute Engine API disabled; read-only listing was
   refused per parent inventory. No API enables or mutations were attempted.
4. Owner must separately approve/provision actual dedicated account/roots,
   namespace DB files, finite exact object references, enrolled identity and
   sequence baselines, provider/observer/verifier roles, runtime installed hashes
   and accepted images. Linux retains its one-attempt broker slot; Mac owner
   staging/intake remain explicit. No missing value is guessed.
5. Receipt flags are matching operator-confirmation markers, not proof or
   substitution for user approval. Separate reference names are not independent
   principal proof; the server role and attempt/submitter exclusions remain
   necessary. Node SQLite existence/identity checks assume trusted same-UID
   administrators do not race paths; no atomic no-create claim is made.

Use `tools/foundry-build-pilot/README.md` for the precise command/config contract.
Source is ready for parent cumulative review; operational readiness remains
explicitly unproved and gated.

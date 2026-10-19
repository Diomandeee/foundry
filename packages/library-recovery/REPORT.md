# Catalog recovery implementation receipt — 2026-10-17

## Delivered scope and changed paths

All authored files and retained check outputs are inside `/Users/mohameddiomande/Developer/foundry-integration/source/packages/library-recovery`. The exact directory was created with `mkdir -p` and verified with `ls -la`. No existing catalog, worker, service, broker, architecture or parent documentation files were edited by this lane. Other dirty work was preserved. No install, commit, push, cloud, secret access or deployment was performed.

Implementation and tests:

- `src/index.ts`: owner/binding checks, strict versioned archive, 16 MiB whole-archive limit, source transaction export, complete bounded journal/domain row preservation, externally trusted expected SHA requirement, entirely empty destination checks, atomic timestamped catalog replay, exact generated-row equality, native/explicit trusted DO storage adapter types.
- `src/content.ts`: independent exact-generation manifest/object byte verification through trusted bounded DI; no publication or activation.
- `src/recovery.test.ts`: 49 local Vitest cases, including native SQLite disk recovery, full lifetime capacity and adapter authorizer simulation.
- `package.json`, `tsconfig.json`, `vitest.config.ts`, `vitest.root.config.ts`, `.gitignore`: package metadata, strict compilation, package/root discovery and cache/fixture boundaries.
- `README.md`, `REPORT.md`: API, trust requirements, operations, validation and evidence limits.

Retained evidence: `test-results.txt`, `package-typecheck.txt`, `root-typecheck.txt`, `discovery.txt`, `adapter-test-results.txt`, `content-test-results.txt`. Empty `package-typecheck.txt` accompanies successful exit status, rather than a TypeScript diagnostic. `.cache/` and `.fixtures/` are local generated directories; test SQLite files were cleaned up.

## Final executed checks

From `/Users/mohameddiomande/Developer/foundry-integration`, using existing dependencies:

| Check | Result |
| --- | --- |
| `source/node_modules/.bin/tsc -p source/packages/library-recovery/tsconfig.json` | PASS, strict, no diagnostics |
| `source/node_modules/.bin/vitest run packages/library-recovery --config source/packages/library-recovery/vitest.root.config.ts --configLoader runner` | PASS: 49/49, 1 file, 27.31 seconds |
| Full source-root `vitest list --filesOnly`, using `vitest.root.config.ts` and runner loader | PASS: 64 discovered files, including this recovery suite |
| Focused owner/emptiness/replay/constructor/DO-adapter cases | PASS: 22 cases; final full 49-case run supersedes this subset |
| Focused content byte rehearsal | PASS: 7 cases; final full run includes the final binding-validation implementation |
| `source/node_modules/.bin/tsc -p source/tsconfig.json` | BLOCKED outside this package, latest captured output: `workers/library/src/archive-body.ts:8:66`, `ignoreBOM` missing in Cloudflare `TextDecoderConstructorOptions` |

The latest root compiler limitation was reported to the parent and left untouched. Earlier concurrently changing parent/broker errors were superseded by the latest captured root diagnostics. No claim is made that all discovered suites were executed: only this recovery package's tests ran. Root discovery intentionally scans all source test files while keeping this lane's cache inside the package.

## Evidence established

A real file-backed SQLite source with publication, independent verification, canonical winner/rejected CAS, cancellation, a successor attempt and policy revocation was exported to a separate file-backed destination. After closing/reopening both handles, destination snapshots and every committed command reply matched exactly. Original lost replies remain stable after expiry/revocation; fresh stale attempts, stale publication, cancellation publication and revoked-policy publication remain denied. Owner-only `sys-revoke-*` cancellation keys retain their replay behavior and reject writer preemption.

A maximum catalog containing **225 immutable records and all 1,057 committed commands (1,024 normal plus 33 controls)** exported and replay-restored without truncation. Its post-restore export equaled the original exact archive. Rejected CAS replies survive even when no domain row was added for those commands.

Tampered archives fail even when the supplied archive digest is recomputed. Cases cover actor/request/command digest/reply/time/control/domain-row changes, missing/extra evidence, malformed/truncated/oversized JSON, duplicate keys, extra fields, schema/namespace/binding mismatch, bad sequences and field/count budgets. A forged expired authorization with both a recomputed command digest and recomputed archive digest fails actual catalog replay (`EXPIRY`), despite self-consistent request/record hashes.

Replay executes the actual `LibraryCatalog`, using each original command timestamp through its DI clock. It does not import trusted-looking rows directly. Complete generated SQL records, stored canonical actor/request/reply strings, digests, times, control bits, schema and binding must equal the archived values before commit. On constructor/DDL/meta/journal/replay/comparison failure, the enclosing destination transaction rolls back schema and data. Native destination tables/indexes/views/triggers/temp state, initialized catalogs, attached database state and nonzero user/application versions are rejected without changing existing evidence. Export refuses partial/altered schema and oversized row text without repair.

Content rehearsal independently reads the actual pinned manifest generation, validates its byte hash/size and canonical v1 structure, then checks every exact immutable object generation and actual byte hash. Missing, corrupt, truncated and wrong-generation reads keep `contentVerified: false` while restored metadata remains unchanged. An empty catalog cannot assert content verification. Catalog metadata restoration never itself declares content verified.

## RTD six-level verification

1. Structure: package files and exact output directory verified. All authored outputs remain within the assigned package.
2. Compilation: strict package TypeScript passes; latest full-root compile has the parent-owned limitation recorded above.
3. Integration: real SQLite transaction port and current catalog schema/core imports exercised; file source → separate destination → restart succeeds. Reserved owner cancellation-key compatibility passes. Trusted DO adapter selection is locally simulated.
4. Content: full domain/journal equality, semantic forgery rejection, byte/hash and immutable generation checks pass.
5. User journey: authenticated-owner host API → complete export → independently pinned digest → empty destination restore → restart/lost-reply replay → separate content rehearsal exercised locally.
6. Deployment: GATED / NOT RUN. No live activation, installation, release, network, storage broker or cloud claim.

## Proof limits and parent handoff

The host must authenticate the owner context and supply trusted exact binding/configuration and transaction semantics. An expected archive SHA-256 copied from an untrusted archive envelope is not authentication. Replay rejects impossible histories; it cannot distinguish a coherent replacement/prefix history from authentic history if the supposedly trusted expected digest is itself replaced. Preserve the external trusted backup pin.

The default `RecoveryDestinationPort` keeps all native SQLite checks. A host may explicitly set `storageKind: 'cloudflare-sqlite'` only for the actual DO runtime. That mode always checks the entire visible main schema for emptiness and retains full atomic semantic replay; it relies on DO runtime restrictions for attachments/temp schema/identity PRAGMAs rather than querying forbidden APIs. The lane proves explicit selection and fail-closed native behavior through a deny-list simulation. **Actual DO authorizer restrictions and HTTP restore/export integration are parent-owned, not verified here.** There is no automatic authorizer-error fallback and no request/archive-controlled storage-kind selector.

Content limits are deliberately bounded: 4,096 distinct refs, 64 objects per manifest, 64 KiB manifest, 8 MiB object and 32 MiB attempted reads per rehearsal. Larger catalog refs can remain valid restored metadata while rehearsal returns unverified. The exact catalog reference set includes historical/staged/cancelled references; those bytes may be unavailable. This does not establish whole-bucket inventory, full-project recovery, current compute acceptance, cloud availability or production disaster-recovery readiness. No new attestations, capability grants, publication, promotion, fence reset or live authority activation is produced.

Parent owns durable revocation delivery/service wiring and actual DO endpoint tests. The other worker owns broker integration. The API is available from `src/index.ts`; constructor/schema/core changes were unnecessary in this lane.

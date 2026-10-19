# @foundry/library-catalog

A synchronous, per-project, dependency-injected SQLite domain. It durably stages transfer intents, fences metadata publication, records explicit independent host attestations and immutable competing candidates, and promotes through canonical revision compare-and-swap. It has no merge authority.

Public API: `new LibraryCatalog(port, options)`, `execute(context, envelope)`, `snapshot(context)`. Import these and exported types from `src/index.ts`. See [API.md](API.md) for exact operations, role/principal policy, transfer binding, idempotency, limits and adapter responsibilities.

A transfer binding preserves project/policy version/hash, compute authority/workload/lease/attempt/capability digest/worker/epoch/generation/numeric incarnation, and exact immutable manifest path/generation/hash/size. It contains metadata, never raw capabilities, bulk file contents or upload session URLs. This package trusts authenticated host verifier attestations as explicitly attributed claims; it does not infer actual bytes from domain rows.

Publication requires the current local generation, no cancellation/revocation, live transfer authorization and a matching unexpired host attestation. Publication, independent verification, candidate creation and canonical promotion are separate. Published verified history remains promotable after transfer/attestation expiry or transfer cancellation; terminal policy revocation blocks new promotion. Stale CAS proposals retain their immutable candidates.

Lifetime capacity is 32 intents, 192 normal domain records and 33 separately reserved safety records; the command journal permits 1024 normal commands plus 33 safety commands. Cancellation/revocation are tested at simultaneous data/journal saturation. Stage/reauthorization reject bindings that cannot fit a worst-case legal attestation. These are bounded lifetime histories, with no production retention/migration scheme. Snapshot inspection is capped at 512 KiB and omits command replay/audit state; it is not a restore backup.

Local checks from this package directory, using the repository's existing dependencies:

```sh
node ../../node_modules/typescript/bin/tsc --project tsconfig.json
node ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts --configLoader native
```

The native config loader and package-local cache directory keep generated test files within this package. Tests use real `node:sqlite`, transaction rollback injection, disk reopen and 20 independently opened catalog instances sharing one database. They do not prove simultaneous execution across worker threads; serialization is the injected transaction port's contract. The parent service owns actual workerd/transport and aggregate checks.

No installation, network, broker/job runtime, credential access, commits, push or deployment is part of this package. Cross-authority compute revoke observation/delivery, live byte reads, full restore, production history retention and deployment remain host/integration work with their existing gates. Local completion confers no operational authority.

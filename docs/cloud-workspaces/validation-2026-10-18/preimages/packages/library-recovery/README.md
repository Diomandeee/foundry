# Full catalog recovery (local host library)

This package adds complete bounded export and atomic restore without changing `library-catalog` or its schema. The owner snapshot is a projection; it is not a backup. This archive includes the exact namespace and schema SQL, policy/principal/environment/authority/project binding, every immutable domain row, and every command sequence/key/actor/request/digest/reply/time/control row. The lifetime maximum is 1,024 normal commands plus 33 controls and 225 records. No rollover, identity migration, or fence reset is performed.

## Host API

```ts
import {
  exportCatalog, importCatalog, rehearseContentRecovery,
  type RecoveryBinding,
} from './src/index';

// Existing synchronous SQLite TransactionPort, with serialized writers and
// rollback of all DDL/data when the synchronous callback throws.
const backup = exportCatalog(sourcePort, exactBinding, authenticatedOwner);
// Store backup.archive as exact UTF-8 text. Protect metadata confidentiality.
// Record backup.sha256 through an independently authenticated channel.

const restored = importCatalog(
  emptyDedicatedDestinationPort,
  exactBinding,
  authenticatedOwner,
  exactArchiveText,
  independentlyTrustedExpectedSha256,
);
// restored.metadataRestored === true; restored.contentVerified === false.

const bytes = rehearseContentRecovery(
  destinationPort, exactBinding, authenticatedOwner,
  { readObject: trustedAuthorizedBoundedExactGenerationRead },
);
```

`RecoveryBinding` is `Omit<LibraryCatalogOptions, 'now'>`. The owner context uses the existing `LibraryContext` type. `exportCatalog` returns `{ archive: string, sha256: string }`. `importCatalog` returns `{ archiveSha256, commands, records, metadataRestored: true, contentVerified: false }`. It returns a receipt, not an activated catalog. A host can reopen `LibraryCatalog` against the restored port after success.

The host authenticates the owner independently of JSON request labels and supplies trusted configuration, context, SQL port and content adapter. This package enforces the owner role, configured owner principal and exact identity match; it does not implement a login or HTTP endpoint. Never expose a route that accepts its context or expected digest from the same untrusted payload as the archive. The digest returned by export is an integrity value; hashing an attacker-provided archive is not authentication. The expected SHA-256 must come from a separately trusted owner backup record/channel. Replay does not authenticate a coherent replacement history.

The metadata format has no credential or capability fields; compute capability digests are preserved. It remains sensitive: actor identities, request/reply history, provenance, reasons, compute fences and content references are included. Free-text provenance/reasons must be handled as sensitive metadata. No credentials, read grants, upload sessions or raw capabilities are created by recovery.

## Atomicity and validation

Export uses one transaction, checks exact schema/binding, SQL row counts and UTF-8 field budgets before fetching row text, and emits one strict versioned JSON archive of at most 16 MiB. The limits preserve the entire journal, including rejected CAS replies and reserved cancellation/revocation controls. Export never initializes or repairs the source.

Import requires exact archive text and an externally trusted lowercase SHA-256. It rejects truncated/oversized/malformed JSON, duplicate keys, extra/missing fields, alternate encodings, unsupported schema/namespace and any expected binding mismatch. The default native SQLite adapter requires no main/temp schema objects, no attached databases, and zero SQLite user/application identity versions. A destination containing even an initialized empty catalog is rejected. Schema objects, sentinel rows and nonempty catalog evidence are never dropped, overwritten or truncated.

For Cloudflare DO SQLite authorizers that disallow the native PRAGMA/temp introspection queries, the host can supply `RecoveryDestinationPort` with `storageKind: 'cloudflare-sqlite'`. This is an explicit trusted storage adapter selection, never an archive field, request parameter or error fallback. It still rejects **every visible main schema object**, including unrelated tables, before initializing. It relies on the actual DO runtime to prohibit attached databases, temp schemas and application/user identity PRAGMAs. Selecting this mode for ordinary SQLite is unsupported. Native/default mode retains every original check and fails closed on authorizer denial. The package tests the adapter-selection contract with a deny-list simulation; the parent owns actual DO authorizer/service evidence.

Inside one writer transaction it constructs a fresh `LibraryCatalog` on the empty destination, using a participating port whose nested callbacks stay within the outer transaction. Each command is executed with its archived actor/request and `now = command.at`. Replaying the actual catalog validates original authorization, expiry, generation fences, cancellation, revocation, publication and canonical CAS semantics. The complete generated schema, binding, domain rows and journal rows must equal the archived exact SQL values before commit. A recomputed command/archive hash cannot make an impossible command pass replay. Any constructor, schema, SQL, command or comparison failure rolls back schema and data. A port that does not honor the transaction contract is unsupported.

## Independent content rehearsal

Rehearsal reads all distinct immutable references from intent, authorization and transfer-attestation records, including old generations and cancelled intents. Direct object references are verified directly. For manifest references it reads the exact manifest generation, checks actual size/SHA-256 and the canonical v1 `library-jobs` manifest bytes, then checks every referenced exact object generation and actual bytes. It compares returned reference metadata too. No latest-version fallback, wildcard listing or worker-supplied object list is accepted.

The trusted adapter must authorize each reference and enforce the supplied byte limit before allocation. Rehearsal also defensively copies and bounds returned bytes. Limits are 4,096 distinct references, 64 objects per manifest, 64 KiB per manifest, 8 MiB per object, and 32 MiB total attempted byte reads. Exceeding these rehearsal limits yields an unverified result, without affecting successful metadata restoration. Duplicate immutable references are read once; conflicting identity claims fail closed. Missing/corrupt/unreadable bytes produce per-reference failures and `contentVerified: false`. An empty catalog does not assert content verification.

This is a local check of the exact catalog reference set, not whole-bucket inventory or full-project recovery proof. It does not recreate historical compute acceptance, mint new host attestations, publish snapshots, promote candidates, deliver revocations, or enable live service. Current byte readability and historical catalog attestation are distinct evidence.

## Local checks

Run from `/Users/mohameddiomande/Developer/foundry-integration` with existing dependencies:

```sh
source/node_modules/.bin/tsc -p source/packages/library-recovery/tsconfig.json
source/node_modules/.bin/vitest run --config source/packages/library-recovery/vitest.config.ts --configLoader runner
source/node_modules/.bin/vitest list --config source/packages/library-recovery/vitest.root.config.ts --filesOnly --configLoader runner
source/node_modules/.bin/vitest run packages/library-recovery --config source/packages/library-recovery/vitest.root.config.ts --configLoader runner
source/node_modules/.bin/tsc -p source/tsconfig.json
```

The root-discovery config scans the complete source tree while keeping this lane's cache inside this package. Test SQLite files are created and removed only under `.fixtures/` here. Other workers' files remain untouched. No install, network, cloud, deployment, commit or push is part of these checks.

# Library catalog API v1

The public entrypoint is `src/index.ts`. It exports `LibraryCatalog`, `LibraryRejected`, `LibraryCatalogOptions` (`Options` alias), `LibraryContext` (`TrustedContext` alias), `LibraryEnvelope`, `LibraryBodies`, `LibraryOperation`, `LibraryReply`, `LibrarySnapshot`, `LibraryRecord`, `TransferBinding`, and `TransactionPort`.

```ts
const catalog = new LibraryCatalog(port, {
  environment: 'local', authorityId: 'catalog-authority', projectId: 'example',
  policy: {
    version: 'policy-v1', ownerPrincipal: 'project-owner',
    writerPrincipal: 'project-writer', verifierPrincipal: 'project-verifier',
  },
  now: () => Date.now(),
});
const reply = catalog.execute(trustedHostContext, envelope);
const view = catalog.snapshot(trustedHostContext);
```

Options and the clock are injected. `transactionSync` must synchronously serialize project writes and roll back all SQL changes when its callback throws. SQL cursors are synchronous iterables; the port matches the epoch-chain pattern and Cloudflare SQLite storage. The package performs no asynchronous side effects.

## Identity and host boundary

The host authenticates the principal and uses a fixed allowlisted project map. Each catalog instance binds one environment, authorityId, projectId and policy. Never accept context from client JSON. Context has exactly `{environment,authorityId,projectId,principal,role}`. Host owner/submitter/verifier maps to domain owner/writer/verifier. Each role must match its configured principal; all three principals must differ. Owner configures bound options, reauthorizes, revokes, cancels and promotes. Owner cannot publish or attest merely by selecting those operations. No role has code-merge authority.

Changing constructor options cannot overwrite an existing binding. This version has no reconfiguration or migration command. A new policy requires an explicitly reviewed migration/new authority. Existing schema tables, triggers and stored binding are checked before writes; incomplete/wrong schemas fail without repair. The same checks apply to already-open instances.

## Exact command bodies

Every envelope has exactly `{operation,key,body}`. Every body has `version:1` plus exactly these fields. `src/types.ts` is the authoritative exported TypeScript shape; runtime validation rejects unknown and missing fields.

| Operation | Authorized role | Fields besides version |
|---|---|---|
| stageTransfer | writer | intentId, binding, expiresAt |
| authorizeTransfer | owner | intentId, expectedGeneration, binding, expiresAt |
| cancelTransfer | writer or owner | intentId, reason |
| revokePolicy | owner | reason |
| attestTransfer | verifier | attestationId, intentId, generation, binding, manifestHash, bytes, hostAttestation, attestedAt, expiresAt |
| publishSnapshot | writer | snapshotId, intentId, generation, attestationId, provenance:{source,parentSnapshotId} |
| recordVerification | verifier | verificationId, snapshotId, hostAttestation |
| createCandidate | writer | candidateId, snapshotId, verificationId, expectedCanonicalRevision |
| promoteCandidate | owner | candidateId, expectedCanonicalRevision |

`TransferBinding` has exactly:

```ts
{
  projectId: string;
  policyVersion: string;
  policyHash: string; // lowercase SHA-256 from the host-authorized jobs policy
  compute: {
    authorityId: string; workloadId: string; leaseId: string;
    attemptId: string; capabilityDigest: string; workerId: string;
    epoch: number; generation: number; incarnation: number;
  };
  content: {
    manifestHash: string; objectKey: string; objectGeneration: string;
    objectHash: string; bytes: number;
  };
}
```

`content` pins the immutable **manifest object**, whose bytes pin the complete object set. `manifestHash` must equal `objectHash`. Only `projects/${projectId}/objects/${objectHash}` or `projects/${projectId}/manifests/${objectHash}` is accepted. Generation is a nonzero decimal string of at most 32 digits, without leading zeros. `bytes` is manifest size (maximum 1 TiB), not total object-set bytes. The parent maps a jobs `manifestRef` to these fields and carries jobs policyHash and all compute fence fields unchanged. `capabilityDigest` is a lowercase SHA-256 of a capability, never the raw capability. `leaseId` must be a nonsecret identity. This catalog cannot determine whether a caller mislabeled a secret as an ID; that remains a host responsibility.

Stage creates generation 1. Reauthorization CAS increments the local generation and may change compute fences/policyHash while preserving staged content; it cannot revive a cancelled or already-published transfer. Project and policyVersion must match the catalog binding. Expiry is integer milliseconds, strictly in the future, at most 24 hours from the injected clock. Both stage and reauthorization preflight a worst-case legal attestation's stored size, rejecting `ATTESTATION_CAPACITY` before creating an impossible authorization.

Attest requires exact current local intent generation and complete binding equality, a live local grant, unrevoked policy, matching manifest hash/size, `attestedAt <= now`, and `expiresAt > now`. `hostAttestation` is a lowercase SHA-256 reference/digest, not free text or an embedded receipt. Publish rechecks generation, cancellation, policy revocation, local authorization expiry and host attestation expiry, and requires an attestation for the same intent/generation. Every intent publishes at most one snapshot. Parent snapshot provenance references an existing immutable snapshot or null.

## Lifecycle and evidence scope

The flow is staged transfer → host content attestation → immutable snapshot publication → independent post-publication verification → immutable candidate → expected-canonical-revision CAS promotion. Each is a separate command. `attestTransfer` records `evidenceScope:host-content-attestation`; `recordVerification` records `host-independent-verification-attestation`; snapshot publication records `catalog-metadata-only`. The configured verifier is distinct from the writer. A record is an authenticated host claim: this domain neither reads bulk bytes nor proves the host really verified them. Provider/GCS callbacks and worker reports must never be routed directly as trusted verifier contexts.

Snapshot provenance, attestation and verification references, competing candidates, authorizations and cancellations remain immutable. Stale candidates are accepted and retained. Promotion requires both the command's expected canonical revision and the candidate's proposed revision to equal the current canonical revision. A loser returns accepted:false/code:CANONICAL_CONFLICT, commits an audit/reply, and retains the candidate. A winner appends one immutable promotion; canonical revision is the count of committed promotions. No timestamp/machine name/model inference selects a winner.

Publication seals the transfer authorization decision. **A legally published, independently verified snapshot remains promotable after local transfer expiry, host acceptance expiry, or later transfer cancellation.** Cancellation prevents future publication/reauthorization; it does not erase published history. Policy revocation blocks new attestations, publication, verification, candidate creation and promotion. This version has no candidate-withdrawal operation. Policy revocation and transfer cancellation are terminal.

Cross-authority compute revocation is not atomic with this catalog. Hosts must observe current authoritative compute acceptance before constructing attestations and deliver cancel/reauthorization/revocation when needed. The domain checks its current durable local authorization and the attested expiry; it has no live observer, broker grant, job dispatcher or compute/GCS transaction. No such runtime is claimed.

## Replies, idempotency and audit

Reply: `{version:1,accepted,revision,operation,id,canonicalRevision,generation?,code?}`. `id` identifies the appended record (promotion uses its canonical revision string); generation commands return the intent ID. Rejected canonical CAS attempts return the candidate ID. Other failures throw `LibraryRejected(code,status)` without committing. Authentication/role failures use 403, malformed input 400, and state conflicts/capacity/schema failures 409.

A key is catalog-global and digest-bound to canonical JSON of the exact trusted context, envelope, and immutable catalog binding. JSON property order does not matter. Reusing a key with a different request or principal/role throws IDEMPOTENCY_MISMATCH. Exact replay returns the original reply without reapplying, including after expiry/cancellation/reopen or command capacity exhaustion. Current context must still authenticate against the fixed policy. The replay is a historical result, not renewed permission to perform external work.

The command journal stores actor, request, digest, clock timestamp and reply atomically with domain changes. Its monotonic command sequence is the catalog revision. A canonical conflict is an audited command; other failed commands create no journal entry. Hosts may log failed HTTP attempts separately, with their own privacy policy. SQL triggers prevent update, deletion and identity replacement, including INSERT OR REPLACE, independently of recursive_triggers settings.

## Bounds and recovery boundary

This version has **lifetime** limits, with no pruning: 32 intents, 192 normal domain records, 33 safety records, 1024 normal command/audit/reply rows, and 33 safety command rows. The safety reserve covers one terminal cancellation for every admitted intent plus one policy revocation. Repeated cancellation/revocation with a new key rejects; exact key replay remains stable. Data and normal command saturation cannot consume this reserve.

Stored domain bodies are at most 1792 UTF-8 bytes; complete commands at most 8192, context/reply at most 1024, and options at most 2048. Identifiers are ASCII and at most 96 characters; derived authorization IDs may be longer. Hashes are exactly 64 lowercase hex characters. Human reason/provenance source is at most 256 characters without control characters. Numeric counters/timestamps are nonnegative safe integers (no negative zero). JSON accepts inert plain records/arrays only, bounded by depth, nodes and UTF-8 bytes; proxies, accessors, hidden fields, cycles, symbols and custom serialization are rejected. Snapshot traversal allows up to 65536 nodes to avoid starving safety commands at full record capacity.

`snapshot(context)` returns all bounded domain records plus canonical state, with an enforced 512 KiB maximum. It omits the command journal. It is an inspection projection, **not a recovery backup**. Recovery must preserve the complete SQLite namespace, including command keys/digests/audit/replies, schema/triggers and binding. Export/import, independent catalog/content restore verification, policy migration and production retention design are not implemented. Current lifetime limits are for a bounded local domain, not evidence of operational readiness.

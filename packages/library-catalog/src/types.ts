export type SqlValue = string | number | null;
export interface TransactionPort {
  sql: { exec(query: string, ...bindings: SqlValue[]): Iterable<Record<string, unknown>> };
  /** Must serialize writers and roll back every write if fn throws. No async callbacks. */
  transactionSync<T>(fn: () => T): T;
}
export interface LibraryContext {
  environment: string; authorityId: string; projectId: string;
  principal: string; role: 'owner' | 'writer' | 'verifier';
}
export interface TransferBinding {
  projectId: string; policyVersion: string; policyHash: string;
  compute: { authorityId: string; workloadId: string; leaseId: string; attemptId: string; capabilityDigest: string; workerId: string; epoch: number; generation: number; incarnation: number };
  content: { manifestHash: string; objectKey: string; objectGeneration: string; objectHash: string; bytes: number };
}
export interface LibraryCatalogOptions {
  environment: string; authorityId: string; projectId: string;
  policy: { version: string; ownerPrincipal: string; writerPrincipal: string; verifierPrincipal: string };
  now?: () => number;
}
export interface LibraryBodies {
  stageTransfer: { version: 1; intentId: string; binding: TransferBinding; expiresAt: number };
  authorizeTransfer: { version: 1; intentId: string; expectedGeneration: number; binding: TransferBinding; expiresAt: number };
  cancelTransfer: { version: 1; intentId: string; reason: string };
  revokePolicy: { version: 1; reason: string };
  attestTransfer: { version: 1; attestationId: string; intentId: string; generation: number; binding: TransferBinding; manifestHash: string; bytes: number; hostAttestation: string; attestedAt: number; expiresAt: number };
  publishSnapshot: { version: 1; snapshotId: string; intentId: string; generation: number; attestationId: string; provenance: { source: string; parentSnapshotId: string | null } };
  recordVerification: { version: 1; verificationId: string; snapshotId: string; hostAttestation: string };
  createCandidate: { version: 1; candidateId: string; snapshotId: string; verificationId: string; expectedCanonicalRevision: number };
  promoteCandidate: { version: 1; candidateId: string; expectedCanonicalRevision: number };
}
export type LibraryOperation = keyof LibraryBodies;
export type LibraryEnvelope = { [K in LibraryOperation]: { operation: K; key: string; body: LibraryBodies[K] } }[LibraryOperation];
export interface LibraryReply { version: 1; accepted: boolean; revision: number; operation: LibraryOperation; id: string; generation?: number; canonicalRevision: number; code?: 'CANONICAL_CONFLICT' }
export type RecordKind = 'intent' | 'authorization' | 'cancellation' | 'revocation' | 'transferAttestation' | 'snapshot' | 'verification' | 'candidate' | 'promotion';
export interface LibraryRecord { seq: number; kind: RecordKind; id: string; principal: string; at: number; body: Record<string, unknown> }
export interface LibrarySnapshot {
  version: 1; environment: string; authorityId: string; projectId: string;
  revision: number; canonicalRevision: number; canonicalSnapshotId: string | null;
  policyRevoked: boolean; records: LibraryRecord[];
}
export class LibraryRejected extends Error {
  constructor(public code: string, public status = 409) { super(code); this.name = 'LibraryRejected'; }
}
export type Options = LibraryCatalogOptions;
export type TrustedContext = LibraryContext;

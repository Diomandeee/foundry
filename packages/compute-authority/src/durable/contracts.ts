/** Trusted host DI, not network authentication. Never accept context/options from clients. */
export interface TrustedContext {
  principal: string;
  expectedEpoch: number;
  role: 'owner' | 'executor' | 'verifier' | 'projector' | 'submitter';
}
export type SqlValue = string | number | null | ArrayBuffer;
export interface SqlStoragePort {
  exec(query: string, ...bindings: SqlValue[]): Iterable<Record<string, unknown>>;
}
export interface TransactionPort {
  sql: SqlStoragePort;
  transactionSync<T>(callback: () => T): T;
}
export interface Device { id: string; kind: 'cuda' | 'metal'; vramMib: number }
export interface VerificationPolicy { sha256: string; maxBytes: number; exitCode: number }
export interface Resources { cpu: number; ramMib: number; gpu?: { kind: 'cuda' | 'metal'; minVramMib: number } }
export type Command =
  | { operation: 'registerWorker'; body: { workerId: string; principal: string; workerClass: 'general' | 'edge'; cpu: number; ramMib: number; devices: Device[] } }
  | { operation: 'quarantineWorker'; body: { workerId: string; expectedIncarnation: number } }
  | { operation: 'setQuota'; body: { principal: string; maxActive: number; allowedClass: 'general' } }
  | { operation: 'submit'; body: { workloadId: string; specification: string; resources: Resources; policy: VerificationPolicy; pure: boolean; reconstructible: boolean; maxAttempts: number } }
  | { operation: 'claim'; body: { workloadId: string; workerId: string; expectedGeneration: number; incarnation: number; ttlMs: number } }
  | { operation: 'renew'; body: LeaseFence & { sequence: number; ttlMs: number } }
  | { operation: 'stageResult'; body: LeaseFence & { artifactRef: string; sha256: string; bytes: number; exitCode: number } }
  | { operation: 'requeue'; body: { workloadId: string; expectedGeneration: number; requestId: string } }
  | { operation: 'cancel'; body: { workloadId: string; expectedGeneration: number } }
  | { operation: 'reconcileStop'; body: { workerId: string; incarnation: number; stopReceipt: string } }
  | { operation: 'bumpEpoch'; body: { expectedEpoch: number } }
  | { operation: 'sweep'; body: Record<string, never> }
  | { operation: 'readOutbox'; body: { after: number; limit: number } }
  | { operation: 'ackOutbox'; body: { through: number } };
export interface LeaseFence { leaseId: string; epoch: number; generation: number; incarnation: number; capability: string }
export type CommandEnvelope = Command & { key: string };
export type CommandResult = Record<string, unknown>;
export interface DurableAuthorityOptions {
  environment: string;
  authorityId: string;
  issuerId: string;
  /** Trusted local host fixture or managed issuer secret; never persisted. Minimum 32 characters. */
  issuerKey: string;
  now?: () => number;
  maxLeaseLifetimeMs?: number;
  verificationDeadlineMs?: number;
  readArtifact?: (reference: string, maxBytes: number, scope: { leaseId: string }) => Promise<Uint8Array>;
}
export interface VerificationRequest { key: string; leaseId: string; epoch: number; generation: number; incarnation: number }

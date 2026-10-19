export interface ObjectRef {
  readonly projectId: string;
  readonly objectKey: string;
  readonly generation: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}
export interface ComputeBinding {
  readonly authorityId: string;
  readonly workloadId: string;
  readonly leaseId: string;
  readonly epoch: number;
  readonly generation: number;
  readonly attemptId: string;
  readonly capabilityDigest: string;
  readonly workerId: string;
  readonly incarnation: number;
}
export interface ResourceLimits {
  readonly maxObjects: number;
  readonly maxObjectBytes: number;
  readonly maxManifestBytes: number;
  /** Includes manifest bytes plus every referenced object's bytes. */
  readonly maxTotalBytes: number;
}
export interface LibraryManifest {
  readonly version: 1;
  readonly projectId: string;
  readonly objects: readonly ObjectRef[];
}
export interface LibraryPolicy {
  readonly version: 1;
  readonly projectId: string;
  readonly policyVersion: string;
  readonly authorizedManifest: ObjectRef;
  readonly authorizedObjects: readonly ObjectRef[];
  readonly limits: ResourceLimits;
}
/** Trusted host DI only. Parent authenticates principal and applies owner/writer/verifier roles. */
export interface TrustedHost {
  readonly principalRef: string;
  readonly policy: LibraryPolicy;
  readonly compute: ComputeBinding;
}
export interface VerificationBody {
  readonly version: 1;
  readonly operation: 'verify-library-snapshot';
  readonly projectId: string;
  readonly policyVersion: string;
  readonly policyHash: string;
  readonly manifestRef: ObjectRef;
  readonly manifest: LibraryManifest;
  readonly compute: ComputeBinding;
}
export interface VerificationJob extends VerificationBody {
  readonly principalRef: string;
  readonly jobId: string;
}
/** A deterministic, unverified worker claim. This is never a host attestation. */
export interface WorkerReport {
  readonly version: 1;
  readonly kind: 'library-worker-report';
  readonly jobId: string;
  readonly compute: ComputeBinding;
  readonly manifestDigest: string;
  readonly objectSetDigest: string;
  readonly objectCount: number;
  readonly totalObjectBytes: number;
  readonly reportId: string;
}
export interface AcceptanceExpectation {
  readonly version: 1;
  readonly jobId: string;
  readonly reportId: string;
  readonly projectId: string;
  readonly principalRef: string;
  readonly policyVersion: string;
  readonly policyHash: string;
  readonly manifestDigest: string;
  readonly compute: ComputeBinding;
}
/** Host observes current authoritative acceptance, never a worker-supplied receipt. */
export interface ComputeAcceptance extends AcceptanceExpectation {
  readonly status: 'accepted';
  readonly revoked: false;
  readonly observedAt: number;
  readonly acceptedAt: number;
  readonly expiresAt: number;
}
export interface ObjectRead {
  readonly ref: ObjectRef;
  readonly bytes: Uint8Array;
}
export interface VerificationPorts {
  readonly host: TrustedHost;
  /** Trusted monotonic wall-clock integer milliseconds. */
  now(): number;
  /** Exact immutable-generation read; adapter authorizes and bounds before allocation. */
  readObject(ref: ObjectRef, maxBytes: number): ObjectRead;
  /** Synchronous CURRENT observation, before AND after reads; must not replay a cached worker report. */
  observeAcceptance(expected: AcceptanceExpectation): unknown;
}
export interface HostAttestation extends AcceptanceExpectation {
  readonly kind: 'library-host-byte-attestation';
  readonly proof: 'trusted-acceptance-and-local-byte-digests';
  readonly objectSetDigest: string;
  readonly objectCount: number;
  readonly verifiedBytes: number;
  readonly acceptedAt: number;
  readonly expiresAt: number;
  readonly attestedAt: number;
  readonly publicationAuthorized: false;
  readonly promotionAuthorized: false;
  readonly attestationId: string;
}

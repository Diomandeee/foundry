import { boundedBytes, readResult, canonical, check, freeze, hash, identifier, identity, integer, record, sha256, snapshot } from './data';
import type { AcceptanceExpectation, ComputeAcceptance, ComputeBinding, HostAttestation, LibraryManifest, LibraryPolicy, ObjectRef, ResourceLimits, TrustedHost, VerificationBody, VerificationJob, VerificationPorts, WorkerReport } from './types';
export type * from './types';
export { canonical } from './data';

export const OPERATION = 'verify-library-snapshot' as const;
export const HARD_LIMITS = Object.freeze({ maxObjects: 64, maxObjectBytes: 8 * 1024 * 1024, maxManifestBytes: 65536, maxTotalBytes: 32 * 1024 * 1024 });
const refFields = ['projectId', 'objectKey', 'generation', 'sha256', 'sizeBytes'];
const computeFields = ['authorityId', 'workloadId', 'leaseId', 'epoch', 'generation', 'attemptId', 'capabilityDigest', 'workerId', 'incarnation'];
const bodyFields = ['version', 'operation', 'projectId', 'policyVersion', 'policyHash', 'manifestRef', 'manifest', 'compute'];
const expectationFields = ['version', 'jobId', 'reportId', 'projectId', 'principalRef', 'policyVersion', 'policyHash', 'manifestDigest', 'compute'];
function same(a: unknown, b: unknown, message: string) { check(canonical(a) === canonical(b), message); }
function version(v: unknown) { check(v === 1, 'unsupported version'); }
function refCheck(value: unknown): asserts value is ObjectRef {
  record(value, refFields); identifier(value.projectId); hash(value.sha256); integer(value.sizeBytes, HARD_LIMITS.maxObjectBytes);
  check(typeof value.generation === 'string' && /^[1-9][0-9]{0,31}(?![\s\S])/.test(value.generation), 'immutable generation required');
  const prefix = `projects/${value.projectId}/`;
  check(value.objectKey === prefix + 'objects/' + value.sha256 || value.objectKey === prefix + 'manifests/' + value.sha256, 'exact content-addressed project key required');
}
function computeCheck(value: unknown): asserts value is ComputeBinding {
  record(value, computeFields);
  for (const name of ['authorityId', 'workloadId', 'leaseId', 'attemptId', 'workerId']) identifier(value[name]);
  integer(value.incarnation, Number.MAX_SAFE_INTEGER, 0); integer(value.epoch, Number.MAX_SAFE_INTEGER, 1); integer(value.generation, Number.MAX_SAFE_INTEGER, 0); hash(value.capabilityDigest);
}
function objectsCheck(value: unknown, projectId: string): asserts value is readonly ObjectRef[] {
  check(Array.isArray(value) && value.length > 0 && value.length <= HARD_LIMITS.maxObjects, 'object count budget');
  const keys = new Set<string>();
  for (const ref of value) {
    refCheck(ref); check(ref.projectId === projectId, 'cross-project object');
    check(ref.objectKey === `projects/${projectId}/objects/${ref.sha256}`, 'content must use objects namespace');
    check(!keys.has(ref.objectKey), 'duplicate object key'); keys.add(ref.objectKey);
  }
}
function manifestCheck(value: unknown): asserts value is LibraryManifest {
  record(value, ['version', 'projectId', 'objects']); version(value.version); identifier(value.projectId); objectsCheck(value.objects, value.projectId);
}
function policyCheck(value: unknown): asserts value is LibraryPolicy {
  record(value, ['version', 'projectId', 'policyVersion', 'authorizedManifest', 'authorizedObjects', 'limits']);
  version(value.version); identifier(value.projectId); identifier(value.policyVersion);
  refCheck(value.authorizedManifest); check(value.authorizedManifest.projectId === value.projectId, 'cross-project manifest grant');
  check(value.authorizedManifest.objectKey === `projects/${value.projectId}/manifests/${value.authorizedManifest.sha256}`, 'manifest must use manifests namespace');
  objectsCheck(value.authorizedObjects, value.projectId);
  record(value.limits, Object.keys(HARD_LIMITS));
  for (const name of Object.keys(HARD_LIMITS) as (keyof typeof HARD_LIMITS)[]) integer(value.limits[name], HARD_LIMITS[name], 1);
  const limits = value.limits as unknown as ResourceLimits;
  check(value.authorizedObjects.length <= limits.maxObjects, 'policy object count');
  check(value.authorizedManifest.sizeBytes <= limits.maxManifestBytes, 'policy manifest bytes');
  let total = value.authorizedManifest.sizeBytes;
  for (const ref of value.authorizedObjects) { check(ref.sizeBytes <= limits.maxObjectBytes, 'policy object bytes'); total += ref.sizeBytes; }
  check(total <= limits.maxTotalBytes, 'policy total bytes');
}
export function validatePolicy(input: unknown): LibraryPolicy {
  const value = snapshot(input); policyCheck(value); return freeze(value);
}
export function policyDigest(input: unknown): string { return identity('library-policy/v1', validatePolicy(input)); }
function hostSnapshot(input: TrustedHost): TrustedHost {
  const host = snapshot(input); record(host, ['principalRef', 'policy', 'compute']); identifier(host.principalRef); policyCheck(host.policy); computeCheck(host.compute);
  return freeze(host as unknown as TrustedHost);
}
function bodyCheck(value: unknown, fields = bodyFields): asserts value is VerificationBody {
  record(value, fields); version(value.version); check(value.operation === OPERATION, 'read-only operation required');
  identifier(value.projectId); identifier(value.policyVersion); hash(value.policyHash); refCheck(value.manifestRef); manifestCheck(value.manifest); computeCheck(value.compute);
  check(value.manifestRef.projectId === value.projectId && value.manifest.projectId === value.projectId, 'cross-project manifest');
  check(value.manifestRef.objectKey === `projects/${value.projectId}/manifests/${value.manifestRef.sha256}`, 'manifest must use manifests namespace');
  const encoded = manifestBytes(value.manifest);
  check(encoded.length === value.manifestRef.sizeBytes && sha256(encoded) === value.manifestRef.sha256, 'manifest digest/size mismatch');
  const manifestKey = value.manifestRef.objectKey;
  check(!value.manifest.objects.some(ref => ref.objectKey === manifestKey), 'manifest aliases content');
  const total = value.manifest.objects.reduce((n, ref) => n + ref.sizeBytes, encoded.length);
  check(total <= HARD_LIMITS.maxTotalBytes, 'job total byte budget');
}
/** V1 pins canonical UTF-8 manifest bytes. Property order of input objects is irrelevant. */
export function manifestBytes(input: unknown): Uint8Array {
  const manifest = snapshot(input); manifestCheck(manifest);
  const bytes = new TextEncoder().encode(canonical(manifest)); check(bytes.length <= HARD_LIMITS.maxManifestBytes, 'manifest byte budget'); return bytes;
}
function authorize(body: VerificationBody, host: TrustedHost) {
  check(body.projectId === host.policy.projectId && body.policyVersion === host.policy.policyVersion && body.policyHash === policyDigest(host.policy), 'host project/policy mismatch');
  same(body.compute, host.compute, 'host compute fence mismatch');
  same(body.manifestRef, host.policy.authorizedManifest, 'manifest not authorized');
  // V1 requires the complete exact manifest object sequence, not a subset or wildcard grant.
  same(body.manifest.objects, host.policy.authorizedObjects, 'object set not authorized');
}
export function buildVerificationJob(input: unknown, trustedHost: TrustedHost): VerificationJob {
  const body = snapshot(input), host = hostSnapshot(trustedHost); bodyCheck(body); authorize(body, host);
  const binding = { ...body, principalRef: host.principalRef };
  return freeze({ ...binding, jobId: identity('library-job/v1', binding) });
}
/** Structural/digest validation only; does not authenticate this job or its principal. */
export function validateJob(input: unknown): VerificationJob {
  const job = snapshot(input); bodyCheck(job, [...bodyFields, 'principalRef', 'jobId']);
  const typed = job as VerificationJob; identifier(typed.principalRef); hash(typed.jobId);
  const { jobId, ...binding } = typed; check(jobId === identity('library-job/v1', binding), 'job identity mismatch'); return freeze(typed);
}
export function buildWorkerReport(input: VerificationJob): WorkerReport {
  const job = validateJob(input);
  const report = { version: 1 as const, kind: 'library-worker-report' as const, jobId: job.jobId, compute: job.compute,
    manifestDigest: job.manifestRef.sha256, objectSetDigest: identity('library-objects/v1', job.manifest.objects),
    objectCount: job.manifest.objects.length, totalObjectBytes: job.manifest.objects.reduce((n, ref) => n + ref.sizeBytes, 0) };
  return freeze({ ...report, reportId: identity('library-worker-report/v1', report) });
}
/** A valid hash is not proof of execution, acceptance, storage or permission. */
export function validateWorkerReport(input: unknown): WorkerReport {
  const value = snapshot(input);
  record(value, ['version', 'kind', 'jobId', 'compute', 'manifestDigest', 'objectSetDigest', 'objectCount', 'totalObjectBytes', 'reportId']);
  version(value.version); check(value.kind === 'library-worker-report', 'worker report kind'); computeCheck(value.compute);
  for (const name of ['jobId', 'manifestDigest', 'objectSetDigest', 'reportId']) hash(value[name]);
  integer(value.objectCount, HARD_LIMITS.maxObjects, 1); integer(value.totalObjectBytes, HARD_LIMITS.maxTotalBytes);
  const { reportId, ...binding } = value; check(reportId === identity('library-worker-report/v1', binding), 'report identity mismatch');
  return freeze(value as unknown as WorkerReport);
}
function acceptanceCheck(input: unknown, expected: AcceptanceExpectation, before: number, now: number): ComputeAcceptance {
  const value = snapshot(input);
  record(value, [...expectationFields, 'status', 'revoked', 'observedAt', 'acceptedAt', 'expiresAt']);
  const { status, revoked, observedAt, acceptedAt, expiresAt, ...binding } = value;
  same(binding, expected, 'compute acceptance binding mismatch');
  check(status === 'accepted' && revoked === false, 'compute acceptance missing or revoked');
  integer(observedAt); integer(acceptedAt); integer(expiresAt);
  check(observedAt >= before && observedAt <= now && acceptedAt <= observedAt && expiresAt > now, 'compute acceptance stale or expired');
  return freeze(value as unknown as ComputeAcceptance);
}
/** Host-only synchronous verifier. No catalog write/publication/promotion or runtime activation. */
export function verifyEvidence(jobInput: unknown, reportInput: unknown, ports: VerificationPorts): HostAttestation {
  const job = validateJob(jobInput), report = validateWorkerReport(reportInput), host = hostSnapshot(ports.host);
  authorize(job, host); check(job.principalRef === host.principalRef, 'host principal mismatch');
  same(report, buildWorkerReport(job), 'worker claim does not match job');
  const expected: AcceptanceExpectation = freeze({ version: 1, jobId: job.jobId, reportId: report.reportId,
    projectId: job.projectId, principalRef: job.principalRef, policyVersion: job.policyVersion, policyHash: job.policyHash,
    manifestDigest: job.manifestRef.sha256, compute: job.compute });
  let lastTime = 0;
  function observeCurrent(): ComputeAcceptance {
    const before = ports.now(); integer(before); check(before >= lastTime, 'clock moved backwards');
    const observed = ports.observeAcceptance(expected);
    const now = ports.now(); integer(now); check(now >= before, 'clock moved backwards'); lastTime = now;
    return acceptanceCheck(observed, expected, before, now);
  }
  observeCurrent();
  let total = 0;
  function verifyObject(ref: ObjectRef, maxBytes: number): Uint8Array {
    check(ref.sizeBytes <= maxBytes && total + ref.sizeBytes <= host.policy.limits.maxTotalBytes, 'verification byte budget');
    const result = readResult(ports.readObject(ref, ref.sizeBytes));
    same(snapshot(result.ref), ref, 'read metadata does not match immutable reference');
    const actual = boundedBytes(result.bytes, ref.sizeBytes);
    check(actual.length === ref.sizeBytes && sha256(actual) === ref.sha256, 'actual object digest/size mismatch');
    total += actual.length; return actual;
  }
  verifyObject(job.manifestRef, host.policy.limits.maxManifestBytes);
  for (const ref of job.manifest.objects) verifyObject(ref, host.policy.limits.maxObjectBytes);
  const accepted = observeCurrent(), now = lastTime;
  const attestation = { ...expected, kind: 'library-host-byte-attestation' as const, proof: 'trusted-acceptance-and-local-byte-digests' as const,
    objectSetDigest: report.objectSetDigest, objectCount: report.objectCount, verifiedBytes: total,
    acceptedAt: accepted.acceptedAt, expiresAt: accepted.expiresAt, attestedAt: now,
    publicationAuthorized: false as const, promotionAuthorized: false as const };
  return freeze({ ...attestation, attestationId: identity('library-host-byte-attestation/v1', attestation) });
}

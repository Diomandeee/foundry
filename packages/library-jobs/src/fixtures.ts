/** Local in-memory fixtures only. No auth, CLI, backend or worker activation. */
import { createHash } from 'node:crypto';
import { buildVerificationJob, buildWorkerReport, manifestBytes, policyDigest } from './index';
import type { ComputeAcceptance, ComputeBinding, LibraryManifest, LibraryPolicy, ObjectRead, ObjectRef, TrustedHost, VerificationBody, VerificationPorts } from './types';
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export function fixture() {
  const projectId = 'project-a', now = 10000;
  const bytes = [new TextEncoder().encode('alpha'), new TextEncoder().encode('beta')];
  const objects: ObjectRef[] = bytes.map((data, i) => ({ projectId, objectKey: `projects/${projectId}/objects/${hash(data)}`, generation: String(i + 10), sha256: hash(data), sizeBytes: data.length }));
  const manifest: LibraryManifest = { version: 1, projectId, objects };
  const encoded = manifestBytes(manifest);
  const manifestRef: ObjectRef = { projectId, objectKey: `projects/${projectId}/manifests/${hash(encoded)}`, generation: '20', sha256: hash(encoded), sizeBytes: encoded.length };
  const policy: LibraryPolicy = { version: 1, projectId, policyVersion: 'policy-1', authorizedManifest: manifestRef, authorizedObjects: objects,
    limits: { maxObjects: 4, maxObjectBytes: 1024, maxManifestBytes: 4096, maxTotalBytes: 8192 } };
  const compute: ComputeBinding = { authorityId: 'compute-a', workloadId: 'workload-a', leaseId: 'lease-a', epoch: 1, generation: 2,
    attemptId: 'attempt-1', capabilityDigest: hash('synthetic-reference-only'), workerId: 'worker-a', incarnation: 3 };
  const host: TrustedHost = { principalRef: 'writer-a', policy, compute };
  const body: VerificationBody = { version: 1, operation: 'verify-library-snapshot', projectId, policyVersion: policy.policyVersion, policyHash: policyDigest(policy), manifestRef, manifest, compute };
  const job = buildVerificationJob(body, host), report = buildWorkerReport(job);
  const storage = new Map<string, ObjectRead>([[manifestRef.objectKey, { ref: manifestRef, bytes: encoded }], ...objects.map((ref, i) => [ref.objectKey, { ref, bytes: bytes[i] }] as const)]);
  const reads: ObjectRef[] = [];
  const ports: VerificationPorts = {
    host, now: () => now,
    readObject(ref, maxBytes) {
      reads.push(ref);
      const found = storage.get(ref.objectKey);
      if (!found || found.bytes.length > maxBytes) throw new Error('fixture bounded read failed');
      return found;
    },
    observeAcceptance: expected => ({ ...expected, status: 'accepted', revoked: false, observedAt: now, acceptedAt: now - 100, expiresAt: now + 1000 } satisfies ComputeAcceptance),
  };
  return { host, body, job, report, ports, storage, reads, now, objects, manifestRef };
}

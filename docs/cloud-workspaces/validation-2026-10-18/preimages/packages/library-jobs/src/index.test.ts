import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildVerificationJob, buildWorkerReport, canonical, HARD_LIMITS, manifestBytes, policyDigest, validateJob, validatePolicy, validateWorkerReport, verifyEvidence } from './index';
import type { ComputeAcceptance, ComputeBinding, LibraryPolicy, ObjectRead, VerificationBody } from './types';
import { fixture } from './fixtures';
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };
const copy = <T>(value: T): Mutable<T> => structuredClone(value) as Mutable<T>;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function reverse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverse);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, val]) => [key, reverse(val)]));
  return value;
}
function repin(body: Mutable<VerificationBody>) {
  const bytes = manifestBytes(body.manifest); body.manifestRef.sha256 = hash(bytes); body.manifestRef.sizeBytes = bytes.length; body.manifestRef.objectKey = `projects/${body.projectId}/manifests/${hash(bytes)}`;
}
function changedObservation(change: (value: Mutable<ComputeAcceptance>) => void) {
  const f = fixture(), original = f.ports.observeAcceptance;
  return { ...f, ports: { ...f.ports, observeAcceptance(expected: Parameters<typeof original>[0]) {
    const value = copy(original(expected) as ComputeAcceptance); change(value); return value;
  } } };
}

test('local host journey checks all bytes, then accepts, with separate non-authorizing attestation', () => {
  const f = fixture();
  const original = f.ports.observeAcceptance;
  let observations = 0;
  const attestation = verifyEvidence(f.job, f.report, { ...f.ports, observeAcceptance(expected) {
    assert.equal(f.reads.length, observations++ === 0 ? 0 : 3); return original(expected);
  } });
  assert.equal(attestation.kind, 'library-host-byte-attestation');
  assert.equal(attestation.verifiedBytes, f.manifestRef.sizeBytes + 9);
  assert.equal(attestation.publicationAuthorized, false); assert.equal(attestation.promotionAuthorized, false);
  assert.equal(attestation.compute.incarnation, 3); assert.equal(attestation.policyHash, policyDigest(f.host.policy));
  assert.ok(Object.isFrozen(attestation.compute)); assert.ok(Object.isFrozen(attestation));
});
test('idempotent jobs/reports/attestations survive JSON property reordering', () => {
  const f = fixture(), reversed = buildVerificationJob(reverse(f.body), reverse(f.host) as typeof f.host);
  assert.deepEqual(reversed, f.job); assert.deepEqual(buildWorkerReport(reversed), f.report);
  assert.deepEqual(verifyEvidence(reverse(f.job), reverse(f.report), f.ports), verifyEvidence(f.job, f.report, f.ports));
});
test('inputs are snapshotted and deeply frozen; later mutation cannot change identities', () => {
  const f = fixture(), body = copy(f.body), job = buildVerificationJob(body, f.host);
  body.compute.epoch++; body.manifest.objects[0].generation = '999';
  assert.deepEqual(job, f.job); assert.throws(() => { (job.compute as Mutable<ComputeBinding>).epoch++; });
});
for (const key of ['epoch', 'generation', 'attemptId', 'incarnation', 'workerId', 'leaseId', 'authorityId', 'workloadId', 'capabilityDigest'] as const) {
  test(`job rejects stale/different compute ${key}`, () => {
    const f = fixture(), body = copy(f.body), compute = body.compute as unknown as Record<string, unknown>;
    compute[key] = typeof compute[key] === 'number' ? Number(compute[key]) + 1 : key === 'capabilityDigest' ? 'b'.repeat(64) : 'different';
    assert.throws(() => buildVerificationJob(body, f.host));
  });
  test(`acceptance rejects stale/different compute ${key}`, () => {
    const f = changedObservation(value => {
      const compute = value.compute as unknown as Record<string, unknown>;
      compute[key] = typeof compute[key] === 'number' ? Number(compute[key]) + 1 : key === 'capabilityDigest' ? 'b'.repeat(64) : 'different';
    });
    assert.throws(() => verifyEvidence(f.job, f.report, f.ports));
  });
}
for (const key of ['projectId', 'principalRef', 'policyVersion', 'policyHash', 'manifestDigest', 'jobId', 'reportId'] as const) {
  test(`acceptance binds ${key}`, () => {
    const f = changedObservation(value => { value[key] = key.endsWith('Hash') || key.endsWith('Digest') || key.endsWith('Id') && ['jobId', 'reportId'].includes(key) ? 'b'.repeat(64) : 'other'; });
    assert.throws(() => verifyEvidence(f.job, f.report, f.ports));
  });
}
for (const [name, change] of [
  ['revoked', (v: Mutable<ComputeAcceptance>) => { Object.assign(v, { revoked: true }); }],
  ['not accepted', (v: Mutable<ComputeAcceptance>) => { Object.assign(v, { status: 'staged' }); }],
  ['expired exactly now', (v: Mutable<ComputeAcceptance>) => { v.expiresAt = 10000; }],
  ['expired in past', (v: Mutable<ComputeAcceptance>) => { v.expiresAt = 9999; }],
  ['future acceptedAt', (v: Mutable<ComputeAcceptance>) => { v.acceptedAt = 10001; }],
  ['stale observation', (v: Mutable<ComputeAcceptance>) => { v.observedAt = 9999; }],
  ['future observation', (v: Mutable<ComputeAcceptance>) => { v.observedAt = 10001; }],
  ['wrong acceptance version', (v: Mutable<ComputeAcceptance>) => { Object.assign(v, { version: 2 }); }],
] as const) test(`rejects ${name}`, () => { const f = changedObservation(change); assert.throws(() => verifyEvidence(f.job, f.report, f.ports)); });
test('principal is trusted host input and cannot be supplied in body', () => {
  const f = fixture();
  for (const extra of [{ role: 'owner' }, { principalRef: 'owner' }, { capability: 'never-a-real-secret' }, { backend: 'arbitrary' }, { command: 'anything' }]) assert.throws(() => buildVerificationJob({ ...f.body, ...extra }, f.host));
  assert.throws(() => verifyEvidence(f.job, f.report, { ...f.ports, host: { ...f.host, principalRef: 'other' } }));
});
for (const [name, change] of [
  ['body project', (b: Mutable<VerificationBody>) => { b.projectId = 'project-b'; }],
  ['manifest project', (b: Mutable<VerificationBody>) => { b.manifest.projectId = 'project-b'; }],
  ['manifest ref project', (b: Mutable<VerificationBody>) => { b.manifestRef.projectId = 'project-b'; }],
  ['object project', (b: Mutable<VerificationBody>) => { b.manifest.objects[0].projectId = 'project-b'; }],
] as const) test(`rejects cross-project ${name}`, () => { const f = fixture(), body = copy(f.body); change(body); assert.throws(() => buildVerificationJob(body, f.host)); });
for (const key of ['generation', 'sha256', 'sizeBytes', 'objectKey'] as const) {
  test(`rejects changed object ${key} even with recomputed manifest pin`, () => {
    const f = fixture(), body = copy(f.body), ref = body.manifest.objects[0] as unknown as Record<string, unknown>;
    ref[key] = key === 'generation' ? '99' : key === 'sha256' ? 'b'.repeat(64) : key === 'sizeBytes' ? 1 : 'projects/project-a/objects/other';
    if (key === 'sha256') ref.objectKey = `projects/project-a/objects/${ref.sha256}`;
    if (key === 'objectKey') { ref.sha256 = 'b'.repeat(64); ref.objectKey = `projects/project-a/objects/${ref.sha256}`; }
    repin(body); assert.throws(() => buildVerificationJob(body, f.host));
  });
  test(`rejects changed manifest ${key}`, () => {
    const f = fixture(), body = copy(f.body), ref = body.manifestRef as unknown as Record<string, unknown>;
    ref[key] = key === 'generation' ? '99' : key === 'sha256' ? 'b'.repeat(64) : key === 'sizeBytes' ? 1 : 'projects/project-a/manifests/other';
    assert.throws(() => buildVerificationJob(body, f.host));
  });
  test(`reader metadata must match exact ${key}`, () => {
    const f = fixture(), ref = copy(f.manifestRef) as unknown as Record<string, unknown>;
    ref[key] = key === 'generation' ? '99' : key === 'sha256' ? 'b'.repeat(64) : key === 'sizeBytes' ? 1 : 'projects/project-a/manifests/other';
    f.storage.set(f.manifestRef.objectKey, { ...f.storage.get(f.manifestRef.objectKey)!, ref: ref as unknown as ObjectRead['ref'] });
    assert.throws(() => verifyEvidence(f.job, f.report, f.ports));
  });
}
for (const objectKey of ['../x', '/projects/project-a/x', 'projects/project-b/objects/x', 'objects/x', 'projects/project-a/../x', 'projects/project-a//x', 'projects/project-a/%2e%2e/x', 'https://example.test/x', 'projects/project-a/a?x=y', 'projects/project-a/a\\b', 'projects/project-a/x\n']) {
  test(`rejects unsafe/unscoped object key ${JSON.stringify(objectKey)}`, () => {
    const f = fixture(), policy = copy(f.host.policy); policy.authorizedObjects[0].objectKey = objectKey;
    assert.throws(() => validatePolicy(policy));
  });
}
for (const [key, value] of [['projectId', 'project-a\n'], ['generation', '10\n'], ['sha256', 'a'.repeat(64) + '\n']] as const) {
  test(`absolute-end validation for ref ${key}`, () => { const f = fixture(), policy = copy(f.host.policy); policy.authorizedObjects[0][key] = value; assert.throws(() => validatePolicy(policy)); });
}
test('absolute-end validation for principal/compute/hash and numeric incarnation', () => {
  const f = fixture();
  for (const compute of [{ ...f.host.compute, authorityId: 'compute-a\n' }, { ...f.host.compute, capabilityDigest: 'a'.repeat(64) + '\n' }, { ...f.host.compute, incarnation: '3' }]) {
    assert.throws(() => buildVerificationJob(f.body, { ...f.host, compute } as typeof f.host));
  }
  assert.throws(() => buildVerificationJob(f.body, { ...f.host, principalRef: 'writer-a\n' }));
});
for (const [name, value] of [['maxObjects', 1], ['maxObjectBytes', 4], ['maxManifestBytes', 1], ['maxTotalBytes', 1]] as const) {
  test(`policy ${name} budget`, () => { const f = fixture(), policy = copy(f.host.policy); policy.limits[name] = value; assert.throws(() => validatePolicy(policy)); });
  test(`hard ${name} ceiling`, () => { const f = fixture(), policy = copy(f.host.policy); policy.limits[name] = HARD_LIMITS[name] + 1; assert.throws(() => validatePolicy(policy)); });
}
test('total verification budget includes the manifest and is allowed exactly at boundary', () => {
  const f = fixture(), policy = copy(f.host.policy); policy.limits.maxTotalBytes = f.manifestRef.sizeBytes + 9;
  const host = { ...f.host, policy }, body = { ...f.body, policyHash: policyDigest(policy) }, job = buildVerificationJob(body, host);
  assert.equal(verifyEvidence(job, buildWorkerReport(job), { ...f.ports, host }).verifiedBytes, policy.limits.maxTotalBytes);
  policy.limits.maxTotalBytes--; assert.throws(() => validatePolicy(policy));
});
test('forged matching worker report cannot replace actual byte verification', () => {
  const f = fixture(); assert.deepEqual(validateWorkerReport(f.report), f.report);
  const ref = f.objects[0]; f.storage.set(ref.objectKey, { ref, bytes: new TextEncoder().encode('wrong') });
  let observations = 0; const original = f.ports.observeAcceptance;
  assert.throws(() => verifyEvidence(f.job, f.report, { ...f.ports, observeAcceptance(expected) { observations++; return original(expected); } }));
  assert.equal(observations, 1);
});
test('oversized and short actual reads fail, not just metadata mismatch', () => {
  for (const length of [0, 6, 100000]) {
    const f = fixture(); const original = f.ports.readObject;
    assert.throws(() => verifyEvidence(f.job, f.report, { ...f.ports, readObject(ref, max) { return ref === f.job.manifest.objects[0] || ref.objectKey === f.objects[0].objectKey ? { ref, bytes: new Uint8Array(length) } : original(ref, max); } }));
  }
});
test('modified manifest bytes fail independently', () => {
  const f = fixture(), bytes = new Uint8Array(f.storage.get(f.manifestRef.objectKey)!.bytes); bytes[0] ^= 1;
  f.storage.set(f.manifestRef.objectKey, { ref: f.manifestRef, bytes }); assert.throws(() => verifyEvidence(f.job, f.report, f.ports));
});
test('no worker summary field can request publication or become host attestation', () => {
  const f = fixture();
  for (const extra of [{ publicationAuthorized: true }, { promotionAuthorized: true }, { hostAttestation: 'forged' }, { sessionUrl: 'https://example.test' }, { credentials: {} }]) assert.throws(() => validateWorkerReport({ ...f.report, ...extra }));
  assert.throws(() => verifyEvidence(f.job, verifyEvidence(f.job, f.report, f.ports), f.ports));
});
test('summary contains hashes and reference names, with no bearer/raw session fields', () => {
  const f = fixture(), text = canonical(buildWorkerReport(f.job));
  assert.ok(!text.includes('synthetic-reference-only'));
  for (const field of ['capability', 'token', 'sessionUrl', 'credentials', 'role', 'command', 'backend']) assert.ok(!Object.hasOwn(JSON.parse(text), field));
});
test('wrong versions/operations, identity tampering and numeric anomalies are rejected', () => {
  const f = fixture();
  for (const version of [0, 2, '1', null]) assert.throws(() => buildVerificationJob({ ...f.body, version }, f.host));
  for (const operation of ['publishSnapshot', 'shell', 'verify-library-snapshot\n']) assert.throws(() => buildVerificationJob({ ...f.body, operation }, f.host));
  assert.throws(() => validateJob({ ...f.job, jobId: 'a'.repeat(64) }));
  assert.throws(() => validateWorkerReport({ ...f.report, reportId: 'a'.repeat(64) }));
  for (const generation of [-0, -1, NaN, Infinity, 1.2, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => buildVerificationJob(f.body, { ...f.host, compute: { ...f.host.compute, generation } }));
});
test('empty/duplicate/too many objects and unknown manifest fields fail', () => {
  const f = fixture();
  for (const objects of [[], [f.objects[0], f.objects[0]], Array(65).fill(f.objects[0])]) assert.throws(() => manifestBytes({ ...f.body.manifest, objects }));
  assert.throws(() => manifestBytes({ ...f.body.manifest, backend: 'other' }));
});
test('getters are never invoked across body, nested refs, host, report and acceptance', () => {
  let invoked = 0;
  const accessor = (value: object, key: string) => Object.defineProperty(value, key, { enumerable: true, get() { invoked++; throw new Error('getter invoked'); } });
  const f = fixture();
  assert.throws(() => buildVerificationJob(accessor(copy(f.body), 'projectId'), f.host));
  const body = copy(f.body); accessor(body.manifest.objects[0], 'sha256'); assert.throws(() => buildVerificationJob(body, f.host));
  assert.throws(() => buildVerificationJob(f.body, accessor(copy(f.host), 'principalRef') as typeof f.host));
  assert.throws(() => validateWorkerReport(accessor(copy(f.report), 'jobId')));
  assert.throws(() => verifyEvidence(f.job, f.report, { ...f.ports, observeAcceptance: () => accessor({}, 'status') }));
  assert.equal(invoked, 0);
});
test('proxies are rejected without any proxy trap being run', () => {
  let traps = 0;
  const f = fixture(), proxy = new Proxy({}, { ownKeys() { traps++; throw new Error('trap'); }, getPrototypeOf() { traps++; throw new Error('trap'); }, get() { traps++; throw new Error('trap'); } });
  assert.throws(() => buildVerificationJob(proxy, f.host)); assert.throws(() => canonical(proxy));
  assert.equal(traps, 0);
});
test('sparse/decorated arrays, hidden/symbol fields, classes, cycles and toJSON rejected', () => {
  const f = fixture(), cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  const sparse = Array(2), decorated = Object.assign([1], { extra: true });
  const values = [sparse, decorated, Object.defineProperty({}, 'hidden', { value: 1 }), { [Symbol('s')]: 1 }, new Date(), cyclic, { toJSON() { throw new Error('must not invoke'); } }, JSON.parse('{"__proto__":1}'), undefined, 1n];
  for (const value of values) assert.throws(() => canonical(value));
  assert.deepEqual(validateJob(f.job), f.job);
});
test('complexity, UTF-8 bytes and string budgets reject malicious input', () => {
  let nested: unknown = {}; for (let i = 0; i < 17; i++) nested = { nested };
  for (const value of [nested, 'x'.repeat(262145), '😀'.repeat(100000), Object.fromEntries(Array.from({ length: 4097 }, (_, i) => ['k' + i, i]))]) assert.throws(() => canonical(value));
});
test('reader envelopes, metadata and bytes reject getters/proxies/shared memory', () => {
  const f = fixture(); let invoked = 0;
  const getter = Object.defineProperty({ ref: f.manifestRef }, 'bytes', { enumerable: true, get() { invoked++; throw new Error('getter'); } });
  const values = [getter, new Proxy({}, { get() { invoked++; throw new Error('trap'); } }), { ref: f.manifestRef, bytes: new Proxy(new Uint8Array(), {}) }, { ref: f.manifestRef, bytes: new Uint8Array(new SharedArrayBuffer(1)) }];
  for (const value of values) assert.throws(() => verifyEvidence(f.job, f.report, { ...f.ports, readObject: () => value as ObjectRead }));
  assert.equal(invoked, 0);
});
test('reader bytes with malicious species/accessors do not execute caller code', () => {
  const f = fixture(); let invoked = 0;
  class MaliciousBytes extends Uint8Array { static get [Symbol.species]() { invoked++; throw new Error('species'); } }
  const original = f.ports.readObject;
  verifyEvidence(f.job, f.report, { ...f.ports, readObject(ref, max) {
    const result = original(ref, max), bytes = new MaliciousBytes(result.bytes);
    Object.defineProperty(bytes, 'byteLength', { get() { invoked++; throw new Error('length'); } });
    return { ref: result.ref, bytes };
  } });
  assert.equal(invoked, 0);
});
test('async/non-current acceptance and unavailable ports fail closed', () => {
  const f = fixture();
  for (const observeAcceptance of [() => Promise.resolve({}), () => null, () => f.report, () => { throw new Error('authority unavailable'); }]) assert.throws(() => verifyEvidence(f.job, f.report, { ...f.ports, observeAcceptance }));
  assert.throws(() => verifyEvidence(f.job, f.report, { ...f.ports, readObject() { throw new Error('unavailable'); } }));
});
test('expiry during byte reads is checked after the reads', () => {
  const f = fixture(); let now = f.now; const original = f.ports.readObject;
  assert.throws(() => verifyEvidence(f.job, f.report, { ...f.ports, now: () => now,
    readObject(ref, max) { const value = original(ref, max); now += 500; return value; },
    observeAcceptance: expected => ({ ...expected, status: 'accepted', revoked: false, acceptedAt: 9900, observedAt: now, expiresAt: 11000 }),
  }));
});
test('policy mutation is not masked by retaining old policy hash', () => {
  const f = fixture(), policy: Mutable<LibraryPolicy> = copy(f.host.policy); policy.limits.maxObjects++;
  assert.throws(() => verifyEvidence(f.job, f.report, { ...f.ports, host: { ...f.host, policy } }));
});
test('physical content-address suffix must match the exact ref digest', () => {
  const f = fixture(), policy = copy(f.host.policy);
  policy.authorizedObjects[0].objectKey = 'projects/project-a/objects/' + 'b'.repeat(64);
  assert.throws(() => validatePolicy(policy));
});
test('manifest and content namespaces cannot be interchanged', () => {
  const f = fixture();
  const contentPolicy = copy(f.host.policy); contentPolicy.authorizedObjects[0].objectKey = `projects/project-a/manifests/${contentPolicy.authorizedObjects[0].sha256}`;
  assert.throws(() => validatePolicy(contentPolicy));
  const manifestPolicy = copy(f.host.policy); manifestPolicy.authorizedManifest.objectKey = `projects/project-a/objects/${manifestPolicy.authorizedManifest.sha256}`;
  assert.throws(() => validatePolicy(manifestPolicy));
});
test('generation accepts 1..32 positive decimal digits only', () => {
  const f = fixture();
  for (const generation of ['1', '9'.repeat(32)]) assert.doesNotThrow(() => validatePolicy({ ...f.host.policy, authorizedManifest: { ...f.manifestRef, generation } }));
  for (const generation of ['', '0', '01', '1.0', '-1', '1\n', '9'.repeat(33)]) assert.throws(() => validatePolicy({ ...f.host.policy, authorizedManifest: { ...f.manifestRef, generation } }));
});
test('stale preflight acceptance prevents any object read', () => {
  const f = changedObservation(value => { Object.assign(value, { revoked: true }); });
  assert.throws(() => verifyEvidence(f.job, f.report, f.ports)); assert.equal(f.reads.length, 0);
});
test('revocation during reads prevents final attestation', () => {
  const f = fixture(), original = f.ports.observeAcceptance; let observations = 0;
  assert.throws(() => verifyEvidence(f.job, f.report, { ...f.ports, observeAcceptance(expected) {
    const value = original(expected); return observations++ === 0 ? value : { ...value as ComputeAcceptance, revoked: true };
  } }));
  assert.equal(observations, 2); assert.equal(f.reads.length, 3);
});

test('compute generation zero is a valid first-attempt fence',()=>{
 const f=fixture(),compute={...f.host.compute,generation:0},host={...f.host,compute};
 const job=buildVerificationJob({...f.body,compute},host);assert.equal(job.compute.generation,0);
});

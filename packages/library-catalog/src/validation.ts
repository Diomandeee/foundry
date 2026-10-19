import { types } from 'node:util';
import { LibraryRejected, type LibraryEnvelope, type TransferBinding } from './types';
export function need(ok: unknown, code = 'INVALID_INPUT', status = 400): asserts ok {
  if (!ok) throw new LibraryRejected(code, status);
}
export function integer(v: unknown, max = Number.MAX_SAFE_INTEGER): asserts v is number {
  need(Number.isSafeInteger(v) && !Object.is(v, -0) && Number(v) >= 0 && Number(v) <= max);
}
export function identifier(v: unknown): asserts v is string { need(typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,95}(?![\s\S])/.test(v)); }
export function hash(v: unknown): asserts v is string { need(typeof v === 'string' && /^[a-f0-9]{64}(?![\s\S])/.test(v)); }
export function text(v: unknown): asserts v is string { need(typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\u0000-\u001f\u007f]/.test(v)); }
/** Inert, canonical, bounded JSON; no getters, proxies, hidden properties or toJSON. */
export function canonical(value: unknown, maxBytes = 8192): string {
  let nodes = 0, budget = maxBytes;
  const active = new Set<object>();
  function debit(n: number) { budget -= n; need(budget >= 0); }
  function visit(v: unknown, depth: number): string {
    need(++nodes <= (maxBytes >= 512 * 1024 ? 65536 : 4096) && depth <= 12);
    if (v === null || ['string', 'boolean', 'number'].includes(typeof v)) {
      if (typeof v === 'string') need(v.length <= maxBytes);
      if (typeof v === 'number') need(Number.isFinite(v) && !Object.is(v, -0));
      const out = JSON.stringify(v); debit(new TextEncoder().encode(out).length); return out;
    }
    need(typeof v === 'object' && v !== null && !types.isProxy(v) && !active.has(v));
    const array = Array.isArray(v), proto = Object.getPrototypeOf(v);
    need(array ? proto === Array.prototype : proto === Object.prototype || proto === null);
    const keys = Reflect.ownKeys(v); need(keys.length <= 1024);
    const descriptors = Object.getOwnPropertyDescriptors(v);
    for (const key of keys) {
      need(typeof key === 'string' && key.length <= 128 && !['__proto__', 'constructor', 'prototype'].includes(key));
      const d = descriptors[key]; need('value' in d && (d.enumerable || array && key === 'length'));
    }
    active.add(v); debit(2);
    let out: string;
    if (array) {
      const length = descriptors.length.value as number;
      need(length <= 1023 && keys.length === length + 1);
      const items: string[] = [];
      for (let i = 0; i < length; i++) { need(Object.hasOwn(descriptors, String(i))); if (i) debit(1); items.push(visit(descriptors[String(i)].value, depth + 1)); }
      out = '[' + items.join(',') + ']';
    } else {
      out = '{' + (keys as string[]).sort().map((k, i) => {
        const key = JSON.stringify(k); debit(new TextEncoder().encode(key).length + 1 + (i ? 1 : 0));
        return key + ':' + visit(descriptors[k].value, depth + 1);
      }).join(',') + '}';
    }
    active.delete(v); return out;
  }
  return visit(value, 0);
}
export function fields(v: unknown, names: readonly string[]): void {
  need(v !== null && typeof v === 'object' && !Array.isArray(v));
  need(Object.keys(v).sort().join(',') === [...names].sort().join(','));
}
export function validateBinding(b: TransferBinding, projectId: string, policyVersion: string): void {
  fields(b, ['projectId', 'policyVersion', 'policyHash', 'compute', 'content']);
  need(b.projectId === projectId && b.policyVersion === policyVersion, 'TRANSFER_BINDING', 409);
  hash(b.policyHash);
  fields(b.compute, ['authorityId', 'workloadId', 'leaseId', 'attemptId', 'capabilityDigest', 'workerId', 'epoch', 'generation', 'incarnation']);
  for (const k of ['authorityId', 'workloadId', 'leaseId', 'attemptId', 'workerId'] as const) identifier(b.compute[k]);
  hash(b.compute.capabilityDigest); integer(b.compute.epoch); integer(b.compute.generation); integer(b.compute.incarnation);
  fields(b.content, ['manifestHash', 'objectKey', 'objectGeneration', 'objectHash', 'bytes']);
  hash(b.content.manifestHash); hash(b.content.objectHash); need(b.content.manifestHash === b.content.objectHash && [
    `projects/${projectId}/objects/${b.content.objectHash}`, `projects/${projectId}/manifests/${b.content.objectHash}`,
  ].includes(b.content.objectKey), 'OBJECT_SCOPE', 409); need(typeof b.content.objectGeneration === 'string' && /^[1-9][0-9]{0,31}(?![\s\S])/.test(b.content.objectGeneration)); integer(b.content.bytes, 1_099_511_627_776);
}
const shape = {
  stageTransfer: ['intentId','binding','expiresAt'], authorizeTransfer: ['intentId','expectedGeneration','binding','expiresAt'],
  cancelTransfer: ['intentId','reason'], revokePolicy: ['reason'],
  attestTransfer: ['attestationId','intentId','generation','binding','manifestHash','bytes','hostAttestation','attestedAt','expiresAt'],
  publishSnapshot: ['snapshotId','intentId','generation','attestationId','provenance'],
  recordVerification: ['verificationId','snapshotId','hostAttestation'],
  createCandidate: ['candidateId','snapshotId','verificationId','expectedCanonicalRevision'],
  promoteCandidate: ['candidateId','expectedCanonicalRevision'],
} as const;
export function validateEnvelope(input: unknown, projectId: string, policyVersion: string): LibraryEnvelope {
  const e = JSON.parse(canonical(input)) as LibraryEnvelope;
  fields(e, ['operation','key','body']); identifier(e.key);
  need(typeof e.operation === 'string' && Object.hasOwn(shape, e.operation));
  fields(e.body, ['version', ...shape[e.operation]]); need(e.body.version === 1);
  for (const [k,v] of Object.entries(e.body)) {
    if (k.endsWith('Id')) identifier(v);
    if (['generation','expectedGeneration','expectedCanonicalRevision','expiresAt','attestedAt','bytes'].includes(k)) integer(v);
    if (k === 'reason') text(v); if (k === 'hostAttestation') hash(v);
    if (k === 'manifestHash') hash(v);
  }
  if (e.operation === 'stageTransfer' || e.operation === 'authorizeTransfer' || e.operation === 'attestTransfer') validateBinding(e.body.binding, projectId, policyVersion);
  if (e.operation === 'publishSnapshot') {
    fields(e.body.provenance, ['source','parentSnapshotId']); text(e.body.provenance.source);
    if (e.body.provenance.parentSnapshotId !== null) identifier(e.body.provenance.parentSnapshotId);
  }
  return e;
}

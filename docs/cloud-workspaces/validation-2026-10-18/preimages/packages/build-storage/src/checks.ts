import {boundedBytes, canonical, freeze, sha256, snapshot} from '../../library-jobs/src/data';
import * as v from '../../build-jobs/src/validation';
import type {ObjectRef, GrantScope} from './types';
export {boundedBytes, canonical, freeze, sha256, snapshot};
export const CHUNK_BYTES = 1048576, MAX_CHUNKS = 128, MAX_TOTAL_BYTES = 128 * CHUNK_BYTES;
/** Wired pilot limits, distinct from generic storage/snapshot primitive ceilings.
 * These are upper bounds, NEVER evidence of free capacity in an existing namespace. */
export const PILOT_LIMITS=Object.freeze({maxOutputBytes:7*CHUNK_BYTES,maxRequiredOutputs:24,
  maxResultChunks:31,maxNamespaceGrants:32,maxNamespaceBytes:8*CHUNK_BYTES});
export function check(ok:unknown, code:string):asserts ok {if(!ok) throw new Error(`build-storage: ${code}`);}
export function alive(signal:AbortSignal) {check(!signal.aborted,'aborted');}
export function relative(path:string) {
  v.relative(path);
  check(!path.includes(':') && !/[\u0000-\u001f\u007f-\u009f\p{Cf}]/u.test(path) && !/[\ud800-\udfff]/u.test(path),'unsafe-path');
  check(path.split('/').every(p=>p===p.trim() && !p.endsWith('.') && Buffer.byteLength(p)<=255),'unsafe-component');
}
export const fold = (path:string) => path.normalize('NFKC').toUpperCase().toLowerCase();
export function uniquePaths(paths:readonly string[]) {
  const seen = new Set<string>(), components = new Map<string,string>();
  for(const path of paths) {
    relative(path); const key=fold(path); check(!seen.has(key),'path-collision'); seen.add(key);
    const parts=path.split('/');
    for(let i=1;i<=parts.length;i++) {const p=parts.slice(0,i).join('/'), k=fold(p), old=components.get(k); check(old===undefined||old===p,'component-collision'); components.set(k,p);}
  }
  for(const path of paths) {const parts=path.split('/'); for(let i=1;i<parts.length;i++) check(!seen.has(fold(parts.slice(0,i).join('/'))),'file-directory-collision');}
}
export function exactRef(value:unknown, projectId:string, kind?:'objects'|'manifests'):ObjectRef {
  const ref=snapshot(value) as ObjectRef; v.ref(ref); check(ref.projectId===projectId,'project-binding');
  if(kind) check(ref.objectKey===`projects/${projectId}/${kind}/${ref.sha256}`,'object-kind');
  return freeze(ref);
}
export function scopeCopy(value:GrantScope):GrantScope {
  const s=snapshot(value) as GrantScope;
  v.exact(s,['projectId','principalRef','compute','namespaceRef']);
  // Intersection with the existing broker/library identifier grammar.
  for(const id of [s.projectId,s.principalRef,s.namespaceRef]) check(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id),'scope-id');
  v.exact(s.compute,['authorityId','workloadId','leaseId','epoch','generation','attemptId','capabilityDigest','workerId','incarnation']);
  for(const id of [s.compute.authorityId,s.compute.workloadId,s.compute.leaseId,s.compute.attemptId,s.compute.workerId]) check(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id),'compute-id');
  v.uint(s.compute.epoch,1); v.uint(s.compute.generation); v.uint(s.compute.incarnation); v.digest(s.compute.capabilityDigest);
  return freeze(s);
}
export function jsonBytes(value:unknown):Uint8Array {const b=Buffer.from(canonical(value)); check(b.length>0&&b.length<=CHUNK_BYTES,'manifest-too-large'); return b;}

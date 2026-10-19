import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactClaim, BuildJob, InputApproval, ObjectRef, ResultManifest } from '../../build-jobs/src/contracts.js';
import type { InputSnapshot } from '../../build-storage/src/snapshots.js';
import {verifyLocalProjectInputSnapshot} from '../../build-storage/src/project-inputs.js';
import type {LocalContentStore,LocalRef,ManagedTreeSeal} from '../../build-storage/src/types.js';
import { canonical } from './host.js';
import { canonicalData } from './parent-profile.js';
import { check, localPath, approvalFor } from './plans.js';
import type { RuntimePlan } from './types.js';
export interface BoundObject { claim:ArtifactClaim; bytes:Uint8Array }
export interface RestoreReceipt {
  inputHash:string; inputRoot:string; workRoot:string;
  /** Authenticated manifest bytes, bound to InputApproval.manifest. */
  manifest:{ref:ObjectRef;bytes:Uint8Array};
  /** Private host ports for INDEPENDENT filesystem verification of v2 inputs.
   * Never serialized into commands, artifacts, journals or browser responses. */
  projectLocal?:{snapshot:LocalRef;local:LocalContentStore;seal:ManagedTreeSeal};
}
export interface PublishReceipt { manifest:BoundObject; objects:readonly BoundObject[] }
function digest(bytes:Uint8Array):string { return createHash('sha256').update(bytes).digest('hex'); }
export function sameRef(a:ObjectRef,b:ObjectRef):boolean { return canonicalData(a) === canonicalData(b); }
export function verifyObject(object:{ref:ObjectRef;bytes:Uint8Array},projectId:string):void {
  const r = object.ref;
  check(r.projectId === projectId && /^[0-9a-f]{64}$/.test(r.sha256) && /^[1-9][0-9]{0,31}$/.test(r.generation) &&
    (r.objectKey === `projects/${projectId}/objects/${r.sha256}` || r.objectKey === `projects/${projectId}/manifests/${r.sha256}`) &&
    object.bytes instanceof Uint8Array && object.bytes.byteLength === r.sizeBytes && r.sizeBytes > 0 && r.sizeBytes <= 1048576 && digest(object.bytes) === r.sha256,'bound-object-invalid');
}
/** Uses build-storage InputSnapshot unchanged; snapshotHash is SHA256(manifest BYTES). */
export async function verifyRestore(receipt:RestoreReceipt, input:InputApproval, job:BuildJob, plan:RuntimePlan, uid:number, maxInputBytes:number, signal:AbortSignal):Promise<void> {
  check(receipt.inputHash === job.inputHash && receipt.inputRoot === plan.inputRoot && receipt.workRoot === plan.workRoot && sameRef(receipt.manifest.ref,input.manifest),'restore-binding-mismatch');
  verifyObject(receipt.manifest,job.projectId);
  check(input.manifest.sha256===input.snapshotHash&&digest(receipt.manifest.bytes)===input.snapshotHash,'input-root-hash-binding');
  const manifest = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(receipt.manifest.bytes)) as InputSnapshot;
  if((manifest.version as number)===2){
    const storage=receipt.projectLocal;check(storage,'project-input-verification-ports-required');
    check(storage.snapshot.sha256===input.snapshotHash&&storage.snapshot.sizeBytes===receipt.manifest.bytes.byteLength,'project-input-local-root-binding');
    await canonical(plan.inputRoot,uid,'directory',true);await canonical(plan.workRoot,uid,'directory',true);
    const verifyAt=async(path:string)=>{
      const actual=await verifyLocalProjectInputSnapshot(storage.snapshot,{path,uid},storage.local,storage.seal,signal,maxInputBytes);
      check(actual.snapshotHash===input.snapshotHash&&actual.projectId===job.projectId&&actual.requiredInputs.length<=128&&actual.missingInputs.length===0&&
        canonicalData(actual.git)===canonicalData(input.git)&&canonicalData(actual.requiredInputs)===canonicalData(input.requiredInputs),'project-input-authority-lineage');
    };
    await verifyAt(plan.inputRoot);
    const recipe=approvalFor(plan).recipe;
    if(recipe.kind==='linux-build-v1'&&recipe.tool!=='cmake')await verifyAt(join(plan.workRoot,'source'));
    return;
  }
  check(digest(receipt.manifest.bytes) === input.snapshotHash && manifest.version === 1 && manifest.projectId === job.projectId &&
    canonicalData(manifest.git) === canonicalData(input.git) && canonicalData(manifest.requiredInputs) === canonicalData(input.requiredInputs) &&
    Array.isArray(manifest.missingInputs) && manifest.missingInputs.length === 0 && Array.isArray(manifest.files) && manifest.files.length <= 128,'unsupported-input-manifest');
  await canonical(plan.inputRoot,uid,'directory',true); await canonical(plan.workRoot,uid,'directory',true);
  const expected = new Set<string>(); let total = 0;
  for (const file of manifest.files) {
    check(!signal.aborted,'restore-aborted'); localPath(file.path);
    check(!expected.has(file.path) && /^[0-9a-f]{64}$/.test(file.sha256) && Number.isSafeInteger(file.sizeBytes) && file.sizeBytes >= 0,'input-file-invalid');
    expected.add(file.path); total += file.sizeBytes;
    check(total <= maxInputBytes,'input-byte-budget');
    const path = join(plan.inputRoot,file.path); await canonical(path,uid,'file');
    const f = await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    try {
      const stat = await f.stat(); check(stat.size === file.sizeBytes,'input-size-mismatch');
      const h = createHash('sha256'); let size = 0;
      for await (const bytes of f.createReadStream({autoClose:false,signal})) {
        size += (bytes as Buffer).byteLength; check(size <= file.sizeBytes,'input-size-mismatch'); h.update(bytes as Buffer);
      }
      check(size === file.sizeBytes && h.digest('hex') === file.sha256,'input-hash-mismatch');
    } finally { await f.close(); }
  }
  for (const required of input.requiredInputs) check(expected.has(required),'required-input-missing');
  // No undeclared files or symlink objects may influence the build.
  const walk = async (base:string,prefix:string):Promise<void> => {
    for (const name of await readdir(base)) {
      check(!signal.aborted,'restore-aborted');
      const rel = prefix ? `${prefix}/${name}` : name, path = join(base,name), stat = await lstat(path);
      check(!stat.isSymbolicLink(),'input-symlink-unsupported');
      if (stat.isDirectory()) await walk(path,rel);
      else check(stat.isFile() && expected.has(rel),'undeclared-input-file');
    }
  };
  await walk(plan.inputRoot,'');
}
export function verifyPublish(receipt:PublishReceipt, job:BuildJob, plan:RuntimePlan, maxBytes:number):ArtifactClaim {
  verifyObject({ref:receipt.manifest.claim.ref,bytes:receipt.manifest.bytes},job.projectId);
  const result = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(receipt.manifest.bytes)) as ResultManifest;
  check(result.version === 1 && result.jobId === job.id && result.attemptId === plan.attemptId && result.inputHash === job.inputHash && result.profileHash === job.profileHash && result.exitCode === 0 && Array.isArray(result.outputs) && result.outputs.length <= 64 && Array.isArray(result.logs) && result.logs.length <= 64,'result-lineage-mismatch');
  const paths = result.outputs.map(o => {
    localPath(o.path);
    const expectedFormat = /\.(app|dSYM|xcarchive)$/.test(o.path) ? 'tar' : 'file';
    check(o.format === expectedFormat,'output-format-mismatch');
    return o.path;
  });
  const fold = (path:string) => path.normalize('NFKC').toUpperCase().toLowerCase();
  check(new Set(paths.map(fold)).size === paths.length && paths.length === plan.outputPaths.length && plan.outputPaths.every(path => paths.includes(path)),'complete-approved-output-set-required');
  const claims = [...result.outputs.flatMap(o => {
    check(Array.isArray(o.chunks) && o.chunks.length <= 128 && /^[0-9a-f]{64}$/.test(o.sha256) && Number.isSafeInteger(o.sizeBytes) && o.sizeBytes >= 0 && o.sizeBytes <= 128*1048576,'invalid-output-chunks');
    check(o.format === 'tar' ? o.sizeBytes >= 1024 && o.sizeBytes % 512 === 0 && o.chunks.length > 0 :
      o.sizeBytes === 0 ? o.chunks.length === 0 : o.chunks.length > 0,'invalid-output-layout');
    return o.chunks;
  }),...result.logs];
  // One additional manifest grant must fit the wired namespace: 31 + 1 <= 32.
  check(claims.length <= 31 && receipt.objects.length === claims.length,'result-object-count');
  let size = 0;
  claims.forEach((claim,index) => {
    const object = receipt.objects[index]!;
    check(canonicalData(claim) === canonicalData(object.claim) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(claim.grantId),'published-claim-mismatch');
    verifyObject({ref:object.claim.ref,bytes:object.bytes},job.projectId); size += object.bytes.byteLength;
  });
  check(size <= Math.min(maxBytes,128*1048576),'result-output-budget');
  let offset = 0;
  for (const output of result.outputs) {
    // No chunks for an empty regular file: the normal fold verifies SHA-256(empty).
    // No zero-byte provider object/grant is invented; tar still requires its framing.
    const digest = createHash('sha256'); let bytes = 0;
    for (const _claim of output.chunks) { const chunk = receipt.objects[offset++]!; digest.update(chunk.bytes); bytes += chunk.bytes.byteLength; }
    check(bytes === output.sizeBytes && digest.digest('hex') === output.sha256,'whole-output-chunk-hash-mismatch');
  }
  check(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(receipt.manifest.claim.grantId),'manifest-grant-invalid');
  return receipt.manifest.claim;
}

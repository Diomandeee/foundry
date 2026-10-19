import {createHash} from 'node:crypto';
import type {BuildJob,ResultManifest,ArtifactClaim} from '../../build-jobs/src/contracts.js';
import {result as validateResult} from '../../build-jobs/src/validation.js';
import type {PackagingPorts,GrantScope,ApprovedFile} from '../../build-storage/src/types.js';
import {reserve,publish,current} from '../../build-storage/src/publication.js';
import type {BuildAttemptContext} from './controller.js';
import type {PublishReceipt,BoundObject} from './receipts.js';
import type {RuntimePlan} from './types.js';
import {canonicalData} from './parent-profile.js';
import {check,hash} from './plans.js';
export interface CapturedLinuxFile {path:string;sha256:string;sizeBytes:number;bytes:Uint8Array}
/** Byte-based publication, deliberately not a pretend filesystem seal. Only the
 * concrete adapter calls this with hash-checked immutable broker captures. Cloud
 * grants/capacity/fences and independent authority verification remain unchanged. */
export async function publishLinuxCapture(job:BuildJob,plan:RuntimePlan,context:BuildAttemptContext,scope:GrantScope,
  selections:readonly ApprovedFile[],files:readonly CapturedLinuxFile[],log:Uint8Array,
  ports:Pick<PackagingPorts,'writer'|'issuer'|'capacity'>,maxBytes:number,signal:AbortSignal):Promise<PublishReceipt>{
  check(scope.projectId===job.projectId&&canonicalData(scope.compute)===canonicalData(context.compute),'linux-publication-scope');
  check(files.length===selections.length&&selections.length===plan.outputPaths.length&&new Set(files.map(f=>f.path)).size===files.length&&
    plan.outputPaths.every(p=>files.some(f=>f.path===p)&&selections.some(s=>s.path===p)),'linux-output-selection');
  check(selections.every(s=>s.classification==='build-output'||s.classification==='debug-symbols'),'linux-unsigned-output-classification');
  const copied=files.map(f=>({...f,bytes:Uint8Array.from(f.bytes)})),logs=Uint8Array.from(log);
  let total=logs.length,count=Math.ceil(logs.length/1048576);
  for(const f of copied){
    check(!/\.(app|dSYM|xcarchive)$/.test(f.path)&&f.sizeBytes===f.bytes.length&&createHash('sha256').update(f.bytes).digest('hex')===f.sha256,'linux-captured-output-bytes');
    total+=f.bytes.length;count+=Math.ceil(f.bytes.length/1048576);
  }
  check(total<=maxBytes&&count<=31,'linux-output-publication-budget');
  const reservation=await reserve(scope,count+1,total+1048576,ports,signal,
    hash(canonicalData({kind:'linux-isolated-output-v1',scope,jobId:job.id,attemptId:plan.attemptId,files:copied.map(f=>({path:f.path,sha256:f.sha256,sizeBytes:f.sizeBytes})),logSha256:createHash('sha256').update(logs).digest('hex')})));
  const objects:BoundObject[]=[];
  const write=async(bytes:Uint8Array):Promise<ArtifactClaim[]>=>{
    const claims:ArtifactClaim[]=[];
    for(let offset=0;offset<bytes.length;offset+=1048576){
      const part=Uint8Array.from(bytes.subarray(offset,offset+1048576));
      const claim=await publish(part,'objects',scope,reservation,ports,signal);objects.push({claim,bytes:part});claims.push(claim);
    }
    return claims;
  };
  const outputs:ResultManifest['outputs']=[];
  for(const f of copied)outputs.push({path:f.path,format:'file',sizeBytes:f.sizeBytes,sha256:f.sha256,chunks:await write(f.bytes)});
  const manifest:ResultManifest={version:1,jobId:job.id,attemptId:plan.attemptId,inputHash:job.inputHash,profileHash:job.profileHash,exitCode:0,outputs,logs:await write(logs)};
  validateResult(manifest);const bytes=Buffer.from(canonicalData(manifest));
  const claim=await publish(bytes,'manifests',scope,reservation,ports,signal);await current(ports,reservation,signal);
  return {manifest:{claim,bytes},objects};
}

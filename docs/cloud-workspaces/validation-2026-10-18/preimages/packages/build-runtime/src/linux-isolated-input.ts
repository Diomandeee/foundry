import {createHash} from 'node:crypto';
import type {InputApproval,BuildJob,ObjectRef,ArtifactClaim} from '../../build-jobs/src/contracts.js';
import type {InputSnapshot} from '../../build-storage/src/snapshots.js';
import {ProjectInputPaths,ProjectInputValidation,decodeProjectMetadata,type ProjectInputSnapshot,type ProjectInputSegment} from '../../build-storage/src/project-input-format.js';
import type {BuildAttemptContext} from './controller.js';
import type {StorageWorkerConfig} from './storage-integration.js';
import type {RuntimePlan,ExecutionScope} from './types.js';
import {canonicalData} from './parent-profile.js';
import {sameRef,verifyObject} from './receipts.js';
import {check,hash,localPath} from './plans.js';
import type {LinuxIsolationClient} from './linux-isolated-client.js';
interface Part {ref:ObjectRef;offset:number;sizeBytes:number;claim?:ArtifactClaim}
interface File {path:string;sha256:string;sizeBytes:number;mode:number;parts:Part[];retainedObject?:ObjectRef}
export interface LinuxInputPlan {files:File[];bytes:number;filesHash:string}
/** Validate complete metadata first; no host materialization and no writable seal.
 * Each actual broker object and reconstructed file is verified again while streamed. */
export async function prepareLinuxInput(input:InputApproval,job:BuildJob,plan:RuntimePlan,context:BuildAttemptContext,
  read:StorageWorkerConfig['readInput'],scope:ExecutionScope,maxBytes:number):Promise<LinuxInputPlan>{
  const get=async(ref:ObjectRef)=>{scope.assertLease();const bytes=await read(ref,{input,plan,attempt:context},scope.signal);scope.assertLease();verifyObject({ref,bytes},input.projectId);return bytes;};
  check(hash(canonicalData(input))===job.inputHash&&input.manifest.sha256===input.snapshotHash&&input.reconstructable&&input.missingInputs.length===0,'linux-input-approval');
  const encoded=await get(input.manifest), root=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(encoded)) as InputSnapshot|ProjectInputSnapshot;
  const files:File[]=[],paths=new ProjectInputPaths();let total=0;
  const add=(file:File)=>{
    localPath(file.path);paths.add(file.path);check(/^[0-9a-f]{64}$/.test(file.sha256)&&Number.isSafeInteger(file.sizeBytes)&&file.sizeBytes>=0&&file.sizeBytes<=64*1048576,'linux-input-file');
    check(Number.isSafeInteger(file.mode)&&file.mode>=0&&file.mode<=0o777&&(file.mode&0o022)===0,'linux-input-mode');
    total+=file.sizeBytes;check(files.length<8192&&total<=maxBytes&&total<=2*1024**3,'linux-input-cap');files.push(file);
  };
  check(canonicalData(root.git)===canonicalData(input.git),'linux-input-git-lineage');
  if(root.version===2){
    const index=decodeProjectMetadata<ProjectInputSnapshot>(encoded,'root'),validation=new ProjectInputValidation(index);
    check(index.projectId===input.projectId&&index.totals.bytes<=maxBytes,'linux-project-input-cap');
    for(const page of index.segments){
      const segment=decodeProjectMetadata<ProjectInputSegment>(await get(page.ref),'segment');validation.accept(segment);
      // Validation makes every non-final chunk a whole, exclusively covered MiB
      // object. Only final chunks can share a blob. Group by that object within
      // this segment, including packed blobs at indices other than writer index 0.
      // The resulting stream order is bound by filesHash below, not the manifest's
      // selection order. Required-input validation keeps its original order.
      const groups=new Map<number,typeof segment.files>();
      for(const f of segment.files){
        const object=f.chunks[f.chunks.length-1]?.object??-1,group=groups.get(object)??[];
        group.push(f);groups.set(object,group);
      }
      for(const [object,group] of groups)for(const f of group)add({path:f.path,sha256:f.sha256,sizeBytes:f.sizeBytes,mode:f.mode,
        retainedObject:object<0?undefined:segment.objects[object],
        parts:f.chunks.map(p=>({ref:segment.objects[p.object]!,offset:p.offset,sizeBytes:p.sizeBytes}))});
    }
    validation.finish(true);check(canonicalData([...validation.required])===canonicalData(input.requiredInputs),'linux-required-inputs');
  }else{
    check(root.version===1&&root.projectId===input.projectId&&Array.isArray(root.files)&&root.files.length>0&&root.files.length<=128&&
      Array.isArray(root.missingInputs)&&root.missingInputs.length===0&&canonicalData(root.requiredInputs)===canonicalData(input.requiredInputs),'linux-legacy-input-shape');
    let chunks=0;
    for(const f of root.files){
      check(Array.isArray(f.chunks)&&f.chunks.length<=64,'linux-legacy-chunks');
      const parts=f.chunks.map(claim=>{chunks++;check(chunks<=128,'linux-legacy-chunk-budget');return {ref:claim.ref,offset:0,sizeBytes:claim.ref.sizeBytes,claim};});
      check(parts.reduce((n,p)=>n+p.sizeBytes,0)===f.sizeBytes,'linux-legacy-file-size');
      add({path:f.path,sha256:f.sha256,sizeBytes:f.sizeBytes,mode:f.mode,parts});
    }
  }
  check(files.length>0&&input.requiredInputs.length<=128&&input.requiredInputs.every(p=>files.some(f=>f.path===p)),'linux-required-file-absent');
  return {files,bytes:total,filesHash:hash(JSON.stringify(files.map(f=>[f.path,f.sha256,f.sizeBytes,f.mode])))};
}
export async function streamLinuxInput(prepared:LinuxInputPlan,client:LinuxIsolationClient,identity:string,input:InputApproval,plan:RuntimePlan,
  context:BuildAttemptContext,read:StorageWorkerConfig['readInput'],scope:ExecutionScope):Promise<void>{
  const send=async(body:object)=>{scope.assertLease();const response=await client.request(body,scope.signal) as {identity?:string};check(response.identity===identity,'linux-input-session');scope.assertLease();};
  // Retain only the current group's verified final object (at most 1 MiB).
  // Intervening whole chunks stream without eviction or a second cache/copy.
  let cached:{ref:ObjectRef;bytes:Uint8Array}|undefined;
  for(const f of prepared.files){
    if(cached?.ref!==f.retainedObject)cached=undefined;
    await send({op:'file',path:f.path,sha256:f.sha256,sizeBytes:f.sizeBytes,mode:f.mode});
    const digest=createHash('sha256');let offset=0;
    for(const part of f.parts){
      check(!scope.signal.aborted,'linux-input-read-scope');scope.assertLease();
      const retain=f.retainedObject!==undefined&&sameRef(part.ref,f.retainedObject);
      const object=retain&&cached?cached.bytes:await read(part.ref,{input,plan,attempt:context,claim:part.claim},scope.signal);scope.assertLease();
      verifyObject({ref:part.ref,bytes:object},input.projectId);
      if(retain)cached={ref:f.retainedObject!,bytes:object};
      check(Number.isSafeInteger(part.offset)&&part.offset>=0&&Number.isSafeInteger(part.sizeBytes)&&part.sizeBytes>0&&part.offset+part.sizeBytes<=object.byteLength,'linux-input-range');
      const bytes=object.subarray(part.offset,part.offset+part.sizeBytes);digest.update(bytes);
      await send({op:'append',offset,data:Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength).toString('base64')});offset+=bytes.byteLength;
    }
    check(offset===f.sizeBytes&&digest.digest('hex')===f.sha256,'linux-stream-file-hash');await send({op:'end'});
  }
  await send({op:'seal'});
}

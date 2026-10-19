import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {lstat} from 'node:fs/promises';
import type {BuildJob,InputApproval,ObjectRef} from '../../build-jobs/src/contracts.js';
import * as v from '../../build-jobs/src/validation.js';
import {inspectFile,inspectDirectory,readFileChunks,siblingNames,rootCopy} from '../../build-storage/src/filesystem.js';
import {ProjectInputPaths,ProjectInputValidation,decodeProjectMetadata,type ProjectInputSnapshot,type ProjectInputSegment} from '../../build-storage/src/project-input-format.js';
import {validateLocalRef} from '../../build-storage/src/local-refs.js';
import type {InputSnapshot} from '../../build-storage/src/snapshots.js';
import {macReadonlyTreeIdentity,type ReadonlyManagedTreeSeal,type MacReadonlyTreeIdentity} from '../../build-storage/src/mac-readonly-seal.js';
import {assertBuildAttemptContext,type BuildAttemptContext} from './controller.js';
import {canonicalData} from './parent-profile.js';
import {approvalFor,check,hash,localPath} from './plans.js';
import {sameRef,verifyObject} from './receipts.js';
import type {RuntimePlan} from './types.js';
import type {MacVmInputFile} from './mac-vm-job.js';

export interface VerifiedMacVmInput {
  readonly snapshotHash:string;readonly inputHash:string;readonly projectId:string;
  readonly root:Readonly<MacReadonlyTreeIdentity>;readonly files:readonly Readonly<MacVmInputFile>[];
  readonly fileCount:number;readonly sizeBytes:number;
}
interface InputBinding {plan:RuntimePlan;context:BuildAttemptContext;input:InputApproval;job:BuildJob;seal:ReadonlyManagedTreeSeal}
const verifiedInputs=new WeakMap<VerifiedMacVmInput,InputBinding>();
export function assertVerifiedMacVmInput(receipt:VerifiedMacVmInput,plan:RuntimePlan):Readonly<InputBinding> {
  const binding=verifiedInputs.get(receipt);check(binding && binding.plan===plan,'mac-vm-unverified-input');
  assertBuildAttemptContext(binding.context);
  check(canonicalData(macReadonlyTreeIdentity(binding.seal))===canonicalData(receipt.root),'mac-vm-input-guard-binding');
  return binding;
}
export interface VerifyMacVmInputRequest {
  plan:RuntimePlan;context:BuildAttemptContext;input:InputApproval;job:BuildJob;
  manifest:{ref:ObjectRef;bytes:Uint8Array};seal:ReadonlyManagedTreeSeal;
  /** Real bounded pinned reader; every returned metadata byte/hash/ref is verified
   * here. Caller cannot replace root-approved metadata by returning different bytes. */
  readMetadata(ref:ObjectRef,context:BuildAttemptContext,signal:AbortSignal):Promise<Uint8Array>;
}
/** Full approved metadata plus actual immutable source-tree verification. Does NOT
 * create/mount images, copy a mutable checkout, install a helper or launch a VM.
 * Only a concrete kernel-readonly factory guard can mint this private receipt. */
export async function verifyMacVmInput(request:VerifyMacVmInputRequest,signal:AbortSignal):Promise<VerifiedMacVmInput> {
  const plan=request.plan,a=approvalFor(plan),context=request.context,seal=request.seal,readMetadata=request.readMetadata;assertBuildAttemptContext(context);
  check(plan.kind==='xcode-build-v1' && a.recipe.kind==='xcode-build-v1','mac-vm-input-kind');
  const input=JSON.parse(canonicalData(request.input)) as InputApproval,job=JSON.parse(canonicalData(request.job)) as BuildJob;
  v.input(input);v.job(job);
  check(input.reconstructable && input.missingInputs.length===0 && input.projectId===job.projectId &&
    hash(canonicalData(input))===job.inputHash && context.inputHash===job.inputHash && context.projectId===input.projectId && input.manifest.sha256===input.snapshotHash,'mac-vm-approved-input-binding');
  check(job.id===plan.jobId && job.profileHash===context.serverProfileHash && context.localRecipeHash===plan.profileHash &&
    context.compute.workloadId===job.id && context.compute.attemptId===plan.attemptId && context.compute.leaseId===plan.attemptId &&
    context.source.epoch===context.compute.epoch && context.source.authorityId===context.compute.authorityId,'mac-vm-input-claim-binding');
  check(request.manifest.bytes instanceof Uint8Array && request.manifest.bytes.byteLength===input.manifest.sizeBytes,'mac-vm-manifest-byte-budget');
  const manifest={ref:JSON.parse(canonicalData(request.manifest.ref)) as ObjectRef,bytes:Uint8Array.from(request.manifest.bytes)};
  check(sameRef(input.manifest,manifest.ref),'mac-vm-manifest-ref');verifyObject(manifest,input.projectId);
  const tree=macReadonlyTreeIdentity(seal),root=rootCopy({path:tree.path,uid:0});
  const files:MacVmInputFile[]=[],required:string[]=[],paths=new ProjectInputPaths();
  const groups:{objects:ObjectRef[];files:{path:string;chunks:{object:number;offset:number;sizeBytes:number}[]}[]}[]=[];
  let total=0;
  const add=(f:MacVmInputFile)=>{
    localPath(f.path);v.digest(f.sha256);v.uint(f.sizeBytes,0,64*1048576);
    check([0o600,0o644,0o700,0o755].includes(f.mode),'mac-vm-input-mode-unsupported');
    paths.add(f.path);total+=f.sizeBytes;check(files.length<1024 && total<=2*1024**3,'mac-vm-input-budget');
    files.push(Object.freeze({path:f.path,sha256:f.sha256,sizeBytes:f.sizeBytes,mode:f.mode}));
  };
  const raw=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(manifest.bytes)) as InputSnapshot|ProjectInputSnapshot;
  if(raw.version===2){
    const snapshot=decodeProjectMetadata<ProjectInputSnapshot>(manifest.bytes,'root'),validation=new ProjectInputValidation(snapshot);
    check(snapshot.segments.reduce((n,p)=>n+p.ref.sizeBytes,manifest.bytes.byteLength)<=16*1048576,'mac-vm-total-metadata-budget');
    check(snapshot.projectId===input.projectId && snapshot.totals.files<=1024 && snapshot.totals.bytes<=2*1024**3 &&
      snapshot.totals.missing===0 && canonicalData(snapshot.git)===canonicalData(input.git),'mac-vm-root-metadata');
    for(const page of snapshot.segments){
      check(!signal.aborted,'mac-vm-input-aborted');
      const observed=await readMetadata(page.ref,context,signal);
      check(observed instanceof Uint8Array && observed.byteLength===page.ref.sizeBytes,'mac-vm-metadata-byte-budget');
      const bytes=Uint8Array.from(observed);
      verifyObject({ref:page.ref,bytes},input.projectId);
      const segment=decodeProjectMetadata<ProjectInputSegment>(bytes,'segment');validation.accept(segment);
      segment.files.forEach(add);required.push(...segment.requiredInputs);
      groups.push({objects:segment.objects,files:segment.files});
    }
    validation.finish(true);
  }else{
    v.exact(raw,['version','projectId','files','requiredInputs','missingInputs','git','historyEvidence']);
    check(raw.version===1 && raw.projectId===input.projectId && Array.isArray(raw.files) && raw.files.length>0 && raw.files.length<=128 &&
      Array.isArray(raw.requiredInputs) && Array.isArray(raw.missingInputs) && raw.missingInputs.length===0 &&
      canonicalData(raw.git)===canonicalData(input.git),'mac-vm-legacy-metadata');
    if(raw.git.historyPreserved){check(raw.historyEvidence!==null,'mac-vm-missing-history-evidence');validateLocalRef(raw.historyEvidence);}
    else check(raw.historyEvidence===null,'mac-vm-unattested-history-evidence');
    for(const file of raw.files){
      v.exact(file,['path','classification','retention','sha256','sizeBytes','chunks','localChunks','mode']);
      check(['source-input','source-history'].includes(file.classification) && file.retention==='retain' &&
        Array.isArray(file.chunks) && Array.isArray(file.localChunks) && file.chunks.length===Math.ceil(file.sizeBytes/1048576) &&
        file.chunks.length===file.localChunks.length && file.chunks.length<=64,'mac-vm-legacy-file');
      let bytes=0;
      file.chunks.forEach((chunk,index)=>{
        v.claim(chunk);validateLocalRef(file.localChunks[index]);
        check(chunk.ref.projectId===input.projectId && chunk.ref.objectKey===`projects/${input.projectId}/objects/${chunk.ref.sha256}` &&
          chunk.ref.sizeBytes===Math.min(1048576,file.sizeBytes-index*1048576) &&
          file.localChunks[index].sha256===chunk.ref.sha256 && file.localChunks[index].sizeBytes===chunk.ref.sizeBytes,'mac-vm-legacy-chunks');
        bytes+=chunk.ref.sizeBytes;
      });
      check(bytes===file.sizeBytes,'mac-vm-legacy-file-size');add(file);
      groups.push({objects:file.chunks.map(c=>c.ref),files:[{path:file.path,chunks:file.chunks.map((c,i)=>({object:i,offset:0,sizeBytes:c.ref.sizeBytes}))}]});
    }
    required.push(...raw.requiredInputs);
  }
  check(files.length>0 && required.length<=128 && canonicalData(required)===canonicalData(input.requiredInputs),'mac-vm-required-set-binding');
  check(input.requiredInputs.every(p=>files.some(f=>f.path===p)),'mac-vm-input-incomplete');
  // The guard protects every actual file for the whole scan and byte verification.
  await seal.withReadonlyTrees([root.path],async()=>{
    check(!signal.aborted,'mac-vm-input-aborted');
    const expected=new Set(files.map(f=>f.path)),dirs=new Set<string>();
    for(const f of files){const parts=f.path.split('/');for(let i=1;i<parts.length;i++)dirs.add(parts.slice(0,i).join('/'));}
    const pending=[''];let entries=0,observedFiles=0;
    while(pending.length){
      const parent=pending.pop()!,base=parent?join(root.path,parent):root.path;
      for(const name of await siblingNames(base,signal,20000)){
        check(++entries<=20000,'mac-vm-input-entry-budget');const path=parent?`${parent}/${name}`:name;
        const s=await lstat(join(root.path,path));
        if(s.isDirectory()){check(dirs.has(path),'mac-vm-undeclared-directory');await inspectDirectory(root,path,signal,false);pending.push(path);}
        else{check(expected.has(path),'mac-vm-undeclared-input');await inspectFile(root,path,signal,false);observedFiles++;}
      }
    }
    check(observedFiles===files.length,'mac-vm-actual-input-set');
    const byPath=new Map(files.map(f=>[f.path,f]));
    for(const group of groups){
      // At most 128 one-MiB objects per segment; never buffer the whole input.
      const blobs=group.objects.map(ref=>Buffer.alloc(ref.sizeBytes));
      for(const entry of group.files){
        const file=byPath.get(entry.path)!;
        const stat=await inspectFile(root,file.path,signal,false),digest=createHash('sha256');
        check(stat.size===file.sizeBytes,'mac-vm-source-size');
        await readFileChunks(root,file.path,stat,1048576,async(bytes,index)=>{
          digest.update(bytes);const range=entry.chunks[index];
          check(range && range.sizeBytes===bytes.byteLength,'mac-vm-source-range');
          blobs[range.object].set(bytes,range.offset);
        },signal,false);
        check(digest.digest('hex')===file.sha256,'mac-vm-source-content');
      }
      group.objects.forEach((ref,i)=>check(createHash('sha256').update(blobs[i]).digest('hex')===ref.sha256,'mac-vm-source-object-content'));
    }
  },signal);
  check(!signal.aborted,'mac-vm-input-aborted');
  Object.freeze(input.git);Object.freeze(input.requiredInputs);Object.freeze(input.missingInputs);Object.freeze(input.manifest);Object.freeze(input);Object.freeze(job);
  const receipt:VerifiedMacVmInput=Object.freeze({snapshotHash:input.snapshotHash,inputHash:job.inputHash,projectId:input.projectId,
    root:tree,files:Object.freeze(files),fileCount:files.length,sizeBytes:total});
  verifiedInputs.set(receipt,Object.freeze({plan,context,input,job,seal}));return receipt;
}

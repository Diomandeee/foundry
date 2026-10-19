import {assertMacIsolatedStore} from '../../build-storage/src/mac-isolated-store.js';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import * as v from '../../build-jobs/src/validation.js';
import {macReadonlyTreeIdentity,type ReadonlyManagedTreeSeal} from '../../build-storage/src/mac-readonly-seal.js';
import {relative,uniquePaths} from '../../build-storage/src/checks.js';
import {inspectFile} from '../../build-storage/src/filesystem.js';
import {collectOutputs,writeResultManifest,validateFileSelections} from '../../build-storage/src/packaging.js';
import type {ApprovedFile,GrantScope,LocalRef,PackagingPorts} from '../../build-storage/src/types.js';
import {canonical} from './host.js';
import {assertParentBinding,canonicalData,type ParentProfileBinding} from './parent-profile.js';
import {assertVerifiedMacVmInput} from './mac-vm-input.js';
import {macVmGuestInput,type MacVmGuestJob} from './mac-vm-job.js';
import {macVmStoppedBinding,type MacVmStopEvidence} from './mac-vm.js';
import {ioHash,type MacVmIoRequest} from './mac-vm-staging.js';
import {parentDirectories,readMacVmMetadata,verifyMacVmTree,type TreeFile} from './mac-vm-tree.js';
import {check,hash} from './plans.js';
import {verifyObject,verifyPublish,type BoundObject,type PublishReceipt} from './receipts.js';
import type {RuntimePlan} from './types.js';

const MAX_RAW=16*1024**3;
interface IntakeBinding {plan:RuntimePlan;job:MacVmGuestJob;stop:MacVmStopEvidence;rawSha256:string}
const requests=new WeakMap<MacVmIoRequest,IntakeBinding>();
const requested=new WeakSet<MacVmStopEvidence>();
const publishedRequests=new WeakSet<MacVmIoRequest>();
const intakes=new WeakMap<VerifiedMacVmResult,IntakeBinding&{seal:ReadonlyManagedTreeSeal;request:MacVmIoRequest;published:boolean}>();
export interface VerifiedMacVmResult {
  readonly kind:'verified-stopped-guest-output';readonly root:string;readonly rawSha256:string;
  readonly requestSha256:string;readonly guestResultSha256:string;
  /** Local byte/lineage verification only; never authority acceptance. */
  readonly authorityStatus:'not-submitted';
}
/** Hash the exact stopped backing file, before any owner-operated mount/copy. The
 * real stop brand, plan, guest job and inode must all agree. One request per stop;
 * uncertain/interrupted processing requires explicit retained-state reconciliation. */
export async function prepareMacVmIntake(plan:RuntimePlan,job:MacVmGuestJob,stop:MacVmStopEvidence,
  guardSha256:string,signal:AbortSignal):Promise<MacVmIoRequest>{
  const binding=macVmStoppedBinding(stop,plan,job),o=binding.output;
  check(binding.executionStarted,'mac-vm-result-without-observed-start');
  v.digest(guardSha256);check(o.sizeBytes<=MAX_RAW&&!signal.aborted,'mac-vm-intake-size-or-abort');
  check(!requested.has(stop),'mac-vm-intake-already-requested');requested.add(stop);
  await canonical(o.path,o.uid,'file');
  const f=await open(o.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  let rawSha256:string;
  try{
    const before=await f.stat({bigint:true});
    check(before.isFile()&&before.nlink===1n&&before.uid===BigInt(o.uid)&&(before.mode&0o7777n)===0o600n&&
      String(before.dev)===o.device&&String(before.ino)===o.inode&&before.size===BigInt(o.sizeBytes),'mac-vm-stopped-disk-binding');
    const h=createHash('sha256'),buffer=Buffer.alloc(1048576);let offset=0;
    while(offset<o.sizeBytes){
      check(!signal.aborted,'mac-vm-intake-aborted');
      const {bytesRead}=await f.read(buffer,0,Math.min(buffer.length,o.sizeBytes-offset),offset);
      check(bytesRead>0,'mac-vm-intake-short');h.update(buffer.subarray(0,bytesRead));offset+=bytesRead;
    }
    const after=await f.stat({bigint:true}),named=await lstat(o.path,{bigint:true});
    check([after,named].every(s=>s.dev===before.dev&&s.ino===before.ino&&s.uid===before.uid&&s.mode===before.mode&&s.nlink===before.nlink&&
      s.size===before.size&&s.mtimeNs===before.mtimeNs&&s.ctimeNs===before.ctimeNs),'mac-vm-output-mutated');
    rawSha256=h.digest('hex');
  }finally{await f.close();}
  check(!signal.aborted,'mac-vm-intake-aborted');
  const request=JSON.stringify({version:1,kind:'intake',attemptId:plan.attemptId,guardSha256,jobSha256:binding.guestJobSha256,output:o,rawSha256});
  const receipt=Object.freeze({kind:'intake' as const,request,sha256:hash(request)});
  requests.set(receipt,{plan,job,stop,rawSha256});return receipt;
}

interface GuestResult {
  version:3;guestCapabilityHash:string;guestRunnerSha256:string;identity:string;attemptId:string;jobId:string;profileHash:string;sourceHash:string;
  guestMacos:string;xcodeBuild:string;exitCode:number;limited:boolean;
  outputs:(TreeFile&{mode:number})[];directories:string[];logSha256:string;logBytes:number;
}
const bundle=(path:string)=>/\.(app|dSYM|xcarchive)$/.test(path);
/** This must run INSIDE the concrete readonly guard, before any publication. */
async function verifyIntake(binding:IntakeBinding,request:MacVmIoRequest,root:string,signal:AbortSignal):Promise<string>{
  const {plan,job,stop}=binding,stopped=macVmStoppedBinding(stop,plan,job);
  assertVerifiedMacVmInput(macVmGuestInput(job,plan),plan);
  const bytes=await readMacVmMetadata(root,'result.json',1048576,signal);
  const result=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes)) as GuestResult;
  v.exact(result,['guestCapabilityHash','guestRunnerSha256','version','identity','attemptId','jobId','profileHash','sourceHash','guestMacos','xcodeBuild','exitCode','limited','outputs','directories','logSha256','logBytes']);
  check(result.version===3&&result.guestCapabilityHash===job.guestCapabilityHash&&result.guestRunnerSha256===job.guestRunnerSha256&&result.identity===job.identity&&result.attemptId===job.attemptId&&result.jobId===job.jobId&&
    result.profileHash===job.profileHash&&result.sourceHash===job.sourceHash&&result.guestMacos===job.recipe.macos&&
    result.xcodeBuild===job.recipe.xcodeBuild&&result.exitCode===0&&result.limited===false,'mac-vm-guest-success-lineage');
  check(Array.isArray(result.outputs)&&Array.isArray(result.directories)&&result.outputs.length+result.directories.length<=19990,'mac-vm-result-count');
  v.digest(result.logSha256);v.uint(result.logBytes,0,job.limits.maxOutputBytes);
  const selected=job.recipe.outputPaths;uniquePaths([...selected,'.foundry-vm.log']);
  const allowed=(p:string)=>selected.some(s=>p===s||(bundle(s)&&p.startsWith(`${s}/`)));
  const files:TreeFile[]=[];let total=result.logBytes;
  for(const file of result.outputs){
    v.exact(file,['path','sha256','sizeBytes','mode']);relative(file.path);v.digest(file.sha256);v.uint(file.sizeBytes,0,job.limits.maxOutputBytes);
    check(allowed(file.path)&&[0o644,0o755].includes(file.mode),'mac-vm-unapproved-output');
    total+=file.sizeBytes;check(total<=job.limits.maxOutputBytes,'mac-vm-result-total');
    files.push({path:`payload/${file.path}`,sha256:file.sha256,sizeBytes:file.sizeBytes});
  }
  const declaredDirs=new Set<string>();
  for(const dir of result.directories){relative(dir);check(allowed(dir)&&!declaredDirs.has(dir),'mac-vm-output-directory');declaredDirs.add(dir);}
  for(const path of selected)check(bundle(path)?declaredDirs.has(path)&&!result.outputs.some(f=>f.path===path):
    result.outputs.some(f=>f.path===path)&&!declaredDirs.has(path),'mac-vm-required-output-missing-or-type');
  const provenance=canonicalData({version:1,kind:'intake',requestSha256:request.sha256,jobSha256:stopped.guestJobSha256,
    rawSha256:binding.rawSha256,output:stopped.output});
  files.push({path:'payload/.foundry-vm.log',sha256:result.logSha256,sizeBytes:result.logBytes},
    {path:'result.json',sha256:ioHash(bytes),sizeBytes:bytes.byteLength},
    {path:'provenance.json',sha256:hash(provenance),sizeBytes:Buffer.byteLength(provenance)});
  const directories=new Set([...parentDirectories(files),...result.directories.map(d=>`payload/${d}`)]);
  // Include implicit parents of empty bundles; reject other unexplained trees.
  for(const d of [...directories])for(const p of parentDirectories([{path:`${d}/_`}]))directories.add(p);
  await verifyMacVmTree(root,files,[...directories],signal);
  for(const file of result.outputs){
    const stat=await inspectFile({path:root,uid:0},`payload/${file.path}`,signal,false);
    check((stat.mode&0o7777)===(file.mode===0o755?0o555:0o444),'mac-vm-output-mode');
  }
  return ioHash(bytes);
}

export async function acceptMacVmIntake(plan:RuntimePlan,job:MacVmGuestJob,stop:MacVmStopEvidence,request:MacVmIoRequest,
  seal:ReadonlyManagedTreeSeal,signal:AbortSignal):Promise<VerifiedMacVmResult>{
  const binding=requests.get(request);check(binding?.plan===plan&&binding.job===job&&binding.stop===stop,'mac-vm-intake-request-binding');
  const root=`/Library/Foundry/VM/attempts/${plan.attemptId}/intake`,tree=macReadonlyTreeIdentity(seal);
  check(tree.path===root&&tree.mountPoint===root,'mac-vm-intake-mount-binding');
  const guestResultSha256=await seal.withReadonlyTrees([root],()=>verifyIntake(binding,request,root,signal),signal);
  const receipt=Object.freeze({kind:'verified-stopped-guest-output' as const,root,rawSha256:binding.rawSha256,
    requestSha256:request.sha256,guestResultSha256,authorityStatus:'not-submitted' as const});
  intakes.set(receipt,{...binding,request,seal,published:false});return receipt;
}

/** Real storage composition, invoked separately after matching operational
 * approval. The existing broker/capacity/fence and create-only writer remain the
 * publication authority. No fabricated generations or no-op writable seal. */
async function publishIntake(receipt:VerifiedMacVmResult,profile:ParentProfileBinding,
  scope:GrantScope,outputs:readonly ApprovedFile[],base:PackagingPorts,signal:AbortSignal):Promise<PublishReceipt>{
  assertMacIsolatedStore(base.local);
  const known=intakes.get(receipt);check(known&&!known.published&&!publishedRequests.has(known.request),'mac-vm-unverified-or-replayed-intake');
  assertParentBinding(profile);
  const {plan,job}=known,binding=assertVerifiedMacVmInput(macVmGuestInput(job,plan),plan),context=binding.context;
  check(profile.localRecipeHash===plan.profileHash&&profile.serverProfileHash===context.serverProfileHash&&
    scope.projectId===context.projectId&&canonicalData(scope.compute)===canonicalData(context.compute),'mac-vm-publication-scope');
  const selections=JSON.parse(canonicalData(outputs)) as ApprovedFile[];validateFileSelections(selections,'outputs');
  check(selections.length===plan.outputPaths.length&&plan.outputPaths.every(p=>selections.some(s=>s.path===p)),'mac-vm-publication-selection');
  // Latch BEFORE awaits. Failed or ambiguous publication is retained, never retried
  // automatically against another namespace or a new reservation.
  known.published=true;publishedRequests.add(known.request);
  const refs=new Map<string,LocalRef>();
  const ports:PackagingPorts={...base,readSeal:{withReadonlyTrees:async(roots,run,sig)=>{
    check(roots.length===1&&roots[0]===join(receipt.root,'payload'),'mac-vm-intake-collection-root');
    return known.seal.withReadonlyTrees([receipt.root],async()=>{
      check(await verifyIntake(known,known.request,receipt.root,sig)===receipt.guestResultSha256,'mac-vm-intake-replaced');
      return run();
    },sig);
  }},local:{put:async(bytes,sig)=>{const local=await base.local.put(bytes,sig);refs.set(`${local.sha256}:${local.sizeBytes}`,local);return local;},
    read:(ref,sig)=>base.local.read(ref,sig)}};
  const collected=await collectOutputs({root:{path:join(receipt.root,'payload'),uid:0},profile:profile.profile,scope,
    outputs:selections,logs:[{path:'.foundry-vm.log',classification:'build-log'}]},ports,signal);
  const staged=await writeResultManifest({jobId:binding.job.id,attemptId:plan.attemptId,inputHash:context.inputHash,
    profileHash:context.serverProfileHash,exitCode:0,collected},ports,signal);
  const objects:BoundObject[]=[];
  for(const claim of [...staged.manifest.outputs.flatMap(o=>o.chunks),...staged.manifest.logs]){
    const local=refs.get(`${claim.ref.sha256}:${claim.ref.sizeBytes}`);check(local,'mac-vm-publication-local-ref');
    const bytes=await base.local.read(local,signal);verifyObject({ref:claim.ref,bytes},context.projectId);objects.push({claim,bytes});
  }
  const bytes=await base.local.read(staged.local,signal),result={manifest:{claim:staged.artifact,bytes},objects};
  verifyPublish(result,binding.job,plan,profile.profile.limits.maxOutputBytes);
  check(!signal.aborted,'mac-vm-publish-aborted');return result;
}

export async function publishMacVmIntake(receipt:VerifiedMacVmResult,profile:ParentProfileBinding,
  scope:GrantScope,outputs:readonly ApprovedFile[],base:PackagingPorts,signal:AbortSignal):Promise<PublishReceipt>{
  const lifetime=new AbortController(),abort=()=>lifetime.abort();
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)lifetime.abort();
  try{return await publishIntake(receipt,profile,scope,outputs,base,lifetime.signal);}
  finally{
    // A guard failure can reject before a callback finishes. Cancel its concrete
    // storage/read operations too; retain any already admitted partial writes.
    lifetime.abort();signal.removeEventListener('abort',abort);
  }
}

import {createHash} from 'node:crypto';
import {macReadonlyTreeIdentity,type ReadonlyManagedTreeSeal} from '../../build-storage/src/mac-readonly-seal.js';
import {assertVerifiedMacVmInput} from './mac-vm-input.js';
import {assertMacVmGuestJob,macVmGuestInput,type MacVmGuestJob} from './mac-vm-job.js';
import {canonicalData} from './parent-profile.js';
import {check,hash} from './plans.js';
import {parentDirectories,verifyMacVmTree,type TreeFile} from './mac-vm-tree.js';
import type {RuntimePlan} from './types.js';

export interface MacVmIoRequest {readonly kind:'stage'|'intake';readonly request:string;readonly sha256:string}
export interface StagedMacVmInput {readonly path:string;readonly requestSha256:string;readonly guestJobSha256:string}
const requests=new WeakMap<MacVmIoRequest,{plan:RuntimePlan;job:MacVmGuestJob}>();
const staged=new WeakMap<StagedMacVmInput,{plan:RuntimePlan;job:MacVmGuestJob;seal:ReadonlyManagedTreeSeal;files:TreeFile[]}>();
export const ioHash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
/** Prepare data ONLY. Root operator must separately approve and invoke the supplied
 * mac-vm-io.py source. No sudo, helper installation, copy or mount at this boundary. */
export function prepareMacVmStaging(plan:RuntimePlan,job:MacVmGuestJob,guardSha256:string):MacVmIoRequest {
  assertMacVmGuestJob(job,plan);const verified=macVmGuestInput(job,plan);assertVerifiedMacVmInput(verified,plan);
  check(/^[a-f0-9]{64}$/.test(guardSha256),'mac-vm-guard-pin');
  check(verified.root.path.startsWith('/Library/Foundry/VM/sources/'),'mac-vm-owner-source-root-required');
  check(verified.sizeBytes+Buffer.byteLength(canonicalData(job))+4096<=2*1024**3,'mac-vm-staged-tree-byte-budget');
  const request=JSON.stringify({version:1,kind:'stage',attemptId:plan.attemptId,guardSha256,
    job:JSON.parse(canonicalData(job)),jobSha256:hash(canonicalData(job)),source:verified.root});
  check(Buffer.byteLength(request)<=524288,'mac-vm-io-request-budget');
  const receipt=Object.freeze({kind:'stage' as const,request,sha256:hash(request)});requests.set(receipt,{plan,job});return receipt;
}
/** Observe actual mounted bytes. A helper's stdout, receipt, or claimed successful
 * copy is insufficient. The seal pins the real readonly volume and root inode. */
export async function acceptMacVmStaging(plan:RuntimePlan,job:MacVmGuestJob,request:MacVmIoRequest,
  seal:ReadonlyManagedTreeSeal,signal:AbortSignal):Promise<StagedMacVmInput>{
  const known=requests.get(request);check(known?.plan===plan&&known.job===job,'mac-vm-stage-request-binding');
  const path=`/Library/Foundry/VM/attempts/${plan.attemptId}/input`,tree=macReadonlyTreeIdentity(seal);
  check(tree.path===path&&tree.mountPoint===path,'mac-vm-stage-mount-binding');
  const jobText=canonicalData(job),provenance=canonicalData({version:1,kind:'stage',requestSha256:request.sha256,jobSha256:hash(jobText)});
  const files:TreeFile[]=[{path:'job.json',sha256:hash(jobText),sizeBytes:Buffer.byteLength(jobText)},
    {path:'provenance.json',sha256:hash(provenance),sizeBytes:Buffer.byteLength(provenance)},
    ...job.files.map(f=>({path:`source/${f.path}`,sha256:f.sha256,sizeBytes:f.sizeBytes}))];
  await seal.withReadonlyTrees([path],()=>verifyMacVmTree(path,files,parentDirectories(files),signal),signal);
  const receipt=Object.freeze({path,requestSha256:request.sha256,guestJobSha256:hash(jobText)});
  staged.set(receipt,{plan,job,seal,files});return receipt;
}
/** Fresh full verification and held readonly guard span physical launch through
 * whole-VM stop. A receipt does not turn a prior observation into eternal proof. */
export async function withStagedMacVmInput<T>(receipt:StagedMacVmInput,plan:RuntimePlan,job:MacVmGuestJob,
  run:()=>Promise<T>,signal:AbortSignal):Promise<T>{
  const binding=staged.get(receipt);check(binding?.plan===plan&&binding.job===job,'mac-vm-unverified-staging');
  check(binding.seal.operationLimitMs>=plan.timeoutMs+120000,'mac-vm-stage-guard-lifetime-too-short');
  assertVerifiedMacVmInput(macVmGuestInput(job,plan),plan);
  return binding.seal.withReadonlyTrees([receipt.path],async()=>{
    await verifyMacVmTree(receipt.path,binding.files,parentDirectories(binding.files),signal);
    check(!signal.aborted,'mac-vm-stage-aborted');return run();
  },signal);
}

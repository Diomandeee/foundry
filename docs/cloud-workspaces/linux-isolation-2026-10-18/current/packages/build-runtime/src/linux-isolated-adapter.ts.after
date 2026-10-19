import {mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {BuildJob,InputApproval} from '../../build-jobs/src/contracts.js';
import type {ApprovedFile} from '../../build-storage/src/types.js';
import {projectObjectReader} from '../../build-storage/src/project-input-io.js';
import {assertBuildAttemptContext,type BuildAttemptContext} from './controller.js';
import {canonical,assertJournalReservation} from './host.js';
import {check,phasesFor,approvalFor,hash,buildPlan} from './plans.js';
import {canonicalData,assertParentBinding,type ParentProfileBinding} from './parent-profile.js';
import {LinuxIsolationClient,type LinuxIsolationConfig} from './linux-isolated-client.js';
import {prepareLinuxInput,streamLinuxInput} from './linux-isolated-input.js';
import {publishLinuxCapture,type CapturedLinuxFile} from './linux-isolated-publication.js';
import type {StorageWorkerConfig} from './storage-integration.js';
import type {RuntimeAdapter,RuntimePlan,ExecutionScope,Running,Exit,StopProof,SupervisorResult} from './types.js';
import type {PublishReceipt} from './receipts.js';
export interface LinuxIsolatedAdapterConfig {
  binding:ParentProfileBinding;isolation:LinuxIsolationConfig;maxInputBytes:number;
  resolveInputStorage:NonNullable<StorageWorkerConfig['projectInputs']>['resolve'];
  resolveResultStorage:NonNullable<StorageWorkerConfig['resolveResultStorage']>;
  outputs:readonly ApprovedFile[];
}
/** Data-only owner policy proposal; it supplies NO installed pins/approval. Owner
 * separately installs this exact profile under binding.localRecipeHash. */
export function linuxIsolationProfile(binding:ParentProfileBinding,maxInputBytes:number):object{
  assertParentBinding(binding);const a=binding.approval,r=a.recipe;
  check(r.kind==='linux-build-v1'&&Number.isSafeInteger(maxInputBytes)&&maxInputBytes>0&&maxInputBytes<=2*1024**3,'linux-isolated-policy');
  check(a.limits.cpu<=64&&a.limits.timeoutMs>=1000&&a.limits.timeoutMs<=3600000&&a.limits.maxOutputBytes<=31*1048576,'linux-broker-supported-limits');
  const plan=buildPlan(a,{attemptId:'policy',jobId:'policy',inputRoot:a.host.inputBase+'/policy',workRoot:a.host.workBase+'/policy'});
  return {image:r.image,architecture:r.architecture==='x64'?'amd64':r.architecture,commands:phasesFor(plan),env:plan.env,
    cpu:a.limits.cpu,ramMib:a.limits.ramMib,pids:a.limits.pids,tmpMib:a.limits.tmpMib,timeoutMs:a.limits.timeoutMs,
    maxOutputBytes:a.limits.maxOutputBytes,maxInputBytes,outputPaths:r.outputPaths,sourceCopy:r.tool!=='cmake'};
}
interface Reply {identity:string;terminal:boolean;success:boolean;exitCode:number|null;outputs:Array<{path:string;sha256:string;sizeBytes:number}>;log:{sha256:string;sizeBytes:number}}
interface State {context:BuildAttemptContext;job:BuildJob;scope:ExecutionScope;client:LinuxIsolationClient;identity:string;
  started:boolean;published:boolean;stopped:boolean;files?:CapturedLinuxFile[];log?:Uint8Array}
/** Private root-owned staging/execution/capture. Controller roots hold metadata
 * only; neither same-UID host paths nor a generic seal enter the build. */
export class LinuxIsolatedRuntimeAdapter implements RuntimeAdapter {
  private readonly c:LinuxIsolatedAdapterConfig;
  private readonly states=new WeakMap<RuntimePlan,State>();
  private readonly preparing=new WeakSet<RuntimePlan>();
  constructor(config:LinuxIsolatedAdapterConfig){
    assertParentBinding(config.binding);
    const data=JSON.parse(canonicalData({isolation:config.isolation,maxInputBytes:config.maxInputBytes,outputs:config.outputs}));
    this.c={...config,...data};linuxIsolationProfile(config.binding,data.maxInputBytes);
    check(data.outputs.length===config.binding.profile.outputPaths.length&&new Set(data.outputs.map((o:ApprovedFile)=>o.path)).size===data.outputs.length&&
      config.binding.profile.outputPaths.every(p=>data.outputs.some((o:ApprovedFile)=>o.path===p)),'linux-output-policy');
    check(data.outputs.every((o:ApprovedFile)=>! /\.(app|dSYM|xcarchive)$/.test(o.path)&&(o.classification==='build-output'||o.classification==='debug-symbols')),'linux-regular-unsigned-outputs-only');
  }
  async prepareAttempt(input:InputApproval,job:BuildJob,plan:RuntimePlan,context:BuildAttemptContext,scope:ExecutionScope,maxInputBytes:number):Promise<void>{
    const c=this.c,h=c.binding.approval.host;
    assertBuildAttemptContext(context);assertJournalReservation(scope.reservation,plan);scope.assertLease();
    check(process.platform==='linux'&&h.allowActivation&&!this.preparing.has(plan)&&plan.profileHash===c.binding.localRecipeHash&&
      context.localRecipeHash===plan.profileHash&&context.serverProfileHash===c.binding.serverProfileHash&&context.inputHash===job.inputHash&&context.projectId===job.projectId,'linux-attempt-binding');
    this.preparing.add(plan);
    const storage=await c.resolveInputStorage(input,plan,context,scope.signal);scope.assertLease();
    check(storage.scope.projectId===input.projectId&&canonicalData(storage.scope.compute)===canonicalData(context.compute),'linux-input-broker-scope');
    const reader=projectObjectReader(storage.scope,storage.routing,scope.signal);
    // At most one pinned blob is retained. Packed adjacent files share its bytes;
    // all issued reservations are freshly rechecked before physical launch.
    let cached:{key:string;bytes:Uint8Array}|undefined;
    const read:StorageWorkerConfig['readInput']=async(ref,_context,signal)=>{
      check(signal===scope.signal&&!signal.aborted,'linux-input-read-scope');scope.assertLease();
      const key=canonicalData(ref);if(cached?.key===key)return Uint8Array.from(cached.bytes);
      const bytes=await reader.read(ref);scope.assertLease();cached={key,bytes:Uint8Array.from(bytes)};return bytes;
    };
    const prepared=await prepareLinuxInput(input,job,plan,context,read,scope,Math.min(c.maxInputBytes,maxInputBytes));
    const client=await LinuxIsolationClient.connect(c.isolation,scope.signal);
    scope.signal.addEventListener('abort',()=>client.close(),{once:true});
    try{
      const reply=await client.request({op:'begin',attemptId:plan.attemptId,profileHash:plan.profileHash,inputHash:job.inputHash,
        filesHash:prepared.filesHash,bytes:prepared.bytes,files:prepared.files.length},scope.signal,true) as {identity:string;profile:unknown;helperSha256:string;pythonSha256:string};scope.assertLease();
      const expected=hash(JSON.stringify([plan.attemptId,plan.profileHash,job.inputHash,prepared.filesHash]));
      check(reply.identity===expected&&reply.helperSha256===c.isolation.helperSha256&&reply.pythonSha256===c.isolation.pythonSha256&&
        canonicalData(reply.profile)===canonicalData(linuxIsolationProfile(c.binding,c.maxInputBytes)),'linux-root-policy-mismatch');
      await scope.reservation.recordIdentity(expected);
      await streamLinuxInput(prepared,client,expected,input,plan,context,read,scope);await reader.finish();scope.assertLease();
      for(const base of [h.inputBase,h.workBase])await canonical(base,h.uid,'directory',true);
      scope.assertLease();await mkdir(plan.inputRoot,{mode:0o700});scope.assertLease();await mkdir(plan.workRoot,{mode:0o700});
      this.states.set(plan,{context,job,scope,client,identity:expected,started:false,published:false,stopped:false});
    }catch{client.close();throw new Error('linux-isolated-preparation-unconfirmed');}
  }
  async prepare(plan:RuntimePlan):Promise<void>{const s=this.states.get(plan);check(s&&!s.started,'linux-verified-preparation-required');s.scope.assertLease();}
  private async request(s:State,body:object,signal:AbortSignal):Promise<Reply>{
    const r=await s.client.request(body,signal) as Reply;
    check(r.identity===s.identity&&typeof r.terminal==='boolean'&&typeof r.success==='boolean'&&(!r.success||(r.terminal&&r.exitCode===0))&&
      (r.exitCode===null||Number.isInteger(r.exitCode)&&r.exitCode>=0&&r.exitCode<=255),'linux-broker-state');return r;
  }
  private runway(s:State):string{
    const began=process.hrtime.bigint();
    const ms=Math.floor(s.scope.remainingMs());check(ms>0&&ms<=60000,'linux-current-runway');
    // Linux Node hrtime and Python monotonic_ns use CLOCK_MONOTONIC on this
    // same host. No wall-clock or receipt-arrival extension of authority TTL.
    return (began+BigInt(ms)*1000000n).toString();
  }
  async start(plan:RuntimePlan,_record:(id:string)=>Promise<void>,beforeStart:()=>void,scope?:ExecutionScope):Promise<Running>{
    const s=this.states.get(plan);check(s&&scope===s.scope&&!s.started,'linux-prepared-scope');
    assertJournalReservation(s.scope.reservation,plan);beforeStart();s.started=true;
    const first=await this.request(s,{op:'start',expiresAtNs:this.runway(s)},s.scope.signal);s.scope.assertLease();
    const proof=():StopProof=>({stopped:s.stopped,basis:s.stopped?'host-containment-inspect':'unknown',identity:s.identity});
    const completion=(async():Promise<Exit>=>{
      let r=first;
      while(!r.terminal){
        await delay(1000,undefined,{signal:s.scope.signal});s.scope.assertLease();
        r=await this.request(s,{op:'status'},s.scope.signal);
        if(!r.terminal)r=await this.request(s,{op:'pulse',expiresAtNs:this.runway(s)},s.scope.signal);
      }
      s.stopped=true;
      if(!r.success)return {code:r.exitCode===0?null:r.exitCode,signal:null,limited:false,output:new Uint8Array()};
      r=await this.request(s,{op:'capture'},s.scope.signal);s.scope.assertLease();
      check(r.terminal&&r.success&&Array.isArray(r.outputs)&&r.outputs.length===plan.outputPaths.length&&new Set(r.outputs.map(f=>f.path)).size===r.outputs.length&&plan.outputPaths.every(p=>r.outputs.some(f=>f.path===p)),'linux-capture-selection');
      let total=0,chunks=0;
      for(const f of [...r.outputs,r.log]){
        check(Number.isSafeInteger(f.sizeBytes)&&f.sizeBytes>=0&&/^[0-9a-f]{64}$/.test(f.sha256),'linux-capture-metadata');
        total+=f.sizeBytes;chunks+=Math.ceil(f.sizeBytes/1048576);
      }
      check(total<=approvalFor(plan).limits.maxOutputBytes&&chunks<=31,'linux-capture-budget');
      const read=async(index:number,file:{sizeBytes:number;sha256:string})=>{
        const bytes=new Uint8Array(file.sizeBytes);
        for(let offset=0;offset<bytes.length;){
          s.scope.assertLease();const response=await s.client.request({op:'read',index,offset},s.scope.signal) as {identity:string;data:string};
          check(response.identity===s.identity&&typeof response.data==='string'&&response.data.length<=1398104,'linux-capture-frame');
          const part=Buffer.from(response.data,'base64');check(part.toString('base64')===response.data&&part.length===Math.min(1048576,bytes.length-offset),'linux-capture-range');
          bytes.set(part,offset);offset+=part.length;
        }
        check(createHash('sha256').update(bytes).digest('hex')===file.sha256,'linux-capture-hash');return bytes;
      };
      s.files=[];for(let i=0;i<r.outputs.length;i++)s.files.push({...r.outputs[i]!,bytes:await read(i,r.outputs[i]!)});
      s.log=await read(-1,r.log);return {code:0,signal:null,limited:false,output:new Uint8Array()};
    })();void completion.catch(()=>{});
    return {identity:s.identity,completion,inspectStopped:async()=>proof(),stop:async()=>{
      try{const r=await this.request(s,{op:'stop'},new AbortController().signal);s.stopped=r.terminal;}catch{s.stopped=false;}finally{s.client.close();}
      return proof();
    }};
  }
  async publishAttempt(job:BuildJob,plan:RuntimePlan,result:SupervisorResult,context:BuildAttemptContext,signal:AbortSignal):Promise<PublishReceipt>{
    const s=this.states.get(plan);check(s&&s.context===context&&canonicalData(s.job)===canonicalData(job)&&s.stopped&&s.files&&s.log&&
      !s.published&&result.outcome==='completed'&&result.stop.stopped&&result.stop.identity===s.identity&&result.exit?.code===0,'linux-publication-stop-binding');
    s.scope.assertLease();s.published=true;
    try{const resolved=await this.c.resolveResultStorage(job,plan,context,signal);s.scope.assertLease();
      return await publishLinuxCapture(job,plan,context,resolved.scope,this.c.outputs,s.files,s.log,resolved.ports,approvalFor(plan).limits.maxOutputBytes,signal);
    }finally{s.client.close();}
  }
}

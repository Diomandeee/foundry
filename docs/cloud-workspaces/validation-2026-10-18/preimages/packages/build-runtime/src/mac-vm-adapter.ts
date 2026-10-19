import {mkdir} from 'node:fs/promises';
import type {BuildJob,InputApproval} from '../../build-jobs/src/contracts.js';
import type {MacVmCapability} from '../../build-jobs/src/mac-vm-capability.js';
import {createMacReadonlyTreeSeal,type MacReadonlySealConfig} from '../../build-storage/src/mac-readonly-seal.js';
import {createMacIsolatedContentStore,type MacIsolatedStoreConfig} from '../../build-storage/src/mac-isolated-store.js';
import type {ApprovedFile,PackagingPorts} from '../../build-storage/src/types.js';
import {assertBuildAttemptContext,type BuildAttemptContext} from './controller.js';
import {canonical,assertJournalReservation} from './host.js';
import {approvalFor,check} from './plans.js';
import {canonicalData,assertParentBinding,type ParentProfileBinding} from './parent-profile.js';
import {readMacVmCapability,type MacVmCapabilityConfig} from './mac-vm-capability.js';
import {verifyMacVmInput} from './mac-vm-input.js';
import {encodeMacVmGuestJob,type MacVmGuestJob} from './mac-vm-job.js';
import {prepareMacVmStaging,acceptMacVmStaging,type StagedMacVmInput} from './mac-vm-staging.js';
import {launchMacVmContainment,macVmStoppedBinding,type MacVmSession,type MacVmStopEvidence} from './mac-vm.js';
import {prepareMacVmIntake,acceptMacVmIntake,publishMacVmIntake,type VerifiedMacVmResult} from './mac-vm-intake.js';
import {MacVmIoMailbox} from './mac-vm-mailbox.js';
import type {StorageWorkerConfig} from './storage-integration.js';
import type {RuntimeAdapter,RuntimePlan,ExecutionScope,Running,Exit,StopProof,SupervisorResult} from './types.js';
import type {PublishReceipt} from './receipts.js';

export interface MacVmAdapterConfig {
  binding:ParentProfileBinding;capability:MacVmCapabilityConfig;
  /** Existing owner-accepted source images, selected by exact immutable snapshot. */
  sources:readonly {snapshotHash:string;seal:MacReadonlySealConfig}[];
  executable:'/Library/Foundry/bin/mac-vm-host';maxBootBytes:number;maxOutputDiskBytes:number;
  readInput:StorageWorkerConfig['readInput'];
  resolveResultStorage:NonNullable<StorageWorkerConfig['resolveResultStorage']>;
  storage:MacIsolatedStoreConfig;outputs:readonly ApprovedFile[];
}
interface Prepared {
  context:BuildAttemptContext;job:BuildJob;guest:MacVmGuestJob;staged:StagedMacVmInput;
  capability:Readonly<MacVmCapability>;scope:ExecutionScope;
  started:boolean;session?:MacVmSession;stop?:MacVmStopEvidence;intake?:VerifiedMacVmResult;published:boolean;
}
/** Concrete, inert VM adapter. Only privately verified guest bytes can produce a
 * successful Exit. Helper exit=0 alone is containment evidence, never build success.
 * Root I/O is explicitly operator-mediated; no implicit privileged service exists. */
export class MacVmRuntimeAdapter implements RuntimeAdapter {
  private readonly states=new WeakMap<RuntimePlan,Prepared>();
  private readonly preparations=new WeakSet<RuntimePlan>();
  private readonly c:MacVmAdapterConfig;
  private readonly local:PackagingPorts['local'];
  readonly capabilityHash:string;
  constructor(config:MacVmAdapterConfig){
    assertParentBinding(config.binding);
    const data=JSON.parse(canonicalData({capability:config.capability,sources:config.sources,executable:config.executable,
      maxBootBytes:config.maxBootBytes,maxOutputDiskBytes:config.maxOutputDiskBytes,outputs:config.outputs,storage:config.storage}));
    this.c={...config,...data};this.local=createMacIsolatedContentStore(data.storage);this.capabilityHash=data.capability.sha256;
    check(config.binding.profile.kind==='xcode-build-v1'&&data.executable==='/Library/Foundry/bin/mac-vm-host','vm-adapter-policy');
    check(/^[0-9a-f]{64}$/.test(this.capabilityHash)&&Array.isArray(data.sources)&&data.sources.length>0&&data.sources.length<=128,'vm-source-policy');
    const limits=config.binding.approval.limits;
    check(limits.ramMib>=2048&&limits.ramMib<=65536&&limits.timeoutMs%1000===0&&limits.timeoutMs<=3600000,'vm-supported-resource-limits');
    const names=new Set<string>();
    for(const source of data.sources){check(/^[0-9a-f]{64}$/.test(source.snapshotHash)&&!names.has(source.snapshotHash),'vm-source-snapshot');names.add(source.snapshotHash);}
    for(const [value,max] of [[data.maxBootBytes,128*1024**3],[data.maxOutputDiskBytes,8*1024**3]])
      check(Number.isSafeInteger(value)&&value>=1048576&&value<=max&&value%512===0,'vm-disk-policy');
    check(data.outputs.length===config.binding.profile.outputPaths.length&&new Set(data.outputs.map((s:ApprovedFile)=>s.path)).size===data.outputs.length&&
      config.binding.profile.outputPaths.every(p=>data.outputs.some((s:ApprovedFile)=>s.path===p)),'vm-output-classifications');
  }
  async prepareAttempt(input:InputApproval,job:BuildJob,plan:RuntimePlan,context:BuildAttemptContext,scope:ExecutionScope,maxInputBytes:number):Promise<void>{
    const c=this.c,h=c.binding.approval.host;
    assertBuildAttemptContext(context);assertJournalReservation(scope.reservation,plan);scope.assertLease();
    check(h.allowActivation&&!this.preparations.has(plan),'vm-activation-or-replay');this.preparations.add(plan);
    check(context.vmCapabilityHash===this.capabilityHash&&context.serverProfileHash===c.binding.serverProfileHash&&
      context.localRecipeHash===plan.profileHash&&plan.profileHash===c.binding.localRecipeHash,'vm-profile-capability-binding');
    const capability=await readMacVmCapability(c.capability,scope.signal);scope.assertLease();
    const selected=c.sources.find(s=>s.snapshotHash===input.snapshotHash);check(selected,'vm-source-not-provisioned');
    check(selected.seal.helper.sha256===capability.treeGuardSha256,'vm-source-guard-pin');
    const manifest=await c.readInput(input.manifest,{input,plan,attempt:context},scope.signal);scope.assertLease();
    const verified=await verifyMacVmInput({input,job,plan,context,manifest:{ref:input.manifest,bytes:manifest},
      seal:createMacReadonlyTreeSeal(selected.seal),readMetadata:(ref,attempt,signal)=>c.readInput(ref,{input,plan,attempt},signal)},scope.signal);
    scope.assertLease();check(verified.sizeBytes<=maxInputBytes,'vm-controller-input-cap');
    const encoded=encodeMacVmGuestJob(plan,verified,capability);
    // These empty private roots hold controller/runtime metadata only. Source
    // lives on the separately verified readonly image; no fake RestoreReceipt.
    for(const base of [h.inputBase,h.workBase])await canonical(base,h.uid,'directory',true);
    scope.assertLease();await mkdir(plan.inputRoot,{mode:0o700});scope.assertLease();await mkdir(plan.workRoot,{mode:0o700});
    const request=prepareMacVmStaging(plan,encoded.job,capability.treeGuardSha256);
    const seal=await new MacVmIoMailbox(capability.treeGuardSha256).exchange(plan,request,scope);
    const staged=await acceptMacVmStaging(plan,encoded.job,request,seal,scope.signal);scope.assertLease();
    this.states.set(plan,{context,job,guest:encoded.job,staged,capability,scope,started:false,published:false});
  }
  async prepare(plan:RuntimePlan):Promise<void>{
    const s=this.states.get(plan);check(s&&!s.started,'vm-verified-preparation-required');s.scope.assertLease();
  }
  async start(plan:RuntimePlan,_recordIdentity:(id:string)=>Promise<void>,beforeStart:()=>void,scope?:ExecutionScope):Promise<Running>{
    const s=this.states.get(plan);check(s&&scope&&scope===s.scope&&!s.started,'vm-prepared-scope-required');
    assertJournalReservation(scope.reservation,plan);scope.assertLease();beforeStart();s.started=true;
    const base=`/Library/Foundry/VM/attempts/${plan.attemptId}`,a=approvalFor(plan),c=this.c;
    const session=await launchMacVmContainment(plan,{executable:c.executable,sha256:s.capability.vmHelperSha256,configuration:{
      version:2,bootSha256:s.capability.bootSha256,identity:s.guest.identity,jobId:plan.jobId,attemptId:plan.attemptId,
      profileHash:plan.profileHash,guestJobSha256:s.staged.guestJobSha256,helperUID:a.host.uid,cpuCount:plan.cpu,memoryBytes:plan.ramMib*1048576,
      maxBootBytes:c.maxBootBytes,maxOutputBytes:c.maxOutputDiskBytes,maxRunSeconds:plan.timeoutMs/1000,
      bootDisk:`${base}/boot.raw`,outputDisk:`${base}/outputs.raw`,auxiliaryStorage:`${base}/auxiliary.bin`,
      hardwareModel:`${base}/hardware-model.bin`,machineIdentifier:`${base}/machine-identifier.bin`,inputDirectory:`${base}/input`,
    }},s.guest,s.staged,()=>({remainingMs:scope.remainingMs()}),scope.signal,scope.reservation);
    s.session=session;
    const completion=(async():Promise<Exit>=>{
      const stop=await session.settled;s.stop=stop;
      macVmStoppedBinding(stop,plan,s.guest);scope.assertLease();
      const request=await prepareMacVmIntake(plan,s.guest,stop,s.capability.treeGuardSha256,scope.signal);scope.assertLease();
      const seal=await new MacVmIoMailbox(s.capability.treeGuardSha256).exchange(plan,request,scope);
      const intake=await acceptMacVmIntake(plan,s.guest,stop,request,seal,scope.signal);scope.assertLease();s.intake=intake;
      // acceptMacVmIntake checked guest exit=0, not-limited, all required outputs,
      // toolchain, source, attempt and real stopped disk. Logs stay in artifacts.
      return {code:0,signal:null,limited:false,output:new Uint8Array()};
    })();
    void completion.catch(()=>{});
    const proof=(stop:MacVmStopEvidence):StopProof=>{
      if(stop.stopped)macVmStoppedBinding(stop,plan,s.guest);
      return {stopped:stop.stopped,basis:stop.stopped?'host-containment-inspect':'unknown',identity:stop.identity};
    };
    return Object.freeze({identity:session.identity,completion,
      stop:async()=>proof(await session.stop()),
      inspectStopped:async()=>s.stop?proof(s.stop):{stopped:false,basis:'unknown' as const,identity:session.identity}});
  }
  async publishAttempt(job:BuildJob,plan:RuntimePlan,result:SupervisorResult,context:BuildAttemptContext,signal:AbortSignal):Promise<PublishReceipt>{
    const s=this.states.get(plan);check(s&&s.context===context&&canonicalData(s.job)===canonicalData(job)&&s.intake&&s.stop&&
      !s.published&&result.outcome==='completed'&&result.stop.stopped&&result.stop.identity===s.stop.identity,'vm-intake-publication-state');
    macVmStoppedBinding(s.stop,plan,s.guest);s.scope.assertLease();s.published=true;
    const resolved=await this.c.resolveResultStorage(job,plan,context,signal);s.scope.assertLease();
    return publishMacVmIntake(s.intake,this.c.binding,resolved.scope,this.c.outputs,{local:this.local,writer:resolved.ports.writer,issuer:resolved.ports.issuer,capacity:resolved.ports.capacity},signal);
  }
}

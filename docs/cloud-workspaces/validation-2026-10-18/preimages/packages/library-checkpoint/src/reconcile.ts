import {canonical,freeze,sha256} from '../../library-jobs/src/data';
import {fields,identifier,integer,hash,validateBinding,need} from '../../library-catalog/src/validation';
import type {ComputeBinding} from '../../library-jobs/src/types';
import type {FencePage,RevocationContext} from '../../library-revocation/src/types';
import {RevocationRelay} from '../../library-revocation/src/index';
import type {RecoveryChallenge,RecoveryProof} from '../../../workers/library/src/recovery-guard';
import {validateScope,type Checkpoint,type CheckpointScope,type RecoveryCheckpoint} from './index';
export interface FenceObservation {version:1;environment:string;authorityId:string;epoch:number;head:number;observedAt:number;binding:ComputeBinding;current:boolean;accepted:boolean;state:string;expiresAt:number}
export interface ReconcilerPorts {
 checkpoint:RecoveryCheckpoint;relay:RevocationRelay;owner:RevocationContext;dispatcher:RevocationContext;
 source:{observe(binding:ComputeBinding,signal:AbortSignal):Promise<unknown>;readPage(after:number,signal:AbortSignal):Promise<unknown>};
 now?:()=>number;
}
/** Trusted host callback, never a client proof endpoint. One unresolved pass at a time.
 * Timed-out ports that ignore abort retain admission until the actual pass settles. */
export function recoveryReconciler(input:CheckpointScope,ports:ReconcilerPorts){
 const scope=freeze(validateScope(input)),now=ports.now??Date.now;let busy=false;
 const relayIdentity=ports.relay.identity(ports.owner);
 need(relayIdentity.environment===scope.environment&&relayIdentity.authorityId===scope.relayAuthorityId&&relayIdentity.sourceAuthorityId===scope.sourceAuthorityId,'RECONCILER_RELAY_SCOPE');
 function checkpoint():Checkpoint{
  const p=JSON.parse(canonical(ports.checkpoint.latest())) as Checkpoint;fields(p,['version','scope','revision','archiveSha256','approvedAt']);
  need(p.version===1&&canonical(p.scope)===canonical(scope),'RECONCILER_CHECKPOINT_SCOPE');integer(p.revision);need(p.revision>0,'RECONCILER_CHECKPOINT_ABSENT');hash(p.archiveSha256);integer(p.approvedAt);need(p.approvedAt<=now(),'RECONCILER_CHECKPOINT_TIME');return p;
 }
 return async function reconcile(input:RecoveryChallenge,outerSignal:AbortSignal):Promise<RecoveryProof>{
  need(!busy,'RECONCILER_BUSY',429);const challenge=JSON.parse(canonical(input)) as RecoveryChallenge;fields(challenge,['restoreId','archiveSha256','checks']);identifier(challenge.restoreId);hash(challenge.archiveSha256);
  need(Array.isArray(challenge.checks)&&challenge.checks.length<=32,'RECONCILER_CHECK_CAPACITY');
  const ids=new Set<string>(),targets=new Set<string>();for(const c of challenge.checks){fields(c,['intentId','generation','binding','targetId']);identifier(c.intentId);integer(c.generation);need(c.generation>=1);hash(c.targetId);need(c.targetId===sha256(canonical({domain:'library-recovery-target/v1',restoreId:challenge.restoreId,authorityId:scope.catalogAuthorityId,intentId:c.intentId,generation:c.generation})),'RECONCILER_TARGET_BINDING');validateBinding(c.binding,scope.projectId,scope.policyVersion);need(c.binding.policyHash===scope.policyHash&&c.binding.compute.authorityId===scope.sourceAuthorityId&&c.binding.compute.epoch>=1,'RECONCILER_CHECK_SCOPE');need(!ids.has(c.intentId)&&!targets.has(c.targetId),'RECONCILER_DUPLICATE_CHECK');ids.add(c.intentId);targets.add(c.targetId);}
  const start=now();integer(start);const initial=checkpoint();need(initial.archiveSha256===challenge.archiveSha256,'RECOVERY_CHECKPOINT_MISMATCH');
  const retained=ports.relay.sourceWatermark(ports.dispatcher);
  const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;const cancel=()=>abort.abort();
  const interrupted=new Promise<never>((_,reject)=>{abort.signal.addEventListener('abort',()=>reject(new Error('RECONCILER_ABORTED')),{once:true});});
  outerSignal.addEventListener('abort',cancel,{once:true});if(outerSignal.aborted)cancel();timer=setTimeout(cancel,4000);
  const check=()=>{const t=now();integer(t);need(!abort.signal.aborted&&t>=start&&t-start<=4000,'RECONCILER_TIMEOUT');};
  let latestSourceHead=retained.head,latestEpoch=retained.epoch;
  function observation(value:unknown,binding:ComputeBinding,floor:{head:number;epoch:number}):FenceObservation{
   const o=JSON.parse(canonical(value)) as FenceObservation;fields(o,['version','environment','authorityId','epoch','head','observedAt','binding','current','accepted','state','expiresAt']);
   need(o.version===1&&o.environment===scope.environment&&o.authorityId===scope.sourceAuthorityId&&canonical(o.binding)===canonical(binding),'RECONCILER_SOURCE_SCOPE');
   for(const k of ['epoch','head','observedAt','expiresAt'] as const)integer(o[k]);need(o.epoch>=1&&o.epoch>=floor.epoch&&o.head>=floor.head,'RECONCILER_SOURCE_ROLLBACK');
   need(typeof o.current==='boolean'&&typeof o.accepted==='boolean'&&!(o.current&&o.accepted)&&typeof o.state==='string'&&o.state.length<=32,'RECONCILER_SOURCE_SHAPE');
   const t=now();need(o.observedAt<=t&&t-o.observedAt<=1000,'RECONCILER_SOURCE_STALE');
   if(o.current)need(['RUNNING','VERIFYING'].includes(o.state)&&o.expiresAt>o.observedAt&&o.epoch===binding.epoch,'RECONCILER_SOURCE_INVALID');
   if(o.accepted)need(o.state==='SUCCEEDED'&&o.epoch===binding.epoch,'RECONCILER_SOURCE_INVALID');need(!(o.head<=latestSourceHead&&o.epoch>latestEpoch)&&!(o.head>=latestSourceHead&&o.epoch<latestEpoch),'RECONCILER_SOURCE_ROLLBACK');latestSourceHead=Math.max(latestSourceHead,o.head);latestEpoch=Math.max(latestEpoch,o.epoch);ports.relay.observeSource(ports.dispatcher,{head:latestSourceHead,epoch:latestEpoch});return o;
  }
  busy=true;
  const work=(async()=>{
   check();
   for(const c of challenge.checks)ports.relay.register(ports.owner,{version:1,targetId:c.targetId,kind:'catalog',environment:scope.environment,authorityId:scope.catalogAuthorityId,projectId:scope.projectId,resourceId:c.intentId,generation:c.generation,binding:c.binding});
   let pages=0;
   for(let round=0;round<8;round++){
    // Register before catch-up. Retained events also apply to targets registered after an ACK.
    do{
     need(++pages<=16,'RECONCILER_PAGE_CAPACITY');const page=JSON.parse(canonical(await ports.source.readPage(ports.relay.cursor(ports.dispatcher),abort.signal))) as FencePage;check();
     need(page.head>=latestSourceHead&&page.epoch>=latestEpoch,'RECONCILER_SOURCE_ROLLBACK');latestSourceHead=page.head;latestEpoch=page.epoch;
     ports.relay.ingest(ports.dispatcher,page);
     if(page.through===page.head)break;
    }while(true);
    const observations:FenceObservation[]=new Array(challenge.checks.length);let next=0;
    // At most four network observations concurrently. Validate against knowledge at
    // request admission; earlier replies may complete after newer source heads.
    const results=await Promise.allSettled(Array.from({length:Math.min(4,challenge.checks.length)},async()=>{while(next<challenge.checks.length){check();const i=next++,c=challenge.checks[i],floor={head:latestSourceHead,epoch:latestEpoch};const raw=await ports.source.observe(c.binding.compute,abort.signal);check();observations[i]=observation(raw,c.binding.compute,floor);}}));
    const failed=results.find(r=>r.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
    const cursor=ports.relay.cursor(ports.dispatcher);if(latestSourceHead>cursor)continue;
    check();need(canonical(checkpoint())===canonical(initial),'RECONCILER_CHECKPOINT_CHANGED');
    const deliveries=ports.relay.snapshot(ports.owner).deliveries;
    const checks=challenge.checks.map((c,i)=>{
     const o=observations[i];need(now()-o.observedAt<=1000,'RECONCILER_SOURCE_STALE');
     const invalidated=deliveries.some(d=>d.target_id===c.targetId);
     return {...c,valid:!invalidated&&(o.accepted||o.current&&o.expiresAt>now()),sourceHead:o.head,relayCursor:cursor};
    });
    const issuedAt=now(),expiresAt=Math.min(issuedAt+1000,...observations.filter((o,i)=>checks[i].valid&&o.current).map(o=>o.expiresAt));
    const approval=ports.checkpoint.issuePermit({expectedRevision:initial.revision,restoreId:challenge.restoreId,archiveSha256:initial.archiveSha256!,challengeSha256:sha256(canonical(challenge)),expiresAt});check();
    return {approval,restoreId:challenge.restoreId,approvedArchiveSha256:initial.archiveSha256!,observedAt:approval.issuedAt,checks};
   }
   throw new Error('RECONCILER_UNSTABLE_SOURCE');
  })();
  // Release admission only when actual host work settles, even after timeout is returned.
  void work.then(()=>{busy=false;},()=>{busy=false;});
  try{return await Promise.race([work,interrupted]);}finally{if(timer)clearTimeout(timer);outerSignal.removeEventListener('abort',cancel);abort.abort();}
 };
}

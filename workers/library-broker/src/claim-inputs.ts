import {canonical} from '../../../packages/library-jobs/src/data';
import * as v from '../../../packages/build-jobs/src/validation';
import type {InputApproval,BuildJob} from '../../../packages/build-jobs/src/contracts';
import {assertBuildAttemptContext,assertBuildResponseSource,type BuildAttemptContext} from '../../../packages/build-runtime/src/controller';
import type {RuntimePlan} from '../../../packages/build-runtime/src/types';
import type {ResolvedProjectInputPorts} from '../../../packages/build-runtime/src/storage-integration';
import type {BuildNamespaceApproval} from './build-host';
import type {GcsBuildBrokerConfig} from './gcs-build-host';
import {createBuildNamespaceSet} from './build-namespace-set';

/** Owner approves the exact job/input/profile, worker incarnation and generation
 * BEFORE claim. Only the authority's actual attempt/capability digest is filled
 * after claim. This is delegation under an explicit policy, not a self-approval. */
export interface ClaimInputPolicy {
  environment:string;authorityId:string;workerId:string;jobId:string;projectId:string;
  inputHash:string;serverProfileHash:string;localRecipeHash:string;
  epoch:number;generation:number;incarnation:number;
}
export type ClaimNamespaceTemplate=Omit<GcsBuildBrokerConfig,'approval'> & {
  approval:Omit<BuildNamespaceApproval,'scope'> & {scope:Omit<BuildNamespaceApproval['scope'],'compute'>};
};
export interface ApprovedClaimInputSlot {policy:ClaimInputPolicy;namespaces:readonly ClaimNamespaceTemplate[]}

/** Concrete post-claim resolver for a finite preapproved set of generations and
 * namespace DB handles. No wildcard jobs/epochs, new DB paths, operator credential
 * copying, automatic rollover, or arbitrary scope factory is accepted. Construction
 * is inert; explicit resolution initializes only the supplied matching DB handles. */
function claimStorageResolver(approved:readonly ApprovedClaimInputSlot[],publication:boolean){
  if(!Array.isArray(approved)||approved.length<1||approved.length>3)throw new Error('claim-input-slot-budget');
  const slots=approved.map(slot=>{
    const p=JSON.parse(canonical(slot.policy)) as ClaimInputPolicy;
    v.exact(p,['environment','authorityId','workerId','jobId','projectId','inputHash','serverProfileHash','localRecipeHash','epoch','generation','incarnation']);
    for(const id of [p.environment,p.authorityId,p.workerId,p.jobId,p.projectId])v.id(id);
    for(const hash of [p.inputHash,p.serverProfileHash,p.localRecipeHash])v.digest(hash);
    v.uint(p.epoch,1);v.uint(p.generation);v.uint(p.incarnation);
    if(!Array.isArray(slot.namespaces)||slot.namespaces.length<1||slot.namespaces.length>512)throw new Error('claim-input-namespace-budget');
    const templates=slot.namespaces.map((n:ClaimNamespaceTemplate)=>({...n,approval:JSON.parse(canonical(n.approval)) as ClaimNamespaceTemplate['approval']}));
    for(const n of templates){
      if(n.environment!==p.environment||n.authorityId!==p.authorityId||n.approval.profileHash!==p.serverProfileHash||n.approval.scope.projectId!==p.projectId||n.approval.publication!==publication)throw new Error('claim-input-template-binding');
    }
    return {policy:p,templates,bound:null as {compute:string;ports:ReturnType<typeof createBuildNamespaceSet>}|null};
  });
  return async(inputHash:string,projectId:string,plan:RuntimePlan,context:BuildAttemptContext,signal:AbortSignal)=>{
    assertBuildAttemptContext(context);if(signal.aborted)throw new Error('claim-input-cancelled');
    const candidates=slots.filter(({policy:p})=>p.jobId===plan.jobId&&p.projectId===projectId&&p.inputHash===inputHash&&
      p.serverProfileHash===context.serverProfileHash&&p.localRecipeHash===context.localRecipeHash&&p.epoch===context.compute.epoch&&
      p.generation===context.compute.generation&&p.incarnation===context.compute.incarnation&&p.workerId===context.compute.workerId);
    if(candidates.length!==1)throw new Error('claim-input-policy-absent-or-ambiguous');
    const slot=candidates[0]!,p=slot.policy;
    assertBuildResponseSource(context.source,{environment:p.environment,authorityId:p.authorityId,workerId:p.workerId},p.epoch);
    if(context.compute.authorityId!==p.authorityId||context.compute.workloadId!==p.jobId||context.compute.attemptId!==plan.attemptId||context.compute.leaseId!==plan.attemptId||plan.profileHash!==p.localRecipeHash)throw new Error('claim-input-actual-attempt-binding');
    const compute=canonical(context.compute);
    if(slot.bound){if(slot.bound.compute!==compute)throw new Error('claim-input-slot-already-bound');return slot.bound.ports;}
    const configs:GcsBuildBrokerConfig[]=slot.templates.map((n:ClaimNamespaceTemplate)=>({...n,approval:{...n.approval,scope:{...n.approval.scope,compute:JSON.parse(compute)}}}));
    const set=createBuildNamespaceSet(configs);slot.bound={compute,ports:set};return set;
  };
}

/** Actual read namespaces are resolved only after controller claim validation. */
export function createClaimInputResolver(approved:readonly ApprovedClaimInputSlot[]){
  const resolve=claimStorageResolver(approved,false);
  return async(input:InputApproval,plan:RuntimePlan,context:BuildAttemptContext,signal:AbortSignal):Promise<ResolvedProjectInputPorts>=>{
    v.input(input);const set=await resolve(v.hash(input),input.projectId,plan,context,signal);
    return {scope:set.routing.namespaces[0]!.scope,routing:set.routing};
  };
}
/** Pilot outputs use exactly one preapproved publication namespace per job generation.
 * Writer/issuer/capacity are bound after actual claim; no placeholder preclaim scope. */
export function createClaimResultResolver(approved:readonly ApprovedClaimInputSlot[]){
  if(approved.some(slot=>slot.namespaces.length!==1))throw new Error('claim-result-single-namespace-required');
  const resolve=claimStorageResolver(approved,true);
  return async(job:BuildJob,plan:RuntimePlan,context:BuildAttemptContext,signal:AbortSignal)=>{
    v.job(job);if(job.id!==plan.jobId||job.profileHash!==context.serverProfileHash)throw new Error('claim-result-job-binding');
    const set=await resolve(job.inputHash,job.projectId,plan,context,signal),host=set.hosts[0]!;
    return {scope:host.scope,ports:{writer:host.writer,issuer:host.issuer,capacity:host.capacity}};
  };
}

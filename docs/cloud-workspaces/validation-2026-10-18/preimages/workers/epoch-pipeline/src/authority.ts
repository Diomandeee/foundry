import {EpochPipeline,PipelineRejected,type PipelineOptions,type ComputeTransport} from '../../../packages/epoch-dispatch/src/index';
import {InboxRejected} from '../../../packages/epoch-inbox/src/inbox';
import {ChainRejected} from '../../../packages/epoch-chain/src/chain';
import {StacksDecodeError} from '../../../packages/stacks-events/src/index';
import {authenticate} from '../../compute/src/transport-auth';
import {boundedJson,exact,HttpFailure,jsonResponse} from '../../compute/src/http';
export interface PipelineEnvironment {
 EPOCH_TRANSPORT_ENABLED?:string;EPOCH_ENVIRONMENT:string;EPOCH_AUTHORITY_NAME:string;EPOCH_AUTH_CONFIG?:string;
 EPOCH_PIPELINE?:DurableObjectNamespace;EPOCH_PIPELINE_CONFIG:string;
 FOUNDRY?:Fetcher;COMPUTE_TARGET?:string;COMPUTE_OWNER_BEARER?:string;COMPUTE_SUBMITTER_BEARER?:string;COMPUTE_SUBMITTER_PRINCIPAL?:string;
}
/** Old-style SQLite DO. Identity comes exclusively from host digest authentication. */
export class EpochPipelineAuthority {
 private core:EpochPipeline;
 constructor(state:DurableObjectState,private env:PipelineEnvironment,host:{now?:()=>number}={}){
  const config=JSON.parse(env.EPOCH_PIPELINE_CONFIG) as PipelineOptions;
  if(config.chain.environment!==env.EPOCH_ENVIRONMENT||config.chain.authorityId!==env.EPOCH_AUTHORITY_NAME)throw new Error('pipeline host binding');
  if(host.now)config.chain={...config.chain,now:host.now};
  this.core=new EpochPipeline({sql:{exec:(q,...b)=>state.storage.sql.exec(q,...b)},transactionSync:fn=>state.storage.transactionSync(fn)},config);
 }
 async fetch(request:Request):Promise<Response>{
  if(this.env.EPOCH_TRANSPORT_ENABLED!=='true')return jsonResponse({ok:false,code:'pipeline-disabled'},503);
  try{
   if(new URL(request.url).protocol!=='https:')throw new HttpFailure(400,'https-required');
   let actor;try{actor=authenticate(request,this.env.EPOCH_AUTH_CONFIG??'',this.env.EPOCH_ENVIRONMENT);}catch{throw new HttpFailure(401,'unauthorized');}
   if(request.method!=='POST')throw new HttpFailure(405,'post-required');
   if(!['owner','submitter','projector'].includes(actor.role))throw new HttpFailure(403,'role-forbidden');
   const context={environment:this.env.EPOCH_ENVIRONMENT,principal:actor.principal,role:actor.role==='owner'?'owner':actor.role==='submitter'?'observer':'projector'} as const;
   const path=new URL(request.url).pathname;const input=await boundedJson(request,70000);
   if(path==='/v1/pipeline/observe'){exact(input,['key','expectedCursor','block','transaction','eventIndex']);return jsonResponse(this.core.ingest(context,input as any));}
   if(path==='/v1/pipeline/header'){exact(input,['block']);return jsonResponse(this.core.observeHeader(context,input.block));}
   if(path==='/v1/pipeline/register'){exact(input,['key']);return jsonResponse(this.core.register(context,input.key));}
   if(path==='/v1/pipeline/bootstrap'){exact(input,['expectedRevision','rootId']);return jsonResponse(this.core.bootstrap(context,input as any));}
   if(path==='/v1/pipeline/reconcile'){exact(input,['expectedRevision','tipId','checkpoint','bitcoinHeaders']);return jsonResponse(this.core.reconcile(context,input as any));}
   if(path==='/v1/pipeline/recover'){exact(input,['intentId']);return jsonResponse(this.core.recover(context,input as any));}
   if(path==='/v1/pipeline/decisions'){exact(input,['after','limit']);return jsonResponse(this.core.readDecisions(context,input as any));}
   if(path==='/v1/pipeline/snapshot'){exact(input,[]);return jsonResponse(this.core.snapshot(context));}
   if(path==='/v1/pipeline/dispatch'){
    exact(input,[]);if(!['owner','projector'].includes(context.role))throw new HttpFailure(403,'dispatcher-required');
    const e=this.env;if(!e.FOUNDRY||!e.COMPUTE_OWNER_BEARER||!e.COMPUTE_SUBMITTER_BEARER||!e.COMPUTE_SUBMITTER_PRINCIPAL||!e.COMPUTE_TARGET)throw new HttpFailure(503,'compute-unconfigured');
    const transport:ComputeTransport={fetcher:e.FOUNDRY,target:e.COMPUTE_TARGET,ownerBearer:e.COMPUTE_OWNER_BEARER,submitterBearer:e.COMPUTE_SUBMITTER_BEARER,submitterPrincipal:e.COMPUTE_SUBMITTER_PRINCIPAL};
    return jsonResponse(await this.core.dispatch(transport));
   }
   throw new HttpFailure(404,'not-found');
  }catch(error){
   if(error instanceof InboxRejected||error instanceof ChainRejected||error instanceof PipelineRejected||error instanceof HttpFailure)return jsonResponse({ok:false,code:error.code},error.status);
   if(error instanceof StacksDecodeError)return jsonResponse({ok:false,code:error.code},400);
   return jsonResponse({ok:false,code:'temporarily-unavailable'},503);
  }
 }
}

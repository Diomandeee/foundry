import {EpochInbox,InboxRejected,type Envelope} from '../../../packages/epoch-inbox/src/inbox';
import {authenticate} from '../../compute/src/transport-auth';
import {boundedJson,exact,HttpFailure,jsonResponse} from '../../compute/src/http';
import type {TransactionPort} from '../../../packages/compute-authority/src/durable/contracts';
export interface EpochEnvironment {
 EPOCH_ENVIRONMENT:string;
 EPOCH_AUTHORITY_NAME:string;
 EPOCH_AUTH_CONFIG?:string;
 EPOCH_TRANSPORT_ENABLED?:string;
 EPOCH_INBOX?:DurableObjectNamespace;
}
/** Source observations only. No chain-finality or workload dispatch authority. */
export class EpochInboxAuthority {
 private readonly inbox:EpochInbox;
 constructor(state:DurableObjectState,private readonly env:EpochEnvironment){
  const storage:TransactionPort={sql:{exec:(query,...bindings)=>state.storage.sql.exec(query,...bindings)},transactionSync:callback=>state.storage.transactionSync(callback)};
  this.inbox=new EpochInbox(storage,{environment:env.EPOCH_ENVIRONMENT,authorityId:state.id.toString()});
 }
 async fetch(request:Request):Promise<Response>{
  if(this.env.EPOCH_TRANSPORT_ENABLED!=='true')return jsonResponse({ok:false,code:'epoch-transport-disabled'},503);
  try{
   if(new URL(request.url).protocol!=='https:')throw new HttpFailure(400,'https-required');
   let actor;
   try{actor=authenticate(request,this.env.EPOCH_AUTH_CONFIG??'',this.env.EPOCH_ENVIRONMENT);}catch{throw new HttpFailure(401,'unauthorized');}
   if(!['owner','submitter','projector'].includes(actor.role))throw new HttpFailure(403,'role-forbidden');
   if(request.method!=='POST')throw new HttpFailure(405,'post-required');
   const path=new URL(request.url).pathname;
   if(!['/v1/epoch/commands','/v1/epoch/snapshot'].includes(path))throw new HttpFailure(404,'not-found');
   const context={environment:this.env.EPOCH_ENVIRONMENT,principal:actor.principal,role:actor.role==='owner'?'owner':actor.role==='projector'?'projector':'observer'} as const;
   const input=await boundedJson(request,40000);
   if(path==='/v1/epoch/snapshot'){
    exact(input,[]);
    if(context.role!=='owner')throw new HttpFailure(403,'owner-required');
    return jsonResponse(this.inbox.snapshot(context));
   }
   exact(input,['operation','key','body']);
   if(typeof input.operation!=='string'||typeof input.key!=='string'||!input.body||typeof input.body!=='object'||Array.isArray(input.body))throw new HttpFailure(400,'invalid-command');
   return jsonResponse(this.inbox.execute(context,input as unknown as Envelope));
  }catch(error){
   if(error instanceof InboxRejected)return jsonResponse({ok:false,code:error.code},error.status);
   if(error instanceof HttpFailure)return jsonResponse({ok:false,code:error.code},error.status);
   if(error instanceof Error&&/^(invalid|unknown|request|payload)/i.test(error.message))return jsonResponse({ok:false,code:'invalid-request'},400);
   return jsonResponse({ok:false,code:'temporarily-unavailable'},503);
  }
 }
}

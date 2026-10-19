import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {canonical} from '../../packages/library-jobs/src/data';
import {validateProfile,profileDigest} from '../../packages/worker-runtime/src/index';
import {loadOperatorConfig,operatorBinding,captureOperatorCredentials,assertOperatorCredentials,type OperatorConfig} from './operator-config';
import {AuthorityTransport} from './transport';
import {readJsonFile,withPrivateState,exact,need,id,uint,digest,PilotError} from './private-state';
type Action='quota'|'enroll'|'profile';
interface Operation {identity:string;action:Action;request:Record<string,unknown>;body:unknown;epoch:number;phase:'pending'|'applied'|'blocked'}
interface State {version:1;binding:string;operations:Operation[]}
const sha=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
function requestFor(action:Action,input:unknown,config:Readonly<OperatorConfig>){
 if(action==='quota'){exact(input,['key','principal','maxActive','allowedClass']);id(input.key);need(input.principal===config.submitterPrincipal&&input.allowedClass==='general','pilot-quota-scope');uint(input.maxActive,1,8);return {key:input.key,principal:input.principal,maxActive:input.maxActive,allowedClass:'general'};}
 if(action==='profile'){exact(input,['key','workerId','revision','profile']);id(input.key);id(input.workerId);uint(input.revision,1);const p=validateProfile(input.profile,[input.profile?.image]);need(p.cpu===1&&[64,128].includes(p.ramMib),'pilot-profile-scope');return {key:input.key,workerId:input.workerId,revision:input.revision,profile:p};}
 exact(input,['key','workerId','principal','workerClass','cpu','ramMib','devices','tokenSha256','expiresAt','expectedRevision','incarnation']);id(input.key);id(input.workerId);id(input.principal);digest(input.tokenSha256);uint(input.expiresAt,1);uint(input.expectedRevision);uint(input.incarnation);uint(input.cpu,0,2);uint(input.ramMib,0,512);need(Array.isArray(input.devices)&&input.devices.length===0,'pilot-cpu-only');need(input.workerClass==='edge'?input.cpu===0&&input.ramMib===0:input.workerClass==='general'&&input.cpu>=1&&input.ramMib>=64,'pilot-enrollment-scope');return JSON.parse(canonical(input)) as Record<string,unknown>;
}
function envelope(action:Action,request:Record<string,unknown>,epoch:number){
 const key=String(request.key);return action==='quota'?{expectedEpoch:epoch,command:{key,operation:'setQuota',body:{principal:request.principal,maxActive:request.maxActive,allowedClass:'general'}}}:action==='profile'?{expectedEpoch:epoch,request:{workerId:request.workerId,revision:request.revision,profile:request.profile}}:{expectedEpoch:epoch,request};
}
function validateOperations(state:State,config:Readonly<OperatorConfig>){
 const seen=new Set<string>();for(const op of state.operations){
  exact(op,['identity','action','request','body','epoch','phase']);need(['quota','enroll','profile'].includes(op.action),'pilot-owner-state-action',409);uint(op.epoch,1);need(['pending','applied','blocked'].includes(op.phase),'pilot-owner-state-phase',409);
  const request=requestFor(op.action,op.request,config),identity=sha({action:op.action,key:String(request.key)});need(op.identity===identity&&!seen.has(identity),'pilot-owner-state-identity',409);seen.add(identity);
  need(canonical(op.request)===canonical(request)&&canonical(op.body)===canonical(envelope(op.action,request,op.epoch)),'pilot-owner-state-envelope',409);
 }
}
/** Explicit owner-only namespace mutations. Not exposed by the browser bridge. */
export async function ownerOperation(config:Readonly<OperatorConfig>,action:Action,input:unknown,approved:boolean,signal?:AbortSignal){
 need(approved===true&&config.actionsEnabled,'pilot-owner-operation-gated',403);need(['quota','enroll','profile'].includes(action),'pilot-owner-action-forbidden',403);const credentials=captureOperatorCredentials(config),request=requestFor(action,input,config) as Record<string,unknown>,transport=new AuthorityTransport(config),{epoch}=await transport.status(config.ownerCredentialReference,signal,credentials.owner);
 const key=String(request.key),identity=sha({action,key}),binding=operatorBinding(config,credentials);
 return withPrivateState<State,unknown>(config.stateRoot,'owner-operations',async journal=>{
  let state=await journal.load();assertOperatorCredentials(config,credentials);if(state===null)state={version:1,binding,operations:[]};exact(state,['version','binding','operations']);need(state.version===1&&state.binding===binding&&Array.isArray(state.operations)&&state.operations.length<=32,'pilot-owner-state-binding',409);
  validateOperations(state,config);let op=state.operations.find(x=>x.identity===identity);if(op){need(canonical(op.request)===canonical(request)&&op.action===action,'pilot-owner-request-conflict',409);if(op.phase==='applied')return {state:'applied',action,replayed:true};need(op.phase==='pending'&&op.epoch===epoch,'pilot-owner-operation-blocked',409);}
  else{need(state.operations.length<32,'pilot-owner-journal-capacity',507);const body=envelope(action,request,epoch);op={identity,action,request,body,epoch,phase:'pending'};state.operations.push(op);await journal.save(state);}
  const path=action==='quota'?'/v1/commands':action==='profile'?'/v1/enrollment/profile':'/v1/enrollment/enroll';assertOperatorCredentials(config,credentials);const reply=await transport.request(config.ownerCredentialReference,path,envelope(action,request,op.epoch),65536,false,signal,credentials.owner) as any;
  assertOperatorCredentials(config,credentials);if(reply?.ok!==true){op.phase='blocked';await journal.save(state);throw new PilotError('pilot-owner-operation-rejected',409);}
  if(action==='profile')need(reply.profileHash===profileDigest(request.profile as any),'pilot-profile-reply-binding',409);
  if(action==='enroll')need(reply.status?.workerId===request.workerId&&reply.status?.principal===request.principal&&reply.status?.incarnation===request.incarnation&&reply.status?.revision===Number(request.expectedRevision)+1&&reply.isCurrent===true,'pilot-enrollment-reply-binding',409);
  op.phase='applied';await journal.save(state);assertOperatorCredentials(config,credentials);return {state:'applied',action,replayed:false};
 });
}
export async function main(args=process.argv.slice(2)){
 need(args.length===7&&args[0]==='--config'&&args[2]==='--action'&&args[4]==='--request-file'&&args[6]==='--owner-approved-operation','pilot-owner-cli-gated',403);
 const action=args[3];need(['quota','enroll','profile'].includes(action),'pilot-owner-action-forbidden',403);const config=await loadOperatorConfig(args[1]),input=await readJsonFile(args[5],16384,true),abort=new AbortController();const stop=()=>abort.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{const reply=await ownerOperation(config,action as Action,input,true,abort.signal);process.stdout.write(JSON.stringify(reply)+'\n');}finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void main().catch(()=>{process.stderr.write('pilot-owner-operation-failed\n');process.exitCode=1;});

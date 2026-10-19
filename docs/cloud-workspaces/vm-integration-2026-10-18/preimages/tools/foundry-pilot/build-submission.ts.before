import {createHash} from 'node:crypto';
import {canonical} from '../../packages/library-jobs/src/data';
import {withPrivateState,exact,id,digest,need,PilotError} from './private-state';
import {operatorBinding,captureOperatorCredentials,assertOperatorCredentials,type OperatorConfig} from './operator-config';
import type {AuthorityTransport} from './transport';
interface Intent {requestId:string;jobId:string;epoch:number;selection:string;body:{id:string;projectId:string;inputHash:string;profileHash:string;maxAttempts:number};key:string;phase:'pending'|'submitted'|'acknowledged';aliases:string[]}
interface State {version:1;binding:string;intents:Intent[]}
const sha=(x:unknown)=>createHash('sha256').update(canonical(x)).digest('hex');
function binding(c:Readonly<OperatorConfig>,credentials:ReturnType<typeof captureOperatorCredentials>){return sha({domain:'build-operator/v1',operator:operatorBinding(c,credentials),enabled:c.buildActionsEnabled===true,profiles:c.allowedBuildProfileHashes??[]});}
function validate(state:State|null,b:string):State {if(state===null)return {version:1,binding:b,intents:[]};exact(state,['version','binding','intents']);need(state.version===1&&state.binding===b&&Array.isArray(state.intents)&&state.intents.length<=64,'build-journal-binding',409);const ids=new Set();for(const i of state.intents){exact(i,['requestId','jobId','epoch','selection','body','key','phase','aliases']);id(i.requestId);id(i.jobId);digest(i.selection);digest(i.key);need(!ids.has(i.requestId)&&['pending','submitted','acknowledged'].includes(i.phase),'build-journal-corrupt',409);ids.add(i.requestId);need(Array.isArray(i.aliases)&&i.aliases.length>0&&i.aliases.length<=64&&i.aliases[0]===i.requestId&&new Set(i.aliases).size===i.aliases.length,'build-journal-aliases',409);for(const a of i.aliases){id(a);if(a!==i.requestId){need(!ids.has(a),'build-journal-alias-conflict',409);ids.add(a);}}need(Number.isSafeInteger(i.epoch)&&i.epoch>0&&i.body?.id===i.jobId&&i.body.maxAttempts===1&&i.selection===sha({projectId:i.body.projectId,inputHash:i.body.inputHash,profileHash:i.body.profileHash}),'build-journal-corrupt',409);need(i.key===sha({binding:b,requestId:i.requestId,jobId:i.jobId,epoch:i.epoch,body:i.body}),'build-journal-key-binding',409);}return state;}
/** Durable pending intent precedes dispatch. A lost response/reloaded page recovers
 * the unacknowledged selection rather than creating a second job. */
export async function submitBuild(c:Readonly<OperatorConfig>,transport:AuthorityTransport,input:unknown,signal?:AbortSignal){
 exact(input,['requestId','jobId','projectId','inputHash','profileHash','repeat']);need(typeof input.repeat==='boolean','build-repeat-policy',400);id(input.requestId);id(input.jobId);id(input.projectId);digest(input.inputHash);digest(input.profileHash);need(c.buildActionsEnabled===true&&c.allowedBuildProfileHashes?.includes(input.profileHash),'build-actions-gated',403);
 const credentials=captureOperatorCredentials(c),b=binding(c,credentials),{epoch}=await transport.status(c.ownerCredentialReference,signal,credentials.owner);
 return withPrivateState<State,unknown>(c.stateRoot,'build-submissions',async journal=>{
  const state=validate(await journal.load(),b);assertOperatorCredentials(c,credentials);
  const selection=sha({projectId:input.projectId,inputHash:input.inputHash,profileHash:input.profileHash});
  const sameRequest=state.intents.find(i=>i.aliases.includes(input.requestId));need(!sameRequest||sameRequest.selection===selection,'build-request-conflict',409);
  let intent=sameRequest??[...state.intents].reverse().find(i=>i.selection===selection&&(!input.repeat||i.phase!=='acknowledged'));const replayed=!!intent;
  if(!intent){need(state.intents.length<64,'build-intent-capacity',507);const body={id:input.jobId,projectId:input.projectId,inputHash:input.inputHash,profileHash:input.profileHash,maxAttempts:1};intent={requestId:input.requestId,jobId:input.jobId,epoch,selection,body,key:sha({binding:b,requestId:input.requestId,jobId:input.jobId,epoch,body}),phase:'pending',aliases:[input.requestId]};state.intents.push(intent);await journal.save(state);}
  need(intent.epoch===epoch,'build-pending-epoch-changed',409);
  if(!intent.aliases.includes(input.requestId)){need(intent.aliases.length<64,'build-recovery-alias-capacity',507);intent.aliases.push(input.requestId);await journal.save(state);}
  if(intent.phase==='pending'){
   let reply:any;try{reply=await transport.request(c.ownerCredentialReference,'/v1/builds/commands',{expectedEpoch:intent.epoch,command:{operation:'submit',key:intent.key,body:intent.body}},65536,false,signal,credentials.owner);}catch{throw new PilotError('build-submit-uncertain-recover-same-selection',503);}
   assertOperatorCredentials(c,credentials);need(reply?.ok===true,'build-submit-rejected',409);intent.phase='submitted';await journal.save(state);
  }
  return {ok:true,jobId:intent.jobId,requestId:intent.requestId,replayed,ackRequired:intent.phase!=='acknowledged'};
 });
}
export async function acknowledgeBuild(c:Readonly<OperatorConfig>,input:unknown){exact(input,['requestId','jobId']);id(input.requestId);id(input.jobId);const credentials=captureOperatorCredentials(c),b=binding(c,credentials);return withPrivateState<State,unknown>(c.stateRoot,'build-submissions',async journal=>{const state=validate(await journal.load(),b);assertOperatorCredentials(c,credentials);const i=state.intents.find(i=>i.requestId===input.requestId&&i.jobId===input.jobId);need(i&&i.phase!=='pending','build-ack-not-submitted',409);if(i.phase!=='acknowledged'){i.phase='acknowledged';await journal.save(state);}return {ok:true,jobId:i.jobId};});}

import {createHash} from 'node:crypto';
import {canonical} from '../../packages/library-jobs/src/data';
import {AuthorityTransport} from './transport';
import {withPrivateState,exact,id,uint,need,PilotError} from './private-state';
import {operatorBinding,captureOperatorCredentials,assertOperatorCredentials,type OperatorConfig} from './operator-config';
import {preparePilotJob} from './pilot-job';
interface Intent {requestId:string;workloadId:string;key:string;expectedEpoch:number;body:Record<string,unknown>;phase:'pending'|'submitted'|'rejected';code:string|null}
interface State {version:1;binding:string;intents:Intent[]}
const sha=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
export async function submitPilot(config:Readonly<OperatorConfig>,transport:AuthorityTransport,input:unknown,signal?:AbortSignal){
 need(config.actionsEnabled,'pilot-actions-gated',403);exact(input,['requestId','workloadId']);id(input.requestId);id(input.workloadId);
 const credentials=captureOperatorCredentials(config),binding=operatorBinding(config,credentials);const body=await preparePilotJob(config,input.workloadId);assertOperatorCredentials(config,credentials);const {epoch}=await transport.status(config.ownerCredentialReference,signal,credentials.owner);
 return withPrivateState<State,unknown>(config.stateRoot,'operator-submissions',async journal=>{
  let state=await journal.load();assertOperatorCredentials(config,credentials);if(state===null)state={version:1,binding,intents:[]};
  exact(state,['version','binding','intents']);need(state.version===1&&state.binding===binding&&Array.isArray(state.intents)&&state.intents.length<=8,'pilot-state-binding',409);
  const workloadIds=new Set<string>(),requestIds=new Set<string>();for(const i of state.intents){exact(i,['requestId','workloadId','key','expectedEpoch','body','phase','code']);id(i.requestId);id(i.workloadId);id(i.key);need(config.allowedWorkloadIds.includes(i.workloadId)&&!workloadIds.has(i.workloadId)&&!requestIds.has(i.requestId),'pilot-state-intent-identity',409);workloadIds.add(i.workloadId);requestIds.add(i.requestId);need(i.key===sha({domain:'pilot-submit/v1',binding:state.binding,workloadId:i.workloadId}),'pilot-state-key-binding',409);uint(i.expectedEpoch,1);need(['pending','submitted','rejected'].includes(i.phase)&&(i.phase==='rejected'?i.code==='authority-rejected':i.code===null),'pilot-state-corrupt',409);}
  need(!state.intents.some(i=>i.requestId===input.requestId&&i.workloadId!==input.workloadId),'pilot-request-id-conflict',409);
  let intent=state.intents.find(i=>i.workloadId===input.workloadId),replayed=!!intent;
  if(intent){need(canonical(intent.body)===canonical(body),'pilot-pending-input-changed',409);if(intent.phase==='submitted')return {version:1,state:'submitted',workloadId:intent.workloadId,requestId:input.requestId,replayed:true};need(intent.phase!=='rejected','pilot-submission-blocked',409);need(intent.expectedEpoch===epoch,'pilot-pending-epoch-changed',409);}
  else{need(state.intents.length<8,'pilot-submission-capacity',507);intent={requestId:input.requestId,workloadId:input.workloadId,key:sha({domain:'pilot-submit/v1',binding:state.binding,workloadId:input.workloadId}),expectedEpoch:epoch,body,phase:'pending',code:null};state.intents.push(intent);await journal.save(state);}
  const command={expectedEpoch:intent.expectedEpoch,command:{key:intent.key,operation:'submit',body:intent.body}};
  assertOperatorCredentials(config,credentials);let reply:any;try{reply=await transport.request(config.submitterCredentialReference,'/v1/commands',command,70000,false,signal,credentials.submitter);}catch{throw new PilotError('pilot-submit-uncertain',503);}
  assertOperatorCredentials(config,credentials);if(reply?.ok!==true){intent.phase='rejected';intent.code='authority-rejected';await journal.save(state);throw new PilotError('pilot-submit-rejected',409);}
  const w=reply.workload,b=intent.body as any;need(w&&w.id===intent.workloadId&&w.principal===config.submitterPrincipal&&w.specification===b.specification&&w.expected_hash===b.policy.sha256&&w.max_bytes===b.policy.maxBytes&&w.cpu===b.resources.cpu&&w.ram_mib===b.resources.ramMib,'pilot-submit-reply-binding',409);
  intent.phase='submitted';await journal.save(state);assertOperatorCredentials(config,credentials);return {version:1,state:'submitted',workloadId:intent.workloadId,requestId:input.requestId,replayed};
 });
}

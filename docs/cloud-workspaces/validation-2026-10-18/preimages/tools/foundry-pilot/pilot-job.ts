import {createHash} from 'node:crypto';
import {canonical} from '../../packages/library-jobs/src/data';
import {planEventJob,type JobScope,type EventJobPolicy} from '../../packages/epoch-jobs/src/index';
import type {InboxEvent} from '../../packages/epoch-inbox/src/index';
import {exact,need,id,uint,digest,readJsonFile} from './private-state';
import type {OperatorConfig} from './operator-config';
export interface PilotInput {version:1;kind:'synthetic-pilot-input';scope:Omit<JobScope,'workloadId'>;eventId:string;event:InboxEvent;eligibilityGeneration:number;policy:EventJobPolicy}
/** Hash pins canonical JSON, explicitly not a claim that the synthetic event occurred on-chain. */
export async function preparePilotJob(config:Readonly<OperatorConfig>,workloadId:string){
 id(workloadId);need(config.allowedWorkloadIds.includes(workloadId),'pilot-workload-out-of-scope',403);
 const input=await readJsonFile(config.inputFile,65536,false) as PilotInput;exact(input,['version','kind','scope','eventId','event','eligibilityGeneration','policy']);
 need(input.version===1&&input.kind==='synthetic-pilot-input','pilot-input-kind');digest(config.inputSha256);
 need(createHash('sha256').update(canonical(input)).digest('hex')===config.inputSha256,'pilot-input-pin-mismatch',409);
 need(input.scope?.environment===config.environment,'pilot-input-environment',409);need(input.scope.authorityId===config.inputAuthorityId,'pilot-input-source-authority',409);uint(input.eligibilityGeneration,1);
 const plan=planEventJob({...input.scope,workloadId},input.eventId,input.event,input.eligibilityGeneration,input.policy);
 need(plan.submitBody.resources.cpu===1&&[64,128].includes(plan.submitBody.resources.ramMib)&&plan.submitBody.policy.maxBytes<=4096,'pilot-input-profile');
 return plan.submitBody;
}

export function pilotProvenance(config:Readonly<OperatorConfig>){return {kind:'synthetic-pilot-input' as const,actualChainObservation:false as const,inputSha256:config.inputSha256,inputAuthorityId:config.inputAuthorityId,template:'epoch-event-summary-v1' as const};}

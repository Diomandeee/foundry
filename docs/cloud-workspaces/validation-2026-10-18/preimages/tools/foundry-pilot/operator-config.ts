import {isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {canonical,freeze} from '../../packages/library-jobs/src/data';
import {exact,id,uint,digest,need,readJsonFile,credential} from './private-state';
export interface OperatorConfig {
 buildActionsEnabled?:boolean;allowedBuildProfileHashes?:string[];
 version:1;origin:string;environment:string;authorityId:string;sourceMode:'local-authority'|'remote-authority';
 port:number;operatorCredentialReference:string;ownerCredentialReference:string;submitterCredentialReference:string;submitterPrincipal:string;verifierPrincipal:string;inputAuthorityId:string;
 stateRoot:string;inputFile:string;inputSha256:string;allowedWorkloadIds:string[];actionsEnabled:boolean;
}
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
export function validateOperatorConfig(input:unknown):Readonly<OperatorConfig>{
 const c=JSON.parse(canonical(input)) as OperatorConfig;
 const extras=['buildActionsEnabled','allowedBuildProfileHashes'].filter(k=>Object.hasOwn(c,k));
 exact(c,['version','origin','environment','authorityId','sourceMode','port','operatorCredentialReference','ownerCredentialReference','submitterCredentialReference','submitterPrincipal','verifierPrincipal','inputAuthorityId','stateRoot','inputFile','inputSha256','allowedWorkloadIds','actionsEnabled',...extras]);need(c.version===1,'pilot-config-version');
 const u=new URL(c.origin);need(u.protocol==='https:'&&u.pathname==='/'&&!u.username&&!u.password&&!u.search&&!u.hash&&c.origin===u.origin,'pilot-config-origin');
 id(c.environment);id(c.authorityId);id(c.submitterPrincipal);id(c.verifierPrincipal);id(c.inputAuthorityId);need(c.submitterPrincipal!==c.verifierPrincipal,'pilot-verifier-must-be-separate');uint(c.port,1024,65535);
 for(const r of [c.operatorCredentialReference,c.ownerCredentialReference,c.submitterCredentialReference])need(typeof r==='string'&&/^[A-Z][A-Z0-9_]{0,95}(?![\s\S])/.test(r),'pilot-config-credential-reference');
 need(c.operatorCredentialReference!==c.ownerCredentialReference&&c.operatorCredentialReference!==c.submitterCredentialReference&&c.ownerCredentialReference!==c.submitterCredentialReference,'pilot-operator-credential-must-be-separate');
 need(c.sourceMode==='local-authority'||c.sourceMode==='remote-authority','pilot-config-source');need(typeof c.actionsEnabled==='boolean','pilot-config-activation');
 need(typeof c.stateRoot==='string'&&isAbsolute(c.stateRoot)&&typeof c.inputFile==='string'&&isAbsolute(c.inputFile),'pilot-config-path');digest(c.inputSha256);
 need(Array.isArray(c.allowedWorkloadIds)&&c.allowedWorkloadIds.length>0&&c.allowedWorkloadIds.length<=8,'pilot-config-workload-scope');c.allowedWorkloadIds.forEach(id);need(new Set(c.allowedWorkloadIds).size===c.allowedWorkloadIds.length,'pilot-config-duplicate-workload');
 need(c.buildActionsEnabled===undefined||typeof c.buildActionsEnabled==='boolean','build-config-actions');
 need(c.allowedBuildProfileHashes===undefined||(Array.isArray(c.allowedBuildProfileHashes)&&c.allowedBuildProfileHashes.length<=64),'build-profile-list');c.allowedBuildProfileHashes?.forEach(digest);need(!c.buildActionsEnabled||!!c.allowedBuildProfileHashes?.length,'build-profile-scope');
 return freeze(c);
}
export async function loadOperatorConfig(file:string){return validateOperatorConfig(await readJsonFile(file));}
/** Private credential snapshots never enter a browser reply or log. */
export interface OperatorCredentials {readonly owner:string;readonly submitter:string}
export function captureOperatorCredentials(c:Readonly<OperatorConfig>):OperatorCredentials {
 const values=Object.freeze({owner:credential(c.ownerCredentialReference),submitter:credential(c.submitterCredentialReference)});
 need(values.owner!==values.submitter,'pilot-authority-credentials-must-be-separate');return values;
}
export function assertOperatorCredentials(c:Readonly<OperatorConfig>,values:OperatorCredentials):void {
 need(credential(c.ownerCredentialReference)===values.owner&&credential(c.submitterCredentialReference)===values.submitter,'pilot-credential-binding-changed',409);
}
export function operatorBinding(c:Readonly<OperatorConfig>,values:OperatorCredentials):string{return sha(canonical({origin:c.origin,environment:c.environment,authorityId:c.authorityId,owner:c.ownerCredentialReference,submitter:c.submitterCredentialReference,ownerFingerprint:sha(values.owner),submitterFingerprint:sha(values.submitter),principal:c.submitterPrincipal,verifier:c.verifierPrincipal,inputAuthorityId:c.inputAuthorityId,inputFile:c.inputFile,inputSha256:c.inputSha256,allowedWorkloadIds:c.allowedWorkloadIds}));}

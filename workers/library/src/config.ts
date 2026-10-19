import {createHash} from 'node:crypto';
import {HttpFailure,exact} from '../../compute/src/http';

export interface ProjectPolicy {
 projectId:string; policyVersion:string; ownerPrincipal:string; writerPrincipal:string; verifierPrincipal:string;
}
export interface LibraryEnvironment {
 LIBRARY_ENVIRONMENT:string;
 LIBRARY_AUTHORITY_NAME:string;
 LIBRARY_PROJECTS?:string;
 LIBRARY_AUTH_CONFIG?:string;
 LIBRARY_TRANSPORT_ENABLED?:string;
 LIBRARY_CATALOG?:DurableObjectNamespace;
}
const identifier=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?![\s\S])/;
export function validId(value:unknown):value is string{return typeof value==='string'&&identifier.test(value);}
/** Entire allowlist is validated; request fields cannot construct a new project or policy. */
export function projects(env:LibraryEnvironment):ProjectPolicy[]{
 try{
  if(!validId(env.LIBRARY_ENVIRONMENT)||!validId(env.LIBRARY_AUTHORITY_NAME)||typeof env.LIBRARY_PROJECTS!=='string'||env.LIBRARY_PROJECTS.length>65536)throw 0;
  const list:unknown=JSON.parse(env.LIBRARY_PROJECTS);
  if(!Array.isArray(list)||list.length<1||list.length>100)throw 0;
  const seen=new Set<string>();
  for(const item of list){
   exact(item,['projectId','policyVersion','ownerPrincipal','writerPrincipal','verifierPrincipal']);
   if(!Object.values(item).every(validId)||seen.has(item.projectId)||new Set([item.ownerPrincipal,item.writerPrincipal,item.verifierPrincipal]).size!==3)throw 0;
   seen.add(item.projectId);
  }
  return list as ProjectPolicy[];
 }catch{throw new HttpFailure(503,'library-unconfigured');}
}
export function route(request:Request):{projectId:string;action:'commands'|'snapshot'|'revocations'|'export'|'restore'|'recovery-status'|'reconcile-recovery'}{
 const url=new URL(request.url);
 if(url.protocol!=='https:')throw new HttpFailure(400,'https-required');
 if(url.search)throw new HttpFailure(400,'query-forbidden');
 if(request.method!=='POST')throw new HttpFailure(405,'post-required');
 const match=/^\/v1\/library\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/(commands|snapshot|revocations|export|restore|recovery-status|reconcile-recovery)$/.exec(url.pathname);
 if(!match)throw new HttpFailure(404,'not-found');
 return {projectId:match[1],action:match[2] as 'commands'|'snapshot'|'revocations'|'export'|'restore'|'recovery-status'|'reconcile-recovery'};
}
export function policyDigest(env:LibraryEnvironment,policy:ProjectPolicy):string{
 return createHash('sha256').update(JSON.stringify([env.LIBRARY_ENVIRONMENT,env.LIBRARY_AUTHORITY_NAME,policy.projectId,policy.policyVersion,policy.ownerPrincipal,policy.writerPrincipal,policy.verifierPrincipal])).digest('hex');
}

/** Distinguish a broken host auth map from an invalid caller bearer. Empty maps revoke all callers. */
export function authConfigured(env:LibraryEnvironment):void{
 try{
  if(typeof env.LIBRARY_AUTH_CONFIG!=='string'||env.LIBRARY_AUTH_CONFIG.length>65536)throw 0;
  const list:unknown=JSON.parse(env.LIBRARY_AUTH_CONFIG);
  if(!Array.isArray(list)||list.length>256)throw 0;
  const seen=new Set<string>(),roles=['owner','executor','verifier','projector','submitter'];
  for(const item of list){
   exact(item,['tokenSha256','principal','role','environment']);
   if(typeof item.tokenSha256!=='string'||!/^[a-f0-9]{64}(?![\s\S])/.test(item.tokenSha256)||!validId(item.principal)||!validId(item.environment)||!roles.includes(item.role)||seen.has(item.tokenSha256))throw 0;
   seen.add(item.tokenSha256);
  }
 }catch{throw new HttpFailure(503,'library-unconfigured');}
}

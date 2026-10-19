import {HttpFailure,jsonResponse} from '../../compute/src/http';
import {authenticate} from '../../compute/src/transport-auth';
import {projects,route,authConfigured,type LibraryEnvironment} from './config';
export {LibraryAuthority} from './authority';
/** Fixed host allowlist. There is no project auto-enrollment route. */
export default {
 async fetch(request:Request,env:LibraryEnvironment):Promise<Response>{
  if(env.LIBRARY_TRANSPORT_ENABLED!=='true')return jsonResponse({ok:false,code:'library-transport-disabled'},503);
  try{
   const target=route(request);
   const policy=projects(env).find(p=>p.projectId===target.projectId);
   if(!policy)throw new HttpFailure(404,'project-not-configured');
   authConfigured(env);
   let actor;
   try{actor=authenticate(request,env.LIBRARY_AUTH_CONFIG??'',env.LIBRARY_ENVIRONMENT);}catch{throw new HttpFailure(401,'unauthorized');}
   const expected=actor.role==='owner'?policy.ownerPrincipal:actor.role==='submitter'?policy.writerPrincipal:actor.role==='verifier'?policy.verifierPrincipal:undefined;
   if(!expected||expected!==actor.principal)throw new HttpFailure(403,'project-permission');
   if(!env.LIBRARY_CATALOG)throw new HttpFailure(503,'library-unconfigured');
   const name=`${env.LIBRARY_ENVIRONMENT}:${env.LIBRARY_AUTHORITY_NAME}:${policy.projectId}`;
   return await env.LIBRARY_CATALOG.get(env.LIBRARY_CATALOG.idFromName(name)).fetch(request);
  }catch(error){
   if(error instanceof HttpFailure)return jsonResponse({ok:false,code:error.code},error.status);
   return jsonResponse({ok:false,code:'temporarily-unavailable'},503);
  }
 }
};

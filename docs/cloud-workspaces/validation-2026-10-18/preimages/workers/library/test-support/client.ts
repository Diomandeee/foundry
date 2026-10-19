import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Miniflare} from 'miniflare';
import {libraryRuntime} from './runtime';
export const token=(name:string)=>`fixture-only-library-${name}-000000000000000000000`;
const auth=['owner','writer','verifier','foreign','owner-b','writer-b','verifier-b','executor','wrongenv'].map(name=>({tokenSha256:createHash('sha256').update(token(name)).digest('hex'),principal:name,role:name.startsWith('owner')?'owner':name.startsWith('verifier')?'verifier':name==='executor'?'executor':'submitter',environment:name==='wrongenv'?'other':'library-local'}));
export const policies=['a','b'].map(suffix=>({projectId:`project-${suffix}`,policyVersion:'v1',ownerPrincipal:suffix==='a'?'owner':`owner-${suffix}`,writerPrincipal:suffix==='a'?'writer':`writer-${suffix}`,verifierPrincipal:suffix==='a'?'verifier':`verifier-${suffix}`}));
const fixture=`
 import entry from './workers/library/src/index.ts';
 import {LibraryAuthority} from './workers/library/src/authority.ts';
 import {canonical,sha256} from './packages/library-jobs/src/data.ts';
 const base={LIBRARY_ENVIRONMENT:'library-local',LIBRARY_AUTHORITY_NAME:'catalog',LIBRARY_TRANSPORT_ENABLED:'true',LIBRARY_PROJECTS:${JSON.stringify(JSON.stringify(policies))},LIBRARY_AUTH_CONFIG:${JSON.stringify(JSON.stringify(auth))}};
 export class TestLibrary extends LibraryAuthority{
  constructor(ctx,env){
   const config={...env,...base},clock={now:1000000},fault={enabled:false},recoveryGate={release:null};
   const state={id:ctx.id,storage:{sql:{exec:(query,...args)=>{let rows;try{rows=ctx.storage.sql.exec(query,...args);}catch(error){fault.sqlError={query:query.slice(0,160),message:String(error.message).slice(0,200)};throw error;}if(fault.guard&&query.startsWith('INSERT INTO library_restore_guard')){fault.guard=false;throw new Error('fixture post-guard fault');}if(fault.enabled&&/^INSERT/i.test(query)){fault.enabled=false;throw new Error('fixture transaction fault');}return rows;}},transactionSync:fn=>ctx.storage.transactionSync(fn)}};
   super(state,config,{now:()=>clock.now,reconcileRecovery:async challenge=>{if(config.FIXTURE_HOLD_RECOVERY)await new Promise(resolve=>{recoveryGate.release=resolve;});if(!config.FIXTURE_RECOVERY_PIN)throw new Error('fixture independent checkpoint absent');return {approval:{version:1,authorityId:'fixture-checkpoint',revision:1,restoreId:challenge.restoreId,archiveSha256:challenge.archiveSha256,challengeSha256:sha256(canonical(challenge)),issuedAt:clock.now,expiresAt:clock.now+1000,permitId:'a'.repeat(64)},restoreId:challenge.restoreId,approvedArchiveSha256:config.FIXTURE_RECOVERY_PIN,observedAt:clock.now,checks:challenge.checks.map(x=>({...x,valid:config.FIXTURE_INVALID!==true,sourceHead:10,relayCursor:10}))};}});this.config=config;this.clock=clock;this.testFault=fault;this.releases=new Map();this.recoveryGate=recoveryGate;
  }
  async fetch(request){
   const path=new URL(request.url).pathname;
   // Fixture-only controls: never exported by the production entry point.
   if(path==='/__test/guard-fault'){this.testFault.guard=true;return Response.json({ok:true});}
   if(path==='/__test/recovery-held')return Response.json({held:!!this.recoveryGate.release});
   if(path==='/__test/recovery-release'){this.recoveryGate.release?.();this.recoveryGate.release=null;return Response.json({ok:true});}
   if(path==='/__test/sql-error')return Response.json(this.testFault.sqlError??{});
   if(path==='/__test/direct'){const input=await request.json();return super.fetch(new Request('https://local'+input.path,{method:'POST',headers:request.headers,body:JSON.stringify(input.body)}));}
   if(path==='/__test/config'){const input=await request.json();this.config[input.key]=input.value;return Response.json({ok:true});}
   if(path==='/__test/auth-revoke'){this.config.LIBRARY_AUTH_CONFIG='[]';return Response.json({ok:true});}
   if(path==='/__test/clock'){this.clock.now=(await request.json()).now;return Response.json({ok:true});}
   if(path==='/__test/held')return Response.json({held:this.releases.size>0,count:this.releases.size});
   if(path==='/__test/release'){for(const release of this.releases.values())release();this.releases.clear();return Response.json({ok:true});}
   if(path==='/__test/slow'){
    const input=await request.json(),self=this,id=input.id??'only';
    const stream=new ReadableStream({start(c){self.releases.set(id,()=>{c.enqueue(new TextEncoder().encode(input.raw?input.body:JSON.stringify(input.body)));c.close();});}});
    try{return await super.fetch(new Request('https://local'+input.path,{method:'POST',headers:request.headers,body:stream}));}finally{self.releases.delete(id);}
   }
   if(path==='/__test/fault'){this.testFault.enabled=true;return Response.json({ok:true});}
   return super.fetch(request);
  }
 }
 export default {fetch(request,env){
  const path=new URL(request.url).pathname;
  if(path.startsWith('/__test/')){
   if(path==='/__test/disabled')return entry.fetch(new Request('https://local/v1/library/project-a/snapshot',{method:'POST',headers:request.headers,body:'{}'}),{...env,...base,LIBRARY_TRANSPORT_ENABLED:'false'});
   const id=env.LIBRARY_CATALOG.idFromName('library-local:catalog:project-a');
   return env.LIBRARY_CATALOG.get(id).fetch(request);
  }
  return entry.fetch(request,{...env,...base});
 }};
`;
export class LibraryClient{
 private runtime!:Miniflare;private serial=0;
 private constructor(readonly directory:string){}
 static async create(){const client=new LibraryClient(await mkdtemp(join(tmpdir(),'foundry-library-')));await client.start();return client;}
 private async start(projectPolicies=policies){this.runtime=await libraryRuntime(fixture.replace(JSON.stringify(JSON.stringify(policies)),JSON.stringify(JSON.stringify(projectPolicies))),this.directory);}
 async restart(projectPolicies=policies){await this.runtime.dispose();await this.start(projectPolicies);}
 async dispose(){await this.runtime.dispose();await rm(this.directory,{recursive:true,force:true});}
 async request(path:string,body:unknown,identity='owner',extra:Record<string,string>={}){
  const response=await this.runtime.dispatchFetch(`https://local.test${path}`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token(identity)}`,...extra},body:JSON.stringify(body)});
  return {status:response.status,body:await response.json() as any};
 }
 async reconcile(pin:string,invalid=false){await this.request('/__test/config',{key:'FIXTURE_RECOVERY_PIN',value:pin});await this.request('/__test/config',{key:'FIXTURE_INVALID',value:invalid});return this.request('/v1/library/project-a/reconcile-recovery',{});}
 async restore(archive:string,pin:string,identity='owner',media='application/vnd.foundry.catalog-recovery+json'){
  const response=await this.runtime.dispatchFetch('https://local.test/v1/library/project-a/restore',{method:'POST',headers:{'content-type':media,authorization:`Bearer ${token(identity)}`,'x-catalog-archive-sha256':pin},body:archive});
  return {status:response.status,body:await response.json() as any};
 }
 command(operation:string,body:unknown,identity='owner',key=`command-${++this.serial}`,project='project-a'){return this.request(`/v1/library/${project}/commands`,{operation,key,body},identity);}
 snapshot(project='project-a',identity='owner'){return this.request(`/v1/library/${project}/snapshot`,{},identity);}
}
export async function withLibrary(run:(h:LibraryClient)=>Promise<void>){const h=await LibraryClient.create();try{await run(h);}finally{await h.dispose();}}

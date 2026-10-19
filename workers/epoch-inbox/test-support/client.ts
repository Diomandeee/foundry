import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Miniflare} from 'miniflare';
import {inboxRuntime} from './runtime';
const token=(name:string)=>`fixture-only-epoch-${name}-bearer-000000000000000000000`;
const config=['owner','observer','foreign','projector','wrongenv'].map(name=>({tokenSha256:createHash('sha256').update(token(name)).digest('hex'),principal:name,role:['observer','foreign','wrongenv'].includes(name)?'submitter':name,environment:name==='wrongenv'?'foreign-environment':'epoch-local'}));
const fixture=`
 import entry from './workers/epoch-inbox/src/index.ts';
 import {EpochInboxAuthority} from './workers/epoch-inbox/src/authority.ts';
 const config={EPOCH_ENVIRONMENT:'epoch-local',EPOCH_AUTHORITY_NAME:'fixed',EPOCH_TRANSPORT_ENABLED:'true',EPOCH_AUTH_CONFIG:${JSON.stringify(JSON.stringify(config))}};
 export class TestEpochInbox extends EpochInboxAuthority{
  constructor(ctx,env){
   const fault={enabled:false};
   const state={id:ctx.id,storage:{sql:{exec:(query,...args)=>{const result=ctx.storage.sql.exec(query,...args);if(fault.enabled&&/INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO\\s+\\w*outbox\\b/i.test(query)){fault.enabled=false;throw new Error('injected local inbox outbox fault');}return result;}},transactionSync:fn=>ctx.storage.transactionSync(fn)}};
   super(state,{...env,...config});this.testFault=fault;this.testState=ctx;
  }
  async fetch(request){
   if(new URL(request.url).pathname==='/__test/fill-commands'){
    const n=this.testState.storage.sql.exec('SELECT count(*) n FROM epoch_inbox_commands').one().n;
    this.testState.storage.transactionSync(()=>this.testState.storage.sql.exec("WITH RECURSIVE numbers(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM numbers WHERE i<?) INSERT INTO epoch_inbox_commands(principal,role,key,request,response) SELECT 'fixture-capacity','observer','fill-'||i,'{}','{}' FROM numbers",20000-n));
    return Response.json({ok:true});
   }
   if(new URL(request.url).pathname==='/__test/fill-conflicts'){
    const id=this.testState.storage.sql.exec('SELECT event_id FROM epoch_inbox_events ORDER BY rowid LIMIT 1').one().event_id;
    this.testState.storage.transactionSync(()=>this.testState.storage.sql.exec("WITH RECURSIVE numbers(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM numbers WHERE i<1000) INSERT INTO epoch_inbox_conflicts(event_id,content) SELECT ?,json_object('fixture',i) FROM numbers",id));
    return Response.json({ok:true});
   }
   if(new URL(request.url).pathname==='/__test/immutability'){
    const denied=[];
    for(const table of ['meta','sources','events','conflicts','audit','outbox','commands']){
     try{this.testState.storage.transactionSync(()=>this.testState.storage.sql.exec('INSERT OR REPLACE INTO epoch_inbox_'+table+' SELECT * FROM epoch_inbox_'+table+' LIMIT 1'));denied.push(false);}catch{denied.push(true);}
    }
    return Response.json({denied});
   }
   if(new URL(request.url).pathname==='/__test/fault'){this.testFault.enabled=true;return Response.json({ok:true});}
   return super.fetch(request);
  }
 }
 export default {fetch(request,env){if(new URL(request.url).pathname==='/__test/disabled')return entry.fetch(request,{...env,...config,EPOCH_TRANSPORT_ENABLED:'false'});return entry.fetch(request,{...env,...config});}};
`;
export class InboxClient{
 private runtime!:Miniflare;
 private serial=0;
 private constructor(readonly directory:string){}
 static async create(){const h=new InboxClient(await mkdtemp(join(tmpdir(),'foundry-epoch-inbox-')));await h.start();return h;}
 private async start(){this.runtime=await inboxRuntime(fixture,this.directory);}
 async restart(){await this.runtime.dispose();await this.start();}
 async dispose(){await this.runtime.dispose();await rm(this.directory,{recursive:true,force:true});}
 async request(path:string,body:unknown,identity='owner',extra:Record<string,string>={}){
  const response=await this.runtime.dispatchFetch(`https://local.test${path}`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token(identity)}`,...extra},body:JSON.stringify(body)});
  return {status:response.status,body:await response.json() as any};
 }
 command(operation:string,body:unknown,identity='owner',key=`test-${++this.serial}`){return this.request('/v1/epoch/commands',{operation,body,key},identity);}
 snapshot(){return this.request('/v1/epoch/snapshot',{});}
}
export const event=(index=0,payload:unknown={kind:'fixture-observation',value:1})=>({network:'fixture-network',blockHeight:10,blockHash:'a'.repeat(64),parentHash:'b'.repeat(64),transactionId:'c'.repeat(64),eventIndex:index,payload});
export const ingestBody=(index=0,expectedCursor=index,payload?:unknown)=>({sourceId:'source-a',expectedCursor,event:event(index,payload)});
export async function withInbox(run:(h:InboxClient)=>Promise<void>){const h=await InboxClient.create();try{await run(h);}finally{await h.dispose();}}
export async function register(h:InboxClient){const r=await h.command('registerSource',{sourceId:'source-a',network:'fixture-network',observerPrincipal:'observer'});if(!r.body.ok)throw new Error(JSON.stringify(r));return r;}

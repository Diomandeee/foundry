import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
export const token=(role:string)=>'invented-fixture-only-'+role+'-000000000000000000000000';
export const contract='SP000000000000000000002Q6VF78.example';
export const options={chain:{environment:'local',authorityId:'pipeline',sourceId:'hiro',network:'stacks-mainnet',observerPrincipal:'submitter',policy:{version:'anchor-v1'}},coordinatorPrincipal:'pipeline-internal',jobPolicy:{environment:'local',authorityId:'pipeline',sourceId:'hiro',network:'stacks-mainnet',profile:'hiro-nakamoto-contract-log/v1',allowedContracts:[contract],ramMib:64,maxOutputBytes:4096}};
const config=JSON.stringify(['owner','submitter','projector','executor','verifier','other'].map(role=>({tokenSha256:createHash('sha256').update(token(role)).digest('hex'),principal:role,role:role==='other'?'submitter':role,environment:'local'})));
const script=`
import pipelineEntry from './workers/epoch-pipeline/src/index.ts';
import {EpochPipelineAuthority} from './workers/epoch-pipeline/src/authority.ts';
import computeEntry from './workers/compute/src/index.ts';
import {ComputeAuthority} from './workers/compute/src/authority.ts';
import {executeEventSummary} from './packages/epoch-jobs/src/index.ts';
const computeConfig={COMPUTE_ENVIRONMENT:'local',COMPUTE_ISSUER_ID:'fixture',COMPUTE_ISSUER_KEY:'invented-local-fixture-issuer-0000000000000000000000',COMPUTE_TRANSPORT_ENABLED:'true',COMPUTE_AUTHORITY_NAME:'compute',COMPUTE_AUTH_CONFIG:${JSON.stringify(config)}};
const pipelineConfig={EPOCH_ENVIRONMENT:'local',EPOCH_AUTHORITY_NAME:'pipeline',EPOCH_TRANSPORT_ENABLED:'true',EPOCH_AUTH_CONFIG:${JSON.stringify(config)},EPOCH_PIPELINE_CONFIG:${JSON.stringify(JSON.stringify(options))},COMPUTE_TARGET:'https://compute.invalid',COMPUTE_OWNER_BEARER:${JSON.stringify(token('owner'))},COMPUTE_SUBMITTER_BEARER:${JSON.stringify(token('submitter'))},COMPUTE_SUBMITTER_PRINCIPAL:'submitter'};
export class LocalCompute extends ComputeAuthority {constructor(ctx,env){super(ctx,{...env,...computeConfig});}}
export class LocalPipeline {
 constructor(ctx,env){
  this.ctx=ctx;this.fault=false;this.pause=false;this.lost=false;this.waiters=[];this.claimFault=false;this.retryFault=false;this.responseFault=false;this.ackFault=false;this.planFault=false;this.epochRace=false;this.statusFailure=0;
  const state={id:ctx.id,storage:{sql:{exec:(q,...b)=>{const rows=ctx.storage.sql.exec(q,...b);if(this.planFault&&q.startsWith('SELECT frozen FROM epoch_pipeline_plans')){this.planFault=false;throw new Error('fixture plan read fault');}if(this.responseFault&&q.startsWith('UPDATE epoch_chain_intents')&&b[0]==='acked'&&String(b[b.length-1]).endsWith(':submit')){this.responseFault=false;throw new Error('fixture submission response storage fault');}if(this.ackFault&&q.startsWith('UPDATE epoch_chain_intents')&&b[0]==='acked'&&String(b[b.length-1]).includes(':cancel')){this.ackFault=false;throw new Error('fixture cancellation ack storage fault');}if(this.retryFault&&q.startsWith('UPDATE epoch_chain_intents')&&b[0]==='pending'){this.retryFault=false;throw new Error('fixture retry storage fault');}if(this.claimFault&&q.startsWith('UPDATE epoch_chain_intents')&&b[0]==='leased'){this.claimFault=false;throw new Error('fixture claim storage fault');}if(this.fault&&q.startsWith('INSERT INTO epoch_chain_events')){this.fault=false;throw new Error('fixture projection fault');}return rows;}},transactionSync:fn=>ctx.storage.transactionSync(fn)}};
  this.bindings={...env,...pipelineConfig,FOUNDRY:{fetch:async request=>{
   if(request.url.endsWith('/v1/commands')&&this.epochRace){this.epochRace=false;await computeEntry.fetch(new Request('https://compute.invalid/v1/commands',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+pipelineConfig.COMPUTE_OWNER_BEARER},body:JSON.stringify({expectedEpoch:1,command:{operation:'bumpEpoch',key:'race-bump',body:{expectedEpoch:1}}})}),{...env,...computeConfig});}
   if(request.url.endsWith('/v1/status')&&this.statusFailure)return Response.json({ok:false,code:'fixture-denial'},{status:this.statusFailure});
   let submit=false;
   if(request.url.endsWith('/v1/commands'))submit=(await request.clone().json()).command.operation==='submit';
   if(submit&&this.pause){this.waiting=true;await new Promise(resolve=>this.waiters.push(resolve));this.waiting=false;}
   const result=await computeEntry.fetch(request,{...env,...computeConfig});
   if(submit&&this.lost){this.lost=false;throw new Error('fixture lost response');}
   return result;
  }}};
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS fixture_clock (id INTEGER PRIMARY KEY CHECK(id=1),now INTEGER NOT NULL)');
  ctx.storage.sql.exec('INSERT OR IGNORE INTO fixture_clock VALUES(1,1000000)');
  this.core=new EpochPipelineAuthority(state,this.bindings,{now:()=>Number(ctx.storage.sql.exec('SELECT now FROM fixture_clock WHERE id=1').one().now)});
 }
 async fetch(request){
  if(new URL(request.url).pathname==='/fixture/config'){
   const b=await request.json();if(b.advanceClockMs)this.ctx.storage.sql.exec('UPDATE fixture_clock SET now=now+? WHERE id=1',b.advanceClockMs);if(b.fault)this.fault=true;if(b.lost)this.lost=true;if(b.pause!==undefined)this.pause=b.pause;if(b.release){this.pause=false;for(const release of this.waiters.splice(0))release();}if(b.responseFault)this.responseFault=true;if(b.ackFault)this.ackFault=true;if(b.planFault)this.planFault=true;if(b.retryFault)this.retryFault=true;if(b.expireLease)this.ctx.storage.transactionSync(()=>this.ctx.storage.sql.exec('UPDATE epoch_chain_intents SET lease_until=0'));if(b.cancelAttempts100)this.ctx.storage.transactionSync(()=>this.ctx.storage.sql.exec("UPDATE epoch_chain_intents SET attempts=100 WHERE kind='CANCEL'"));if(b.advanceBackoff)this.ctx.storage.transactionSync(()=>this.ctx.storage.sql.exec('UPDATE epoch_pipeline_delivery SET retry_at=0'));if(b.statusFailure!==undefined)this.statusFailure=b.statusFailure;if(b.claimFault)this.claimFault=true;if(b.epochRace)this.epochRace=true;
   return Response.json({waiting:!!this.waiting});
  }
  return this.core.fetch(request);
 }
}
export default {async fetch(request,env){
 const path=new URL(request.url).pathname;
 if(path==='/fixture/handler'){const b=await request.json();return new Response(executeEventSummary(b.specification));}
 if(path.startsWith('/v1/pipeline/')||path==='/fixture/config')return pipelineEntry.fetch(request,{...env,...pipelineConfig});
 return computeEntry.fetch(request,{...env,...computeConfig});
}};
`;
export async function runtime(persistence:string){
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
 const bundle=await build({stdin:{contents:script,resolveDir:root,sourcefile:'epoch-local-fixture.ts',loader:'ts'},bundle:true,write:false,format:'esm',platform:'neutral',target:'es2022',external:['node:*','cloudflare:*'],logLevel:'silent'});
 const config=convertV4MiniflareOptions({name:'epoch-local-integration',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-05',compatibilityFlags:['nodejs_compat'],durableObjects:{EPOCH_PIPELINE:{className:'LocalPipeline',useSQLite:true},AUTHORITY:{className:'LocalCompute',useSQLite:true}},logRequests:false});
 for(const worker of config.workers)worker.dev={...worker.dev,unsafeRegisterWorker:false};
 return new Miniflare({...config,resourcePersistencePath:persistence,telemetry:{enabled:false}});
}

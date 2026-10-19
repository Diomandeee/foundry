import { describe,it,expect } from 'vitest';
import { createHash } from 'node:crypto';
import { localRuntime } from '../../../workers/compute/test-support/runtime';
import { mkdir, mkdtemp, lstat, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { boundedStep, type HostConfig, type HostPorts, type JournalState, type HostJournal } from './index';
import { NodeHostJournal } from './node';
import { validateProfile, profileDigest, type RunResult } from '../../worker-runtime/src/index';
import { planEventJob, EVENT_PROFILE, executeEventSummary } from '../../epoch-jobs/src/index';
import { canonical } from '../../epoch-jobs/src/canonical';
const image=`local/vetted@sha256:${'a'.repeat(64)}`;
function fixture() {
  const scope={environment:'local',authorityId:'chain',sourceId:'hiro',network:'stacks-testnet' as const};
  const contract='ST000000000000000000002AMW42H.epoch';
  const event={network:scope.network,blockHeight:12,blockHash:'a'.repeat(64),parentHash:'c'.repeat(64),transactionId:'f'.repeat(64),eventIndex:0,payload:{schema:EVENT_PROFILE,contractId:contract,topic:'print',value:{hex:'0x0102',repr:'private'},block:{id:'a'.repeat(64),hash:'b'.repeat(64),parentId:'c'.repeat(64),parentHash:'d'.repeat(64),height:12,burnHash:'e'.repeat(64),burnHeight:5,tenureHeight:3}}};
  const job=planEventJob({...scope,workloadId:'approved'},canonical([scope.sourceId,event.network,event.blockHash,event.transactionId,0]),event,1,{...scope,profile:EVENT_PROFILE,allowedContracts:[contract],ramMib:128,maxOutputBytes:4096});
  const config: HostConfig={origin:'https://foundry.example',credentialReference:'host-vault-ref',environment:'local',authorityId:'chain',identity:{workerId:'mac',principal:'executor',workerClass:'general',cpu:1,ramMib:128,devices:[]},expectedEpoch:1,revision:1,incarnation:0,stepKey:'step-1',profile:validateProfile({image,cpu:1,ramMib:128,pids:16,tmpMib:4,maxOutputBytes:4096,timeoutMs:100},[image]),ttlMs:60000,httpDeadlineMs:10000};
  const work={ok:true,kind:'work',profileHash:profileDigest(config.profile),workload:{id:'approved',specification:job.submitBody.specification,resources:{cpu:1,ramMib:128},expectedHash:job.expectedOutputHash,maxBytes:4096},lease:{id:'lease-1',worker_id:'mac',workload_id:'approved',epoch:1,generation:0,incarnation:0,capability:'lease-secret',expires_ms:Date.now()+60000,state:'RUNNING'}};
  let state: JournalState|null=null; let runs=0; let busy=false;
  const journal: HostJournal={exclusive:async fn=>{if(busy)throw Error('busy');busy=true;try{return await fn({load:async()=>structuredClone(state),save:async s=>{state=structuredClone(s);}});}finally{busy=false;}}};
  const calls: {path:string;body:any}[]=[]; let statusCalls=0;
  let lose=''; let malformed=false; let outcome:RunResult['outcome']='completed'; let stopped=true;
  const ports: HostPorts={journal,credential:async()=> 'host-secret',runtime:{runBoundedJob:async plan=>{runs++;return {outcome,output:executeEventSummary(plan.specification),stop:{identity:plan.identity,containerId:'b'.repeat(64),stopped,reason:stopped?'inspect-stopped':'unknown'}};}},fetch:async (url,init)=>{
    expect(init?.redirect).toBe('error');expect((init?.headers as any).authorization).toBe('Bearer host-secret');
    const path=new URL(String(url)).pathname,body=JSON.parse(String(init?.body));
    if(path==='/v1/worker/status'){statusCalls++;return Response.json({ok:true,environment:config.environment,authorityId:config.authorityId,epoch:config.expectedEpoch});}
    calls.push({path,body});
    expect(state).not.toBeNull();
    const lost=lose===path; if(lost)lose='';
    const respond=(value:unknown)=>{if(lost)throw Error('Bearer host-secret lease-secret');return Response.json(value);};
    if(malformed)return Response.json({ok:true,kind:'work',lease:{capability:'secret'}});
    if(path.endsWith('heartbeat'))return respond({ok:true,status:{...config.identity,identity:config.identity,revision:1,incarnation:0,sequence:body.request.sequence,freshness:'fresh',revokedAt:null,lastSeen:ports.now?.() ?? Date.now(),expiresAt:(ports.now?.() ?? Date.now())+60000}});
    if(path.endsWith('poll'))return respond(work);
    return respond({ok:true,artifact:{sha256:work.workload.expectedHash,bytes:executeEventSummary(work.workload.specification).length,reference:'sealed-ref'}});
  }};
  return {config,ports,work,calls,get statusCalls(){return statusCalls;},get state(){return state;},set state(s){state=s;},get runs(){return runs;},set lose(s:string){lose=s;},set malformed(v:boolean){malformed=v;},set outcome(v:RunResult['outcome']){outcome=v;},set stopped(v:boolean){stopped=v;}};
}
describe('bounded host step',()=>{
  it.each(['environment','authorityId','epoch','ok'])('blocks mismatched worker authority %s before heartbeat',async field=>{
    const f=fixture();f.ports.fetch=async(url)=>{expect(new URL(url).pathname).toBe('/v1/worker/status');return Response.json({ok:true,environment:f.config.environment,authorityId:f.config.authorityId,epoch:1,[field]:field==='epoch'?2:field==='ok'?false:'wrong'});};
    expect((await boundedStep(f.config,f.ports)).kind).toBe('blocked');expect(f.runs).toBe(0);expect(f.calls).toHaveLength(0);
  });
  it('uploads actual pure-handler bytes with sealed endpoint, redacted summary and terminal replay',async()=>{
    const f=fixture();expect(await boundedStep(f.config,f.ports)).toEqual({kind:'uploaded'});
    expect(f.statusCalls).toBe(3);expect(f.runs).toBe(1);expect(f.calls[2]!.body.bytesBase64).toBe(Buffer.from(executeEventSummary(f.work.workload.specification)).toString('base64'));
    expect(f.calls[2]!.body.fence.capability).toBe('lease-secret');expect(f.state?.stop?.stopped).toBe(true);
    expect(await boundedStep(f.config,f.ports)).toEqual({kind:'uploaded'});expect(f.calls.length).toBe(3);expect(f.statusCalls).toBe(3);
  });
  it.each(['/v1/enrollment/heartbeat','/v1/worker/poll','/v1/artifacts'])('restarts after response loss at %s with exact replay',async path=>{
    const f=fixture();f.lose=path;expect((await boundedStep(f.config,f.ports)).kind).toBe('retry');
    expect((await boundedStep(f.config,{...f.ports})).kind).toBe('uploaded');
    const replay=f.calls.filter(c=>c.path===path);expect(replay).toHaveLength(2);expect(replay[0]).toEqual(replay[1]);expect(f.runs).toBe(1);
  });
  it('persists independent next poll sequence only after terminal head; duplicate lease never reruns',async()=>{
    const f=fixture();await boundedStep(f.config,f.ports);f.config.stepKey='step-2';
    expect((await boundedStep(f.config,f.ports)).kind).toBe('blocked');
    expect(f.calls.filter(c=>c.path.endsWith('poll')).map(c=>c.body.request.sequence)).toEqual([1,2]);expect(f.runs).toBe(1);
  });
  it.each([{cpu:0.5,ramMib:128},{cpu:2,ramMib:128},{cpu:1,ramMib:64},{cpu:1,ramMib:256}])('rejects allocation mismatch %j before runtime',async resources=>{
    const f=fixture();f.work.workload.resources=resources;
    expect((await boundedStep(f.config,f.ports)).kind).toBe('blocked');expect(f.runs).toBe(0);expect(f.calls).toHaveLength(2);
  });
  it('does not advance a pending poll when given a new step identity',async()=>{
    const f=fixture();f.lose='/v1/worker/poll';await boundedStep(f.config,f.ports);f.config.stepKey='step-2';
    expect((await boundedStep(f.config,f.ports)).kind).toBe('blocked');expect(f.calls).toHaveLength(2);expect(f.state?.pollSequence).toBe(1);
  });
  it('wrong result hash and bytes over workload policy cannot upload',async()=>{
    for(const mode of ['hash','size']){const f=fixture();if(mode==='size')f.work.workload.maxBytes=1;
      else f.ports.runtime.runBoundedJob=async plan=>({outcome:'completed',output:Buffer.from('wrong'),stop:{identity:plan.identity,containerId:'b'.repeat(64),stopped:true,reason:'inspect-stopped'}});
      expect((await boundedStep(f.config,f.ports)).kind).toBe('blocked');expect(f.calls).toHaveLength(2);
    }
  });
  it('cancel during execution preserves unknown stop and never uploads',async()=>{
    const f=fixture(),a=new AbortController();f.ports.runtime.runBoundedJob=async plan=>{a.abort();return {outcome:'interrupted',output:new Uint8Array(),stop:{identity:plan.identity,containerId:null,stopped:false,reason:'unknown'}};};
    expect((await boundedStep(f.config,f.ports,a.signal)).kind).toBe('blocked');expect(f.calls).toHaveLength(2);expect(f.state?.stop?.stopped).toBe(false);
  });
  it('idle steps advance heartbeat and poll heads independently after handling each response',async()=>{
    const f=fixture();(f.work as any).kind='idle';
    expect(await boundedStep(f.config,f.ports)).toEqual({kind:'idle'});
    expect(await boundedStep(f.config,f.ports)).toEqual({kind:'idle'});expect(f.calls).toHaveLength(2);
    f.config.stepKey='step-2';expect(await boundedStep(f.config,f.ports)).toEqual({kind:'idle'});
    expect(f.calls.filter(c=>c.path.endsWith('poll')).map(c=>c.body.request.sequence)).toEqual([1,2]);expect(f.runs).toBe(0);
  });
  it('heartbeat wrong revision/incarnation never reaches poll',async()=>{
    for(const field of ['revision','incarnation']){const f=fixture();f.config[field as 'revision'|'incarnation']=9;expect((await boundedStep(f.config,f.ports)).kind).toBe('blocked');expect(f.calls).toHaveLength(1);}
  });
  it('serializes concurrent invocations before side effects',async()=>{
    const f=fixture();const results=await Promise.all([boundedStep(f.config,f.ports),boundedStep(f.config,f.ports)]);
    expect(results.map(r=>r.kind).sort()).toEqual(['blocked','uploaded']);expect(f.runs).toBe(1);
  });
  it('edge only heartbeats',async()=>{const f=fixture();f.config.identity.workerClass='edge';f.config.identity.cpu=0;f.config.identity.ramMib=0;expect((await boundedStep(f.config,f.ports)).kind).toBe('heartbeat');expect(f.calls).toHaveLength(1);expect(f.runs).toBe(0);});
  it.each(['worker_id','incarnation','workload_id','epoch'])('rejects wrong lease %s',async field=>{
    const f=fixture();(f.work.lease as any)[field]=field.includes('id')?'other':9;expect((await boundedStep(f.config,f.ports)).kind).toBe('blocked');expect(f.runs).toBe(0);
  });
  it.each(['interrupted','failed','rejected'] as const)('does not upload %s; keeps stop evidence',async outcome=>{const f=fixture();f.outcome=outcome;expect((await boundedStep(f.config,f.ports)).kind).toBe('blocked');expect(f.calls).toHaveLength(2);expect(f.state?.stop).toBeDefined();});
  it('unknown stop never uploads',async()=>{const f=fixture();f.stopped=false;expect((await boundedStep(f.config,f.ports)).kind).toBe('blocked');expect(f.state?.stop?.stopped).toBe(false);expect(f.calls).toHaveLength(2);});
  it('ambiguous runtime exception/restart never reruns',async()=>{
    const f=fixture();f.ports.runtime.runBoundedJob=async()=>{throw Error('host-secret');};
    expect((await boundedStep(f.config,f.ports)).kind).toBe('blocked');expect((await boundedStep(f.config,f.ports)).kind).toBe('blocked');expect(f.calls).toHaveLength(2);
  });
  it('crash marker blocks a fresh instance before any HTTP or runtime',async()=>{
    const f=fixture();f.lose='/v1/worker/poll';await boundedStep(f.config,f.ports);f.state={...f.state!,phase:'running'};
    expect(await boundedStep(f.config,f.ports)).toEqual({kind:'blocked',code:'ambiguous-execution'});expect(f.runs).toBe(0);expect(f.calls).toHaveLength(2);
  });
  it('redacts malformed responses and exceptions',async()=>{const f=fixture();f.malformed=true;const r=await boundedStep(f.config,f.ports);expect(r.kind).toBe('blocked');expect(JSON.stringify(r)).not.toContain('secret');expect(f.runs).toBe(0);});
  it('deadline bounds noncooperative fetch; aborted request does not run',async()=>{const f=fixture();f.config.httpDeadlineMs=5;f.ports.fetch=async()=>new Promise(()=>{});expect((await boundedStep(f.config,f.ports)).kind).toBe('retry');const a=new AbortController();a.abort();expect((await boundedStep(f.config,f.ports,a.signal)).kind).toBe('retry');expect(f.runs).toBe(0);});
  it('stream bound rejects oversized and hanging HTTP bodies',async()=>{const f=fixture();f.ports.fetch=async()=>new Response(new Uint8Array(65537),{headers:{'content-type':'application/json'}});expect((await boundedStep(f.config,f.ports)).kind).toBe('retry');f.config.httpDeadlineMs=5;f.ports.fetch=async()=>new Response(new ReadableStream({start(){}}),{headers:{'content-type':'application/json'}});expect((await boundedStep(f.config,f.ports)).kind).toBe('retry');});
  it('journal failure prevents side effects and binding changes fail closed',async()=>{const f=fixture();f.ports.journal={exclusive:async fn=>fn({load:async()=>null,save:async()=>{throw Error('secret');}})};expect((await boundedStep(f.config,f.ports)).kind).toBe('blocked');expect(f.calls).toHaveLength(0);});
});
describe('private durable Node journal',()=>{
  it('persists across adapters; private atomic state, locking and corrupt state fail closed',async()=>{
    const base=resolve('packages/worker-client/.test-data');await mkdir(base,{recursive:true,mode:0o700});const root=await mkdtemp(join(base,'journal-'));
    try{
      const f=fixture();f.ports.journal=new NodeHostJournal(root);f.lose='/v1/artifacts';
      // Fake transport's state assertion is specific to memory port; mirror writes into it.
      const fetch=f.ports.fetch;f.ports.fetch=async(u,i)=>{f.state=JSON.parse(await readFile(join(root,'state.json'),'utf8'));return fetch(u,i);};
      expect((await boundedStep(f.config,f.ports)).kind).toBe('retry');f.ports.journal=new NodeHostJournal(root);
      expect((await boundedStep(f.config,f.ports)).kind).toBe('uploaded');expect(f.runs).toBe(1);
      expect((await lstat(join(root,'state.json'))).mode & 0o077).toBe(0);
      await mkdir(join(root,'step.lock'));expect((await boundedStep(f.config,f.ports)).kind).toBe('blocked');await rm(join(root,'step.lock'),{recursive:true});
      await writeFile(join(root,'state.json'),'broken');expect((await boundedStep(f.config,f.ports)).kind).toBe('blocked');
    }finally{await rm(root,{recursive:true,force:true});await rm(base,{recursive:true,force:true});}
  });
});

describe('recovery regressions',()=>{
  it('normalizes field order and devices through pending heartbeat restart',async()=>{
    const f=fixture();f.config.identity.devices=[{id:'z',kind:'cuda',vramMib:16},{id:'a',kind:'metal',vramMib:8}];
    f.lose='/v1/enrollment/heartbeat';expect((await boundedStep(f.config,f.ports)).kind).toBe('retry');
    f.config.identity={devices:[{vramMib:8,kind:'metal',id:'a'},{vramMib:16,kind:'cuda',id:'z'}],ramMib:128,cpu:1,workerClass:'general',principal:'executor',workerId:'mac'};
    expect((await boundedStep(f.config,f.ports)).kind).toBe('uploaded');
    const beats=f.calls.filter(c=>c.path.endsWith('heartbeat'));expect(beats[0]!.body).toEqual(beats[1]!.body);
    expect(beats[0]!.body.request.observedIdentity.devices.map((d:any)=>d.id)).toEqual(['a','z']);
  });
  it.each(['/v1/worker/poll','/v1/artifacts'])('refreshes heartbeat before replaying pending %s, keeping its identity',async path=>{
    const f=fixture();let now=Date.now();f.ports.now=()=>now;f.lose=path;
    expect((await boundedStep(f.config,f.ports)).kind).toBe('retry');const pending=structuredClone(f.calls.find(c=>c.path===path));
    now+=2000;expect((await boundedStep(f.config,f.ports)).kind).toBe('uploaded');
    expect(f.calls.filter(c=>c.path===path)).toEqual([pending,pending]);expect(f.calls.filter(c=>c.path.endsWith('heartbeat')).map(c=>c.body.request.sequence)).toEqual([1,2]);expect(f.runs).toBe(1);
  });
  it.each([{status:401,code:'unauthorized'},{status:409,code:'stale-epoch'},{status:409,code:'sequence-conflict'},{status:403,code:'Bearer host-secret lease-secret'}])('blocks permanent HTTP $status/$code and retains prepared keys',async error=>{
    const f=fixture();f.lose='/v1/worker/poll';await boundedStep(f.config,f.ports);const keys=structuredClone(f.state!.keys),seq=f.state!.pollSequence;
    f.ports.fetch=async()=>Response.json({ok:false,code:error.code,message:'secret'},{status:error.status});
    const expectedCode=error.code.includes('secret')?'http-403':error.code;
    expect(await boundedStep(f.config,f.ports)).toEqual({kind:'blocked',code:expectedCode,httpStatus:error.status});
    expect(f.state!.keys).toEqual(keys);expect(f.state!.pollSequence).toBe(seq);expect(f.runs).toBe(0);
  });
  it('503 retries exact pending poll; heartbeat-stale forces an independent refresh',async()=>{
    const f=fixture();let now=Date.now();f.ports.now=()=>now;f.lose='/v1/worker/poll';await boundedStep(f.config,f.ports);
    const fetch=f.ports.fetch,keys=structuredClone(f.state!.keys);f.ports.fetch=async()=>Response.json({ok:false,code:'temporarily-unavailable'},{status:503});
    expect(await boundedStep(f.config,f.ports)).toEqual({kind:'retry',code:'temporarily-unavailable',httpStatus:503});expect(f.state!.keys).toEqual(keys);
    f.ports.fetch=async()=>Response.json({ok:false,code:'heartbeat-stale'},{status:409});expect((await boundedStep(f.config,f.ports)).kind).toBe('retry');
    now+=1001;f.ports.fetch=fetch;expect((await boundedStep(f.config,f.ports)).kind).toBe('uploaded');expect(f.state!.keys.poll).toBe(keys.poll);expect(f.state!.pollSequence).toBe(1);
  });
});

describe('real authority heartbeat replay after freshness expiry',()=>{
  it.each(['heartbeat','poll'])('recovers real authority response loss at %s after freshness expiry',async loss=>{
    const f=fixture();let now=1000000;f.ports.now=()=>now;f.config.httpDeadlineMs=10000;f.config.identity.principal='mac';
    const token=(role:string)=>`worker-client-local-fixture-${role}-00000000000000000000`;
    const digest=(role:string)=>createHash('sha256').update(token(role)).digest('hex');
    const auth=[{tokenSha256:digest('owner'),role:'owner',principal:'owner',environment:'client-test'}];
    const script=`
      import entry from './workers/compute/src/index.ts';
      import {ComputeAuthority} from './workers/compute/src/authority.ts';
      let clock=1000000;Date.now=()=>clock;
      const config={COMPUTE_ENVIRONMENT:'client-test',COMPUTE_ISSUER_ID:'fixture',COMPUTE_ISSUER_KEY:'worker-client-fixture-only-issuer-key-0000000000000000',COMPUTE_AUTHORITY_NAME:'client',COMPUTE_AUTH_CONFIG:${JSON.stringify(JSON.stringify(auth))},COMPUTE_TRANSPORT_ENABLED:'true',COMPUTE_ENROLLMENT_ENABLED:'true'};
      export class TestFabricAuthority extends ComputeAuthority{
        constructor(ctx,env){super(ctx,{...env,...config});}
        async fetch(r){if(new URL(r.url).pathname==='/__clock'){clock=(await r.json()).now;return Response.json({ok:true});}return super.fetch(r);}
      }
      export default{fetch(r,env){return entry.fetch(r,{...env,...config});}};
    `;
    const base=resolve('packages/worker-client/.authority-test-data');await mkdir(base,{recursive:true,mode:0o700});const dir=await mkdtemp(join(base,'authority-'));
    const runtime=await localRuntime(script,dir,'worker-client-recovery');
    try{
      const call=async(path:string,body:unknown,role='owner')=>runtime.dispatchFetch(f.config.origin+path,{method:'POST',headers:{authorization:`Bearer ${token(role)}`,'content-type':'application/json'},body:JSON.stringify(body)});
      const enrolled=await call('/v1/enrollment/enroll',{expectedEpoch:1,request:{...f.config.identity,key:'enroll',tokenSha256:digest('mac'),expiresAt:10000000,expectedRevision:0,incarnation:0}});
      expect(enrolled.status).toBe(200);expect((await enrolled.json() as any).ok).toBe(true);
      const actual=await (await call('/v1/status',{})).json() as any;
      f.config.environment=actual.environment;f.config.authorityId=actual.authorityId;f.config.expectedEpoch=actual.epoch;
      let lost=true;const requests:{path:string;body:any}[]=[];
      f.ports.credential=async()=>token('mac');
      f.ports.fetch=async(url,init)=>{
        const path=new URL(url).pathname;requests.push({path,body:JSON.parse(init.body)});
        const response=await runtime.dispatchFetch(url,{method:init.method,headers:init.headers,body:init.body,redirect:init.redirect});
        // Real authority has committed the heartbeat; lose only the response.
        const result=await response.json();
        if(path.endsWith(loss) && lost){lost=false;throw Error('fixture-response-loss');}
        return Response.json(result,{status:response.status});
      };
      expect((await boundedStep(f.config,f.ports)).kind).toBe('retry');
      now+=61000;await call('/__clock',{now});
      expect(await boundedStep(f.config,{...f.ports})).toEqual({kind:'idle'});
      const beats=requests.filter(r=>r.path.endsWith('heartbeat'));
      expect(beats.map(r=>r.body.request.sequence)).toEqual(loss==='heartbeat'?[1,1,2]:[1,2]);
      if(loss==='heartbeat'){expect(beats[0]).toEqual(beats[1]);expect(beats[1]!.body.request.key).not.toBe(beats[2]!.body.request.key);}
      const polls=requests.filter(r=>r.path.endsWith('poll'));
      expect(polls.map(r=>r.body.request.sequence)).toEqual(loss==='poll'?[1,1]:[1]);
      if(loss==='poll')expect(polls[0]).toEqual(polls[1]);expect(f.runs).toBe(0);
    }finally{await runtime.dispose();await rm(dir,{recursive:true,force:true});await rm(base,{recursive:true,force:true});}
  },30000);
});

describe('authority-approved profile binding',()=>{
 it('rejects a mismatched approved profile digest before invoking the runtime',async()=>{const f=fixture();f.work.profileHash='0'.repeat(64);expect((await boundedStep(f.config,f.ports)).kind).toBe('blocked');expect(f.runs).toBe(0);expect(f.calls.some(c=>c.path.endsWith('/artifacts'))).toBe(false);});
});

describe('pre-poll lease runway',()=>{it('rejects an infeasible host TTL without HTTP, claim or execution',async()=>{const f=fixture();f.config.ttlMs=1000;expect((await boundedStep(f.config,f.ports)).kind).toBe('blocked');expect(f.calls).toHaveLength(0);expect(f.runs).toBe(0);});});

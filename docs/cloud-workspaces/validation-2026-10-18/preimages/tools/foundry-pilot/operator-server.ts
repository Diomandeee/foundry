import {submitBuild,acknowledgeBuild,listBuildIntents,recoverBuild} from './build-submission';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {canonical} from '../../packages/library-jobs/src/data';
import type {OperatorView} from '../../workers/compute/src/operator-feed';
import {loadOperatorConfig,type OperatorConfig} from './operator-config';
import {operatorSessions} from './operator-auth';
import {AuthorityTransport} from './transport';
import {submitPilot} from './submission';
import {preparePilotJob,pilotProvenance} from './pilot-job';
import {exact,id,uint,need,digest,PilotError,safeError} from './private-state';
const assets=new Map([['/',['index.html','text/html; charset=utf-8']],['/index.html',['index.html','text/html; charset=utf-8']],['/operator.css',['operator.css','text/css; charset=utf-8']],['/operator.js',['operator.js','text/javascript; charset=utf-8']],['/builds.js',['builds.js','text/javascript; charset=utf-8']]]);
const assetRoot=join(dirname(fileURLToPath(import.meta.url)),'operator');
const security={'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','x-frame-options':'DENY','content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"};
function json(res:ServerResponse,data:unknown,status=200,extra:Record<string,string>={}){const body=JSON.stringify(data);res.writeHead(status,{...security,'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(body),...extra});res.end(body);}
async function body(req:IncomingMessage,limit:number):Promise<unknown>{
 need(/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type']??'')),'operator-json-required',415);
 return new Promise((resolve,reject)=>{const chunks:Buffer[]=[];let size=0,settled=false;const finish=(error?:PilotError,value?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('error',errorEvent);req.off('aborted',errorEvent);if(error){req.pause();reject(error);}else resolve(value);};const data=(chunk:Buffer)=>{size+=chunk.byteLength;if(size>limit)return finish(new PilotError('operator-body-too-large',413));chunks.push(chunk);};const end=()=>{try{const raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks,size));const value=JSON.parse(raw);canonical(value);finish(undefined,value);}catch{finish(new PilotError('operator-invalid-json',400));}};const errorEvent=()=>finish(new PilotError('operator-body-unavailable',400));const timer=setTimeout(()=>finish(new PilotError('operator-body-timeout',408)),5000);req.on('data',data);req.on('end',end);req.on('error',errorEvent);req.on('aborted',errorEvent);});
}
function viewBinding(value:unknown,c:Readonly<OperatorConfig>,epoch:number):OperatorView{
 const v=value as OperatorView;need(v?.version===1&&v.source?.environment===c.environment&&v.source.authorityId===c.authorityId&&v.source.epoch===epoch,'operator-view-binding');uint(v.source.observedAt);uint(v.source.head);need(v.source.observedAt<=Date.now()+1000,'operator-view-clock');
 for(const key of ['workers','workloads','leases','attempts','placements','receipts'] as const)need(Array.isArray(v[key]),'operator-view-shape');need(v.events&&Array.isArray(v.events.items)&&v.windows&&typeof v.windows==='object','operator-view-shape');return v;
}
/** No service starts at import. Missing config serves an honest unconfigured static surface only. */
export function createOperatorServer(config?:Readonly<OperatorConfig>,fallbackPort=4317){
 const port=config?.port??fallbackPort;uint(port,1024,65535);const origin='http://127.0.0.1:'+port;
 const transport=config?new AuthorityTransport(config):null,sessions=config?operatorSessions(config.operatorCredentialReference,origin,[config.ownerCredentialReference,config.submitterCredentialReference]):null;
 let active=0,logins=0;
 const server=createServer(async(req,res)=>{
  try{
   need(req.headers.host==='127.0.0.1:'+port,'operator-host-forbidden',403);
   const url=new URL(req.url??'/',origin);need(url.origin===origin,'operator-origin-forbidden',403);
   const suppliedOrigin=req.headers.origin,site=req.headers['sec-fetch-site'];need(!suppliedOrigin||suppliedOrigin===origin,'operator-origin-forbidden',403);need(!site||site==='same-origin'||site==='none','operator-site-forbidden',403);
   if(req.method==='GET'&&assets.has(url.pathname)){need(!url.search,'operator-invalid-query');const [file,type]=assets.get(url.pathname)!;const bytes=await readFile(join(assetRoot,file));need(bytes.length<=524288,'operator-asset-too-large');res.writeHead(200,{...security,'content-type':type,'content-length':bytes.length});res.end(bytes);return;}
   need(url.pathname.startsWith('/api/'),'operator-not-found',404);need(active<4,'operator-busy',429);active++;
   const abort=new AbortController(),closed=()=>abort.abort();res.once('close',closed);
   try{
    need(!url.search||url.pathname==='/api/operator/view','operator-invalid-query');
    if(req.method==='GET'&&url.pathname==='/api/operator/session'){json(res,{version:1,state:!config?'unconfigured':sessions!.authenticated(req.headers.cookie)?'ready':'locked'});return;}
    if(req.method==='POST'){need(suppliedOrigin===origin,'operator-origin-required',403);}
    if(req.method==='POST'&&url.pathname==='/api/operator/session'){
     need(config&&sessions,'pilot-config-required',503);need(logins<2,'operator-login-busy',429);logins++;try{const input=await body(req,9000);exact(input,['credential']);const cookie=sessions.login(input.credential);json(res,{version:1,state:'ready'},200,{'set-cookie':cookie});}finally{logins--;}return;
    }
    if(req.method==='POST'&&url.pathname==='/api/operator/logout'){const input=await body(req,1024);exact(input,[]);json(res,{version:1,state:config?'locked':'unconfigured'},200,{'set-cookie':sessions?.clear(req.headers.cookie)??'foundry_operator=; HttpOnly; SameSite=Strict; Path=/api/; Max-Age=0'});return;}
    need(config&&transport&&sessions,'pilot-config-required',503);need(sessions.authenticated(req.headers.cookie),'operator-login-required',401);
    if(req.method==='GET'&&url.pathname==='/api/operator/view'){
     need([...url.searchParams.keys()].every(k=>k==='afterEvent')&&url.searchParams.getAll('afterEvent').length<=1,'operator-invalid-query');const value=url.searchParams.get('afterEvent')??'0';need(/^(0|[1-9][0-9]{0,15})(?![\s\S])/.test(value),'operator-invalid-cursor');const after=Number(value);uint(after);
     const requestedAt=Date.now(),{epoch}=await transport.status(config.ownerCredentialReference,abort.signal);const view=viewBinding(await transport.request(config.ownerCredentialReference,'/v1/operator',{expectedEpoch:epoch,request:{afterEvent:after,limit:64}},262144,false,abort.signal),config,epoch);
     let inputConfigured=false;try{await preparePilotJob(config,config.allowedWorkloadIds[0]);inputConfigured=true;}catch{/* No source content or config error details enter browser. */}
     need(sessions.authenticated(req.headers.cookie),'operator-login-required',401);json(res,{version:1,state:'connected',sourceMode:config.sourceMode,requestedAt,receivedAt:Date.now(),view,actions:{submitEnabled:config.actionsEnabled,inputConfigured,template:'epoch-event-summary-v1',allowedWorkloadIds:config.allowedWorkloadIds,provenance:inputConfigured?pilotProvenance(config):null}});return;
    }
    if(req.method==='GET'&&url.pathname==='/api/builds/view'){
     const {epoch}=await transport.status(config.ownerCredentialReference,abort.signal);
     const feed=await transport.request(config.ownerCredentialReference,'/v1/builds/feed',{expectedEpoch:epoch,after:0},1048576,false,abort.signal) as any;
     need(feed?.version===1&&feed.environment===config.environment&&feed.authorityId===config.authorityId&&feed.epoch===epoch,'build-feed-binding');
     need(sessions.authenticated(req.headers.cookie),'operator-login-required',401);
     json(res,{...feed,actionsEnabled:config.buildActionsEnabled===true,allowedProfiles:config.allowedBuildProfileHashes??[]});return;
    }
    if(req.method==='POST'&&['/api/builds/preview','/api/builds/submit','/api/builds/cancel'].includes(url.pathname)){
     const input=await body(req,4096);need(sessions.authenticated(req.headers.cookie),'operator-login-required',401);
     const {epoch}=await transport.status(config.ownerCredentialReference,abort.signal);
     if(url.pathname.endsWith('/preview')){
      exact(input,['profileHash','inputHash']);digest(input.profileHash);digest(input.inputHash);
      const reply=await transport.request(config.ownerCredentialReference,'/v1/builds/preview',{expectedEpoch:epoch,...input},65536,false,abort.signal);
      need(sessions.authenticated(req.headers.cookie),'operator-login-required',401);json(res,reply);return;
     }
     need(config.buildActionsEnabled===true,'build-actions-approval-required',403);
     let command:unknown;
     if(url.pathname.endsWith('/submit')){
      const reply=await submitBuild(config,transport,input,abort.signal);need(sessions.authenticated(req.headers.cookie),'operator-login-required',401);json(res,reply);return;
     }else{
      exact(input,['requestId','jobId']);id(input.requestId);id(input.jobId);
      // Cancellation is an explicit authenticated owner action, never a browser timeout.
      command={operation:'cancel',key:input.requestId,body:{jobId:input.jobId}};
     }
     const reply=await transport.request(config.ownerCredentialReference,'/v1/builds/commands',{expectedEpoch:epoch,command},65536,false,abort.signal);
     need(sessions.authenticated(req.headers.cookie),'operator-login-required',401);json(res,reply);return;
    }
    // Existing-intent recovery does not read placement or allocate a fresh job.
    // Shared session/Origin/Sec-Fetch-Site checks above protect these routes too.
    if(req.method==='GET'&&url.pathname==='/api/builds/intents'){
     const reply=await listBuildIntents(config,transport,abort.signal);
     need(sessions.authenticated(req.headers.cookie),'operator-login-required',401);json(res,reply);return;
    }
    if(req.method==='POST'&&url.pathname==='/api/builds/recover'){
     const input=await body(req,1024);need(sessions.authenticated(req.headers.cookie),'operator-login-required',401);
     const reply=await recoverBuild(config,transport,input,abort.signal);
     need(sessions.authenticated(req.headers.cookie),'operator-login-required',401);json(res,reply);return;
    }
    if(req.method==='POST'&&url.pathname==='/api/builds/ack'){const input=await body(req,1024);need(sessions.authenticated(req.headers.cookie),'operator-login-required',401);const reply=await acknowledgeBuild(config,transport,input,abort.signal);need(sessions.authenticated(req.headers.cookie),'operator-login-required',401);json(res,reply);return;}
    if(req.method==='POST'&&url.pathname==='/api/builds/result-log'){const input=await body(req,1024);exact(input,['jobId','logIndex']);id(input.jobId);uint(input.logIndex,0,63);const {epoch}=await transport.status(config.ownerCredentialReference,abort.signal);const bytes=await transport.request(config.ownerCredentialReference,'/v1/builds/result-log',{expectedEpoch:epoch,...input},1048576,true,abort.signal) as Uint8Array;need(sessions.authenticated(req.headers.cookie),'operator-login-required',401);res.writeHead(200,{...security,'content-type':'application/octet-stream','content-length':bytes.length});res.end(bytes);return;}
    if(req.method==='POST'&&url.pathname==='/api/builds/result-chunk'){const input=await body(req,1024);exact(input,['jobId','outputIndex','chunkIndex']);id(input.jobId);uint(input.outputIndex,0,63);uint(input.chunkIndex,0,127);const {epoch}=await transport.status(config.ownerCredentialReference,abort.signal);const bytes=await transport.request(config.ownerCredentialReference,'/v1/builds/result-chunk',{expectedEpoch:epoch,...input},1048576,true,abort.signal) as Uint8Array;need(sessions.authenticated(req.headers.cookie),'operator-login-required',401);res.writeHead(200,{...security,'content-type':'application/octet-stream','content-length':bytes.length});res.end(bytes);return;}
    if(req.method==='POST'&&url.pathname==='/api/builds/result'){
     const input=await body(req,1024);exact(input,['jobId']);id(input.jobId);
     const {epoch}=await transport.status(config.ownerCredentialReference,abort.signal);
     const reply=await transport.request(config.ownerCredentialReference,'/v1/builds/result',{expectedEpoch:epoch,jobId:input.jobId},1048576,false,abort.signal) as any;
     need(sessions.authenticated(req.headers.cookie),'operator-login-required',401);
     // Expose receipt/content identity only. Private broker grant identifiers stay server-side.
     const m=reply.manifest;need(reply.ok&&m?.jobId===input.jobId,'build-result-binding');
     json(res,{jobId:reply.jobId,attemptId:reply.attemptId,verifier:reply.verifier,verifiedAt:reply.verifiedAt,outputs:m.outputs.map((o:any)=>({path:o.path,format:o.format,sha256:o.sha256,bytes:o.sizeBytes,chunks:o.chunks.length})),logs:m.logs.map((o:any)=>({sha256:o.ref.sha256,bytes:o.ref.sizeBytes})),retrieval:'verified-chunks-through-scoped-server-reader'});return;
    }
    if(req.method==='POST'&&url.pathname==='/api/pilot/jobs'){const input=await body(req,1024);need(sessions.authenticated(req.headers.cookie),'operator-login-required',401);const reply=await submitPilot(config,transport,input,abort.signal);need(sessions.authenticated(req.headers.cookie),'operator-login-required',401);json(res,{...(reply as Record<string,unknown>),provenance:pilotProvenance(config)});return;}
    const match=/^\/api\/pilot\/jobs\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/result$/.exec(url.pathname);
    if(req.method==='GET'&&match){const workloadId=match[1];id(workloadId);need(config.allowedWorkloadIds.includes(workloadId),'pilot-workload-out-of-scope',403);const planned=await preparePilotJob(config,workloadId);const {epoch}=await transport.status(config.ownerCredentialReference,abort.signal);const reply=await transport.request(config.ownerCredentialReference,'/v1/operator/result',{expectedEpoch:epoch,workloadId},16384,false,abort.signal) as any;
     need(reply?.version===1&&reply.ok===true&&reply.environment===config.environment&&reply.authorityId===config.authorityId&&reply.receipt?.workloadId===workloadId,'operator-result-binding');exact(reply,['version','ok','environment','authorityId','observedAt','workload','receipt','bytesBase64']);const w=reply.workload;exact(w,['id','principal','specification','expectedHash','maxBytes','cpu','ramMib']);need(w.id===workloadId&&w.principal===config.submitterPrincipal&&w.specification===planned.specification&&w.expectedHash===planned.policy.sha256&&w.maxBytes===planned.policy.maxBytes&&w.cpu===planned.resources.cpu&&w.ramMib===planned.resources.ramMib,'operator-result-intent-binding',409);const r=reply.receipt;need(r.verifier===config.verifierPrincipal&&r.sha256===planned.policy.sha256&&r.bytes<=planned.policy.maxBytes,'operator-result-policy-binding',409);exact(r,['workloadId','leaseId','sha256','bytes','epoch','generation','incarnation','verifier','verifiedAt']);id(r.verifier);digest(r.sha256);uint(r.bytes,0,4096);id(r.leaseId);uint(r.epoch,1);uint(r.generation);uint(r.incarnation);uint(r.verifiedAt);need(typeof reply.bytesBase64==='string'&&reply.bytesBase64.length<=5464&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(reply.bytesBase64),'operator-result-encoding');const bytes=Buffer.from(reply.bytesBase64,'base64');need(bytes.toString('base64')===reply.bytesBase64&&bytes.length===r.bytes&&createHash('sha256').update(bytes).digest('hex')===r.sha256,'operator-result-integrity');const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);need(sessions.authenticated(req.headers.cookie),'operator-login-required',401);json(res,{version:1,state:'accepted',receipt:r,text,provenance:pilotProvenance(config)});return;
    }
    throw new PilotError('operator-not-found',404);
   }finally{active--;res.off('close',closed);abort.abort();}
  }catch(error){const e=safeError(error);if(!res.headersSent)json(res,{version:1,state:e.status===401?'locked':!config?'unconfigured':'unavailable',code:e.code},e.status,{'connection':'close'});else res.destroy();}
 });
 server.maxConnections=16;server.requestTimeout=5000;server.headersTimeout=5000;server.keepAliveTimeout=1000;server.maxRequestsPerSocket=64;
 return {server,port,origin};
}
export async function main(args=process.argv.slice(2)){
 let configFile:string|undefined,port=4317;for(let i=0;i<args.length;i++){if(args[i]==='--config'&&args[i+1])configFile=args[++i];else if(args[i]==='--port'&&args[i+1])port=Number(args[++i]);else throw new PilotError('operator-cli-arguments',400);}
 const config=configFile?await loadOperatorConfig(configFile):undefined,host=createOperatorServer(config,port);
 const stop=()=>host.server.close();process.once('SIGINT',stop);process.once('SIGTERM',stop);
 await new Promise<void>((resolve,reject)=>{host.server.once('error',reject);host.server.listen(host.port,'127.0.0.1',()=>{host.server.off('error',reject);resolve();});});process.stdout.write('operator-listening-loopback\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void main().catch(()=>{process.stderr.write('operator-start-failed\n');process.exitCode=1;});

import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {access,lstat,open} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {alive,boundedBytes,canonical,check,freeze,sha256} from './checks';
import {shardedLocalRef,validateLocalRef} from './local-refs';
import type {LocalContentStore,LocalRef} from './types';

export interface MacIsolatedStoreConfig {
  /** Actual installed binary/script hashes, supplied only after approved installation. */
  python:{path:'/Library/Foundry/bin/cas-python';sha256:string};
  helper:{path:'/Library/Foundry/bin/mac-cas.py';sha256:string};
}
export interface MacCasCensus {
  /** Actual apparent object bytes, including incomplete creates; not reclaimable space. */
  readonly complete:true;readonly cacheBytes:number;readonly objectCount:number;readonly freeBytes:number;
}
export interface MacIsolatedContentStore extends LocalContentStore {
  /** Fresh root-authenticated observation; failure has no cached/zero fallback. */
  census(signal:AbortSignal):Promise<Readonly<MacCasCensus>>;
}
const stores=new WeakSet<LocalContentStore>();
// There is one fixed native endpoint. Reconstructing a factory must not create
// a second client lane or clear occupancy after a logical deadline.
let installed:{key:string;store:MacIsolatedContentStore}|undefined;
export function assertMacIsolatedStore(store:LocalContentStore):void {
  check(stores.has(store),'concrete-mac-isolated-store-required');
}
async function pinned(path:string,digest:string,executable:boolean,signal:AbortSignal):Promise<void> {
  alive(signal);check(process.platform==='darwin'&&process.getuid?.()!==0&&process.getuid?.()===process.geteuid?.(),'cas-unprivileged-mac-client');
  let current='';const parts=path.slice(1).split('/');
  for(let i=-1;i<parts.length;i++) {
    current=i===-1?'/':`${current==='/'?'':current}/${parts[i]}`;
    const s=await lstat(current),leaf=i===parts.length-1;
    check(s.uid===0&&(s.mode&0o022)===0&&!s.isSymbolicLink()&&(leaf?s.isFile()&&s.nlink===1&&(s.mode&0o6000)===0:s.isDirectory()),'cas-helper-ownership');
    if(leaf&&executable)check((s.mode&0o111)!==0,'cas-python-executable');
    // The native client independently rejects ACLs; this also refuses effective
    // write access before invoking an installed, owner-trusted interpreter.
    let writable=false;
    try{await access(current,constants.W_OK);writable=true;}
    catch(e){check(['EACCES','EPERM','EROFS'].includes((e as NodeJS.ErrnoException).code??''),'cas-access-unknown');}
    check(!writable,'cas-helper-writable');alive(signal);
  }
  const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const s=await fd.stat();check(s.isFile()&&s.uid===0&&s.nlink===1&&s.size>0&&s.size<=64*1048576,'cas-helper-size');
    const hash=createHash('sha256'),buffer=Buffer.alloc(65536);let offset=0;
    while(offset<s.size){alive(signal);const r=await fd.read(buffer,0,Math.min(buffer.length,s.size-offset),offset);check(r.bytesRead>0,'cas-helper-short');hash.update(buffer.subarray(0,r.bytesRead));offset+=r.bytesRead;}
    check(hash.digest('hex')===digest,'cas-helper-pin');
  }finally{await fd.close();}
}
/** Immutable object operations, not a writable-tree callback. Construction never
 * starts the privileged service. Client has no filesystem path or command input.
 * The service's root-owned namespace and exact peer UID enforce the boundary. */
export function createMacIsolatedContentStore(config:MacIsolatedStoreConfig):MacIsolatedContentStore {
  const python=Object.freeze({...config.python}),helper=Object.freeze({...config.helper});
  check(python.path==='/Library/Foundry/bin/cas-python'&&helper.path==='/Library/Foundry/bin/mac-cas.py'&&
    [python.sha256,helper.sha256].every(x=>/^[a-f0-9]{64}$/.test(x)),'cas-installed-pins-required');
  const key=canonical({python,helper});
  if(installed){check(installed.key===key,'cas-installed-pins-changed');return installed.store;}
  let busy=false;
  const waiting:Array<()=>void>=[];
  function acquire(signal:AbortSignal):Promise<()=>void> {
    alive(signal);check(waiting.length<4,'cas-client-queue-full');
    return new Promise<()=>void>((resolve,reject)=>{
      const abort=()=>{const i=waiting.indexOf(enter);if(i>=0)waiting.splice(i,1);reject(new Error('build-storage: cas-aborted'));};
      const enter=()=>{
        signal.removeEventListener('abort',abort);busy=true;
        resolve(()=>{busy=false;waiting.shift()?.();});
      };
      if(!busy)enter();
      else{waiting.push(enter);signal.addEventListener('abort',abort,{once:true});}
    });
  }
  async function exchange(request:object,signal:AbortSignal):Promise<Record<string,unknown>> {
    alive(signal);
    // The deadline includes queueing and pin reads. Logical timeout may return
    // first, but physical work holds the single lane until pin IO/child close.
    const lifetime=new AbortController(),abort=()=>lifetime.abort();
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    const timer=setTimeout(abort,20000);
    let rejectAbort:()=>void=()=>{};
    const aborted=new Promise<never>((_,reject)=>{
      rejectAbort=()=>reject(new Error('build-storage: cas-aborted-or-deadline'));
      lifetime.signal.addEventListener('abort',rejectAbort,{once:true});if(lifetime.signal.aborted)rejectAbort();
    });
    const perform=async()=>{
      const release=await acquire(lifetime.signal);
      try{
        await pinned(python.path,python.sha256,true,lifetime.signal);await pinned(helper.path,helper.sha256,false,lifetime.signal);alive(lifetime.signal);
        const raw=Buffer.from(JSON.stringify(request));check(raw.length<=1450000,'cas-request-bound');
        return await new Promise<Record<string,unknown>>((resolve,reject)=>{
          const child=spawn(python.path,['-I','-S',helper.path,'client'],{shell:false,env:{LANG:'C',LC_ALL:'C'},stdio:['pipe','pipe','pipe']});
          let failure:Error|undefined,total=0;const chunks:Buffer[]=[];
          const fail=(code:string)=>{if(!failure){failure=new Error(`build-storage: ${code}`);child.kill('SIGKILL');}};
          const stop=()=>fail('cas-aborted');
          lifetime.signal.addEventListener('abort',stop,{once:true});if(lifetime.signal.aborted)stop();
          child.on('error',()=>fail('cas-client-start'));
          child.stdin.on('error',()=>fail('cas-client-input'));
          child.stdout.on('data',(b:Buffer)=>{total+=b.length;if(total>1450000)fail('cas-response-bound');else if(!failure)chunks.push(b);});
          child.stderr.on('data',()=>{}); // Never echo privileged paths, bytes or errors.
          child.on('close',(code)=>{
            lifetime.signal.removeEventListener('abort',stop);
            if(failure){reject(failure);return;}
            try{alive(lifetime.signal);check(code===0,'cas-client-failed');const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));check(value&&value.version===1&&value.ok===true,'cas-service-refused');resolve(value);}
            catch(e){reject(e);}
          });
          child.stdin.end(raw);
        });
      }finally{release();}
    };
    try{return await Promise.race([perform(),aborted]);}
    finally{clearTimeout(timer);signal.removeEventListener('abort',abort);lifetime.signal.removeEventListener('abort',rejectAbort);}
  }
  const store:MacIsolatedContentStore=Object.freeze({layout:'sharded-v2' as const,
    async census(signal:AbortSignal):Promise<Readonly<MacCasCensus>> {
      const nonce=Buffer.from(randomBytes(16)).toString('hex'),started=performance.now();
      const r=await exchange({version:1,op:'census',nonce},signal);alive(signal);
      check(performance.now()-started<20000&&Object.keys(r).sort().join(',')===
        'cacheBytes,complete,freeBytes,helperSha256,nonce,objectCount,ok,pythonSha256,root,version'&&
        r.nonce===nonce&&r.root==='/Library/Foundry/CAS/objects'&&r.complete===true&&
        r.pythonSha256===python.sha256&&r.helperSha256===helper.sha256,'cas-census-receipt');
      for(const [value,max] of [[r.cacheBytes,20*1024**3],[r.objectCount,200000],[r.freeBytes,Number.MAX_SAFE_INTEGER]])
        check(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=Number(max),'cas-census-count');
      check(Number(r.cacheBytes)<=Number(r.objectCount)*1048576,'cas-census-size');
      return Object.freeze({complete:true as const,cacheBytes:r.cacheBytes as number,objectCount:r.objectCount as number,freeBytes:r.freeBytes as number});
    },
    async put(input:Uint8Array,signal:AbortSignal){
      const bytes=boundedBytes(input,1048576);check(bytes.length>0,'cas-empty-object');
      const ref=shardedLocalRef(sha256(bytes),bytes.length);
      const r=await exchange({version:1,op:'put',sha256:ref.sha256,sizeBytes:ref.sizeBytes,data:Buffer.from(bytes).toString('base64')},signal);
      check(canonical(r.ref)===canonical(ref)&&Object.keys(r).sort().join(',')==='ok,ref,version','cas-put-receipt');return freeze(ref);
    },
    async read(input:LocalRef,signal:AbortSignal){
      const ref=JSON.parse(canonical(input)) as LocalRef;validateLocalRef(ref,true);
      const r=await exchange({version:1,op:'read',sha256:ref.sha256,sizeBytes:ref.sizeBytes},signal);
      check(canonical(r.ref)===canonical(ref)&&typeof r.data==='string'&&Object.keys(r).sort().join(',')==='data,ok,ref,version','cas-read-receipt');
      const bytes=Buffer.from(r.data,'base64');check(bytes.toString('base64')===r.data&&bytes.length===ref.sizeBytes&&sha256(bytes)===ref.sha256,'cas-read-integrity');return new Uint8Array(bytes);
    }});
  stores.add(store);installed={key,store};return store;
}

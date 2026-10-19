import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {access,lstat,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {alive,boundedBytes,canonical,check,freeze,sha256} from './checks';
import {shardedLocalRef,validateLocalRef} from './local-refs';
import type {LocalContentStore,LocalRef} from './types';

export interface MacIsolatedStoreConfig {
  /** Actual installed binary/script hashes, supplied only after approved installation. */
  python:{path:'/Library/Foundry/bin/cas-python';sha256:string};
  helper:{path:'/Library/Foundry/bin/mac-cas.py';sha256:string};
}
const stores=new WeakSet<LocalContentStore>();
let children=0;
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
export function createMacIsolatedContentStore(config:MacIsolatedStoreConfig):LocalContentStore {
  const python=Object.freeze({...config.python}),helper=Object.freeze({...config.helper});
  check(python.path==='/Library/Foundry/bin/cas-python'&&helper.path==='/Library/Foundry/bin/mac-cas.py'&&
    [python.sha256,helper.sha256].every(x=>/^[a-f0-9]{64}$/.test(x)),'cas-installed-pins-required');
  let busy=false;
  async function exchange(request:object,signal:AbortSignal):Promise<Record<string,unknown>> {
    alive(signal);check(!busy&&children<4,'cas-client-occupied');busy=true;children++;
    let spawned=false;
    try{
      await pinned(python.path,python.sha256,true,signal);await pinned(helper.path,helper.sha256,false,signal);alive(signal);
      const raw=Buffer.from(JSON.stringify(request));check(raw.length<=1450000,'cas-request-bound');
      return await new Promise<Record<string,unknown>>((resolve,reject)=>{
        const child=spawn(python.path,['-I','-S',helper.path,'client'],{shell:false,env:{LANG:'C',LC_ALL:'C'},stdio:['pipe','pipe','pipe']});
        spawned=true;let done=false,total=0;const chunks:Buffer[]=[];
        const fail=(code:string)=>{if(!done){done=true;reject(new Error(`build-storage: ${code}`));}child.kill('SIGKILL');};
        const abort=()=>fail('cas-aborted');const timer=setTimeout(()=>fail('cas-deadline'),20000);
        signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
        child.on('error',()=>fail('cas-client-start'));
        child.stdin.on('error',()=>fail('cas-client-input'));
        child.stdout.on('data',(b:Buffer)=>{total+=b.length;if(total>1450000)fail('cas-response-bound');else chunks.push(b);});
        child.stderr.on('data',()=>{}); // Never echo privileged paths, bytes or errors.
        child.on('close',(code)=>{
          clearTimeout(timer);signal.removeEventListener('abort',abort);busy=false;children--;
          if(done)return;done=true;
          try{alive(signal);check(code===0,'cas-client-failed');const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));check(value&&value.version===1&&value.ok===true,'cas-service-refused');resolve(value);}
          catch(e){reject(e);}
        });
        child.stdin.end(raw);
      });
    }finally{if(!spawned){busy=false;children--;}}
  }
  const store:LocalContentStore=Object.freeze({layout:'sharded-v2' as const,
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
  stores.add(store);return store;
}

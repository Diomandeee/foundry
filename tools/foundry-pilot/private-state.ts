import {constants} from 'node:fs';
import {open,lstat,mkdir,rmdir,rename,unlink} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonicalPath} from '../../packages/worker-runtime/src/node';
import {canonical} from '../../packages/library-jobs/src/data';
export class PilotError extends Error {constructor(readonly code:string,readonly status=503){super(code);}}
export function need(value:unknown,code:string,status=400):asserts value{if(!value)throw new PilotError(code,status);}
export function exact(value:unknown,names:readonly string[]):asserts value is Record<string,any>{need(value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...names].sort().join(','),'pilot-invalid-fields');}
export function id(value:unknown):asserts value is string{need(typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?![\s\S])/.test(value),'pilot-invalid-id');}
export function uint(value:unknown,min=0,max=Number.MAX_SAFE_INTEGER):asserts value is number{need(Number.isSafeInteger(value)&&!Object.is(value,-0)&&Number(value)>=min&&Number(value)<=max,'pilot-invalid-integer');}
export function digest(value:unknown):asserts value is string{need(typeof value==='string'&&/^[a-f0-9]{64}(?![\s\S])/.test(value),'pilot-invalid-digest');}
export async function privateDirectory(root:string){await canonicalPath(root);const s=await lstat(root);need(s.isDirectory()&&s.uid===process.getuid?.()&&(s.mode&0o077)===0,'pilot-private-directory-required');}
/** Existing host-managed files only. No credentials or directories are provisioned. */
export async function readJsonFile(file:string,maxBytes=65536,privateOnly=true):Promise<unknown>{
 need(typeof file==='string'&&isAbsolute(file),'pilot-absolute-file-required');await canonicalPath(file);
 const h=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const s=await h.stat();need(s.isFile()&&s.uid===process.getuid?.()&&(s.mode&(privateOnly?0o077:0o022))===0&&s.size<=maxBytes,'pilot-file-policy');
  const bytes=Buffer.alloc(maxBytes+1);let count=0;for(;;){const n=await h.read(bytes,count,bytes.length-count,null);count+=n.bytesRead;need(count<=maxBytes,'pilot-file-too-large');if(n.bytesRead===0)break;}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,count)));}catch{throw new PilotError('pilot-invalid-json',400);}
 }finally{await h.close();}
}
export interface PrivateSession<T>{load():Promise<T|null>;save(value:T):Promise<void>}
/** A crash leaves an exclusive lock. Never steal/reset it or discard pending intent. */
export async function withPrivateState<T,R>(root:string,name:string,run:(session:PrivateSession<T>)=>Promise<R>):Promise<R>{
 id(name);await privateDirectory(root);const lock=join(root,name+'.lock'),file=join(root,name+'.json');
 try{await mkdir(lock,{mode:0o700});}catch{throw new PilotError('pilot-state-locked',409);}
 let healthy=true;const sync=async()=>{const d=await open(root,'r');try{await d.sync();}finally{await d.close();}};
 try{await sync();}catch{throw new PilotError('pilot-state-durability-failed');}
 const session:PrivateSession<T>={
  async load(){try{const value=await readJsonFile(file,1048576,true);need(value!==null,'pilot-state-null',409);return value as T;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}},
  async save(value){let temp:string|undefined;try{const bytes=canonical(value);need(Buffer.byteLength(bytes)<=1048576,'pilot-state-capacity');temp=join(root,name+'-'+randomUUID()+'.tmp');const h=await open(temp,'wx',0o600);try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}await rename(temp,file);temp=undefined;await sync();}catch{healthy=false;throw new PilotError('pilot-state-save-failed');}finally{if(temp)try{await unlink(temp);}catch{/* Retain uncertain evidence; never remove lock on save failure. */}}}
 };
 try{return await run(session);}finally{if(healthy){await rmdir(lock);await sync();}}
}
export function credential(reference:string):string{
 need(/^[A-Z][A-Z0-9_]{0,95}(?![\s\S])/.test(reference),'pilot-invalid-credential-reference');const token=process.env[reference];
 need(typeof token==='string'&&token.length<=8192&&/^[A-Za-z0-9._~+/-]{32,}=*(?![\s\S])/.test(token),'pilot-credential-unavailable');return token;
}
export function safeError(error:unknown):{code:string;status:number}{return error instanceof PilotError?{code:error.code,status:error.status}:{code:'pilot-unavailable',status:503};}

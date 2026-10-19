import {constants} from 'node:fs';
import {mkdir,lstat,open} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import type {VerificationReceipt} from '@foundry/stores';

/** Local hook evidence. Create-only receipts precede merge; uncertain/partial
 * files are retained and cannot be replaced by a successful retry. */
export async function recordLocalVerification(directory:string,receipt:VerificationReceipt):Promise<void>{
  const {sha256,...body}=receipt;
  const encoded=JSON.stringify(receipt),expectedBytes=Buffer.from(encoded,'utf8');
  if(!/^[a-f0-9]{64}$/.test(sha256)||Buffer.byteLength(encoded)>262144||
    createHash('sha256').update(JSON.stringify(body)).digest('hex')!==sha256)
    throw new Error('invalid verification receipt');
  try{await mkdir(directory,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  const stat=await lstat(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0)
    throw new Error('unsafe verification directory');
  const file=join(directory,sha256+'.json');
  let created=false;
  try{
    const h=await open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    created=true;
    try{await h.writeFile(encoded);await h.sync();}finally{await h.close();}
  }catch(e){if(created||(e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  const h=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const s=await h.stat();
    if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid?.()||(s.mode&0o077)!==0||s.size!==Buffer.byteLength(encoded))
      throw new Error('verification receipt identity mismatch');
    const bytes=Buffer.alloc(s.size+1);const read=await h.read(bytes,0,bytes.length,0);
    if(read.bytesRead!==s.size||bytes.subarray(0,s.size).some((value:number,index:number)=>value!==expectedBytes[index]))
      throw new Error('verification receipt not durably confirmed');
    await h.sync();
  }finally{await h.close();}
  const parent=await open(directory,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{await parent.sync();}finally{await parent.close();}
  const ancestor=await open(dirname(directory),constants.O_RDONLY|constants.O_NOFOLLOW);
  try{await ancestor.sync();}finally{await ancestor.close();}
}

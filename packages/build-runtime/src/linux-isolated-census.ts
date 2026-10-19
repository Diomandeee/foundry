import {constants} from 'node:fs';
import {open,lstat} from 'node:fs/promises';
import {check} from './plans.js';
export interface LinuxIsolationCensus {version:1;observedAt:number;freeBytes:number;workspaceBytes:number|null;complete:boolean;slotFree:boolean;
  profiles:string[];helperSha256:string;pythonSha256:string}
/** Actual root-written metadata only. Unreadable/stale/private state is never zero.
 * The Unix broker is not contacted and no privileged discovery command is run. */
export async function readLinuxIsolationCensus():Promise<LinuxIsolationCensus>{
  check(process.platform==='linux','linux-census-platform');
  for(const path of ['/run','/run/foundry-linux']){const s=await lstat(path);check(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===0&&(s.mode&0o022)===0,'linux-census-namespace');}
  for(let attempt=0;attempt<3;attempt++){
   const f=await open('/run/foundry-linux/census.json',constants.O_RDONLY|constants.O_NOFOLLOW);
   try{
    const s=await f.stat();
    // The root publisher atomically replaces this pathname. An open descriptor
    // can refer to the just-unlinked old inode; reopen rather than treating
    // normal publication as loss of liveness. Hard links still fail closed.
    if(s.nlink===0)continue;
    check(s.isFile()&&s.uid===0&&s.nlink===1&&(s.mode&0o222)===0&&s.size>0&&s.size<=4096,'linux-census-file');
    const data=Buffer.alloc(4097),read=await f.read(data,0,data.length,0);check(read.bytesRead===s.size,'linux-census-size');
    const c=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(data.subarray(0,read.bytesRead))) as LinuxIsolationCensus;
    check(Object.keys(c).sort().join(',')==='complete,freeBytes,helperSha256,observedAt,profiles,pythonSha256,slotFree,version,workspaceBytes'&&c.version===1&&typeof c.complete==='boolean'&&typeof c.slotFree==='boolean','linux-census-shape');
    check(Array.isArray(c.profiles)&&c.profiles.length>0&&c.profiles.length<=32&&new Set(c.profiles).size===c.profiles.length&&
      [...c.profiles,c.helperSha256,c.pythonSha256].every(h=>typeof h==='string'&&/^[0-9a-f]{64}$/.test(h)),'linux-census-installed-policy');
    check(Number.isSafeInteger(c.observedAt)&&c.observedAt<=Date.now()&&Date.now()-c.observedAt<=15000&&Number.isSafeInteger(c.freeBytes)&&c.freeBytes>=0,'linux-census-freshness');
    check(c.workspaceBytes===null?!c.complete:Number.isSafeInteger(c.workspaceBytes)&&c.workspaceBytes>=0&&c.complete,'linux-census-accounting');
    return c;
   }finally{await f.close();}
  }
  throw new Error('linux-census-replacement-budget');
}

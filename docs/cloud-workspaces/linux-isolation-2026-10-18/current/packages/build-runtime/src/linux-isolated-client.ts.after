import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {lstat,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {check} from './plans.js';
export interface LinuxIsolationConfig {
  python:'/usr/bin/python3.12';pythonSha256:string;
  helper:'/usr/local/libexec/foundry-linux-isolation.py';helperSha256:string;
}
const FRAME=1450000;
let occupied=false;
async function pin(path:string,sha:string):Promise<void>{
  check(/^[0-9a-f]{64}$/.test(sha),'linux-installed-pin-required');
  let cursor='';for(const part of path.split('/').filter(Boolean)){
    cursor+='/'+part;const s=await lstat(cursor);
    check(s.uid===0&&!s.isSymbolicLink()&&(s.mode&0o022)===0,'linux-root-owned-install-required');
    if(cursor!==path)check(s.isDirectory(),'linux-install-ancestor');
    else check(s.isFile()&&s.nlink===1&&s.size<=256*1024**2,'linux-install-file');
  }
  check(createHash('sha256').update(await readFile(path)).digest('hex')===sha,'linux-installed-pin-mismatch');
}
/** Single process-wide physical session. Timeouts kill the forwarding client;
 * occupancy is released ONLY on its close. Broker retains its durable slot. */
export class LinuxIsolationClient {
  private child?:ChildProcessWithoutNullStreams;
  private pending?:{resolve:(v:unknown)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>};
  private bytes=Buffer.alloc(0);
  private dead=false;
  private ready=false;
  private constructor(){}
  static async connect(c:LinuxIsolationConfig,signal:AbortSignal):Promise<LinuxIsolationClient>{
    check(process.platform==='linux'&&!signal.aborted&&!occupied&&c.python==='/usr/bin/python3.12'&&c.helper==='/usr/local/libexec/foundry-linux-isolation.py','linux-isolation-client-policy');
    occupied=true;const client=new LinuxIsolationClient();
    try{
      await pin(c.python,c.pythonSha256);await pin(c.helper,c.helperSha256);
      check(!signal.aborted,'linux-client-aborted');
      const p=spawn(c.python,['-I','-S',c.helper,'client'],{stdio:['pipe','pipe','pipe'],env:{LANG:'C',LC_ALL:'C'},cwd:'/'});
      client.child=p;
      p.stdout.on('data',(b:Buffer)=>client.accept(b));
      // No stderr content enters journals, errors or receipts.
      p.stderr.on('data',()=>client.fail());p.on('error',()=>client.fail());
      p.stdin.on('error',()=>client.fail());
      p.on('close',()=>{occupied=false;client.fail();});client.ready=true;return client;
    }catch{if(!client.child)occupied=false;client.fail();throw new Error('linux-isolation-connect-failed');}
  }
  private accept(b:Buffer):void{
    try{
      check(!this.dead&&this.pending&&this.bytes.length+b.length<=FRAME+4,'linux-response-overflow');
      this.bytes=Buffer.concat([this.bytes,b]);if(this.bytes.length<4)return;
      const n=this.bytes.readUInt32BE(0);check(n>0&&n<=FRAME,'linux-response-frame');if(this.bytes.length<n+4)return;
      check(this.bytes.length===n+4,'linux-response-extra-frame');
      const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(this.bytes.subarray(4)));
      const pending=this.pending;this.pending=undefined;this.bytes=Buffer.alloc(0);clearTimeout(pending.timer);pending.resolve(value);
    }catch{this.fail();}
  }
  private fail():void{
    this.dead=true;this.child?.kill('SIGKILL');
    if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(new Error('linux-isolation-unconfirmed'));this.pending=undefined;}
  }
  async request(body:object,signal:AbortSignal,preparation=false):Promise<unknown>{
    check(this.ready&&!this.dead&&!this.pending&&!signal.aborted,'linux-session-unavailable');
    const bytes=Buffer.from(JSON.stringify(body));check(bytes.length>0&&bytes.length<=FRAME,'linux-request-budget');
    const header=Buffer.alloc(4);header.writeUInt32BE(bytes.length);
    const stop=()=>this.fail();signal.addEventListener('abort',stop,{once:true});
    try{return await new Promise<unknown>((resolve,reject)=>{
      this.pending={resolve,reject,timer:setTimeout(()=>this.fail(),preparation?45000:10000)};
      this.child!.stdin.write(Buffer.concat([header,bytes]),error=>{if(error)this.fail();});
    });}finally{signal.removeEventListener('abort',stop);}
  }
  close():void{this.fail();}
}

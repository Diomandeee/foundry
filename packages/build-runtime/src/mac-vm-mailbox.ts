import {constants} from 'node:fs';
import {open,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import {createMacReadonlyTreeSeal,type ReadonlyManagedTreeSeal,type MacReadonlyTreeIdentity} from '../../build-storage/src/mac-readonly-seal.js';
import {canonical,dedicated} from './host.js';
import {approvalFor,check,hash} from './plans.js';
import type {RuntimePlan,ExecutionScope} from './types.js';
import type {MacVmIoRequest} from './mac-vm-staging.js';
/** Explicit operator-mediated I/O. Writes request bytes only to the worker's
 * private journal. NEVER invokes sudo, root Python, hdiutil or a mount itself.
 * Owner inspects the hash/request then invokes the root helper out of band.
 * A receipt merely locates a tree: stage/intake still verify all actual bytes. */
export class MacVmIoMailbox {
  constructor(private readonly guardSha256:string){check(/^[0-9a-f]{64}$/.test(guardSha256),'vm-mailbox-guard-pin');}
  async exchange(plan:RuntimePlan,request:MacVmIoRequest,scope:ExecutionScope):Promise<ReadonlyManagedTreeSeal>{
    const h=approvalFor(plan).host;dedicated(h);scope.assertLease();
    check(h.allowActivation&&hash(request.request)===request.sha256&&Buffer.byteLength(request.request)<=524288,'vm-mailbox-request');
    const data=JSON.parse(request.request) as {attemptId:string;guardSha256:string;kind:string};
    check(data.attemptId===plan.attemptId&&data.kind===request.kind&&data.guardSha256===this.guardSha256,'vm-mailbox-binding');
    await canonical(h.journalRoot,h.uid,'directory',true);scope.assertLease();
    const path=join(h.journalRoot,`vm-io-${plan.attemptId}-${request.kind}-${request.sha256}.json`);
    const f=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{await f.writeFile(request.request);await f.sync();}finally{await f.close();}
    const d=await open(h.journalRoot,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{await d.sync();}finally{await d.close();}
    const receiptPath=`/Library/Foundry/VM/attempts/${plan.attemptId}/receipts/${request.kind}.json`;
    while(true){
      scope.assertLease();check(!scope.signal.aborted,'vm-mailbox-aborted');
      try{await lstat(receiptPath);}catch(e){
        if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;
        await wait(Math.min(500,scope.remainingMs()),undefined,{signal:scope.signal});continue;
      }
      // Same descriptor throughout; hostile symlink/FIFO/large receipt refuses.
      await canonical(receiptPath,0,'file');
      const fd=await open(receiptPath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      let raw:Buffer;
      try{
        const s=await fd.stat({bigint:true});
        check(s.isFile()&&s.uid===0n&&s.nlink===1n&&(s.mode&0o7777n)===0o444n&&s.size>0n&&s.size<=16384n,'vm-mailbox-receipt-file');
        raw=Buffer.alloc(Number(s.size));let at=0;
        while(at<raw.length){scope.assertLease();const r=await fd.read(raw,at,raw.length-at,at);check(r.bytesRead>0,'vm-mailbox-short');at+=r.bytesRead;}
        const after=await fd.stat({bigint:true}),named=await lstat(receiptPath,{bigint:true});
        check([after,named].every(x=>x.dev===s.dev&&x.ino===s.ino&&x.size===s.size&&x.mtimeNs===s.mtimeNs&&x.ctimeNs===s.ctimeNs),'vm-mailbox-receipt-changed');
      }finally{await fd.close();}
      scope.assertLease();
      const r=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(raw)) as {version:number;kind:string;requestSha256:string;imageSha256:string;tree:MacReadonlyTreeIdentity};
      check(Object.keys(r).sort().join(',')==='imageSha256,kind,requestSha256,tree,version'&&r.version===1&&r.kind===request.kind&&
        r.requestSha256===request.sha256&&/^[a-f0-9]{64}$/.test(r.imageSha256),'vm-mailbox-receipt-binding');
      const root=`/Library/Foundry/VM/attempts/${plan.attemptId}/${request.kind==='stage'?'input':'intake'}`;
      check(r.tree.path===root&&r.tree.mountPoint===root,'vm-mailbox-mount');
      return createMacReadonlyTreeSeal({helper:{path:'/Library/Foundry/bin/mac-tree-guard',sha256:this.guardSha256},tree:r.tree,
        maxOperationMs:Math.min(3900000,plan.timeoutMs+120000)});
    }
  }
}

import {constants} from 'node:fs';
import {lstat, mkdir, open} from 'node:fs/promises';
import {join} from 'node:path';
import {alive, boundedBytes, check, CHUNK_BYTES, freeze, sha256, snapshot} from './checks';
import {availableName, inspectFile, readFileChunks, rootCopy, siblingNames, verifyRoot} from './filesystem';
import {shardedLocalRef, validateLocalRef} from './local-refs';
import type {LocalContentStore, LocalRef, ManagedRoot, ManagedTreeSeal} from './types';

/** Real on-disk CAS. Host provisions a private dedicated directory. Construction is inert.
 * Local refs deliberately have NO cloud generation or grant ID. Failed partial creates
 * remain as evidence; collision/corruption fails closed rather than replacing/cleaning. */
export function createLocalContentStore(config:ManagedRoot,seal:ManagedTreeSeal,layout:'flat-v1'|'sharded-v2'='flat-v1'):LocalContentStore {
  const root=rootCopy(config);
  check(layout==='flat-v1'||layout==='sharded-v2','local-layout');
  const name=(digest:string)=>`sha256-${digest}`;
  const validate=(input:LocalRef)=>{
    const ref=snapshot(input) as LocalRef;
    validateLocalRef(ref);
    return ref;
  };
  async function read(ref:LocalRef,signal:AbortSignal):Promise<Uint8Array> {
    const stat=await inspectFile(root,ref.relativePath,signal); check(stat.size===ref.sizeBytes,'local-size');
    const bytes=new Uint8Array(ref.sizeBytes);
    await readFileChunks(root,ref.relativePath,stat,CHUNK_BYTES,async b=>{bytes.set(b);},signal);
    check(sha256(bytes)===ref.sha256,'local-digest'); return bytes;
  }
  return Object.freeze({
    layout,
    async put(input:Uint8Array,signal:AbortSignal) {
      const bytes=boundedBytes(input,CHUNK_BYTES); check(bytes.length>0,'empty-local-object');
      const digest=sha256(bytes), ref:LocalRef=freeze(layout==='sharded-v2'?shardedLocalRef(digest,bytes.length):{kind:'local-cas',sha256:digest,sizeBytes:bytes.length,relativePath:name(digest)});
      return seal.withExclusiveTrees([root.path],async()=>{
        alive(signal); await verifyRoot(root,signal);
        let parent=root.path;
        const device=(await lstat(root.path)).dev;
        for(const part of ref.relativePath.split('/').slice(0,-1)) {
          const names=await siblingNames(parent,signal), child=join(parent,part);
          if(!names.has(part)) {availableName(names,part); await mkdir(child,{mode:0o700});}
          await verifyRoot({path:child,uid:root.uid},signal);
          check((await lstat(child)).dev===device,'nested-mount-forbidden');
          const dir=await open(parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
          try {await dir.sync();} finally {await dir.close();}
          parent=child;
        }
        const names=await siblingNames(parent,signal);
        if(names.has(name(digest))) {await read(ref,signal); return ref;}
        availableName(names,name(digest));
        const handle=await open(join(root.path,ref.relativePath),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
        try {
          let offset=0;
          while(offset<bytes.length) {alive(signal); const r=await handle.write(bytes,offset,bytes.length-offset,offset); check(r.bytesWritten>0,'local-write-progress'); offset+=r.bytesWritten;}
          await handle.sync();
        } finally {await handle.close();}
        // Seal directory entry as well as bytes; no rename or replacement protocol.
        const dir=await open(parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
        try {await dir.sync();} finally {await dir.close();}
        await read(ref,signal); alive(signal); return ref;
      },signal);
    },
    async read(input:LocalRef,signal:AbortSignal) {const ref=validate(input); return seal.withExclusiveTrees([root.path],()=>read(ref,signal),signal);},
  });
}

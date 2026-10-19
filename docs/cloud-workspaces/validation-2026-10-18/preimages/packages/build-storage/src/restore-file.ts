import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, mkdir, open} from 'node:fs/promises';
import {join} from 'node:path';
import {alive, boundedBytes, check, CHUNK_BYTES, sha256} from './checks';
import {availableName, inspectFile, readFileChunks, verifyRoot} from './filesystem';
import type {LocalContentStore, LocalRef, ManagedRoot} from './types';
import type {ProjectInputTree} from './project-input-tree';

/** Caller has validated the entire manifest and holds the destination tree seal. */
export async function restoreSnapshotFile(file:{path:string;mode:number;sizeBytes:number;sha256:string;localChunks:{ref:LocalRef;offset:number;sizeBytes:number}[]},
  root:ManagedRoot,local:LocalContentStore,signal:AbortSignal,tree:ProjectInputTree,maxEntries:number):Promise<void> {
  const device=(await lstat(root.path)).dev;
  let parent=root.path; const parts=file.path.split('/');
  for(const part of parts.slice(0,-1)) {
    const names=await tree.names(parent), child=join(parent,part);
    if(!names.has(part)) {
      availableName(names,part,maxEntries); await mkdir(child,{mode:0o700}); tree.created(parent,part);
      const dir=await open(parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      try {await dir.sync();} finally {await dir.close();}
    }
    await verifyRoot({path:child,uid:root.uid},signal);
    check((await lstat(child)).dev===device,'nested-mount-forbidden'); parent=child;
  }
  const names=await tree.names(parent), name=parts[parts.length-1];
  availableName(names,name,maxEntries);
  const handle=await open(join(parent,name),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try {
    tree.created(parent,name);
    let offset=0; const digest=createHash('sha256');
    for(const range of file.localChunks) {
      const ref=range.ref;
      const bytes=boundedBytes(await local.read(ref,signal),CHUNK_BYTES); alive(signal);
      check(bytes.length===ref.sizeBytes&&sha256(bytes)===ref.sha256,'restore-chunk-digest');
      check(range.offset>=0&&range.sizeBytes>0&&range.offset+range.sizeBytes<=bytes.length,'restore-range');
      const selected=bytes.subarray(range.offset,range.offset+range.sizeBytes); digest.update(selected);
      let used=0;
      while(used<selected.length) {alive(signal); const r=await handle.write(selected,used,selected.length-used,offset+used); check(r.bytesWritten>0,'restore-write-progress'); used+=r.bytesWritten;}
      offset+=selected.length;
    }
    check(offset===file.sizeBytes&&digest.digest('hex')===file.sha256,'restore-whole-file-digest');
    await handle.chmod(file.mode&0o755); await handle.sync();
  } finally {await handle.close();}
  const stat=await inspectFile(root,file.path,signal,false), digest=createHash('sha256');
  await readFileChunks(root,file.path,stat,CHUNK_BYTES,async b=>{digest.update(b);},signal,false);
  check(stat.size===file.sizeBytes&&digest.digest('hex')===file.sha256,'restore-readback');
  const dir=await open(parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try {await dir.sync();} finally {await dir.close();}
}

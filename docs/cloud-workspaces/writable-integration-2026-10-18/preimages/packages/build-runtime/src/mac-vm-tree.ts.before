import {createHash} from 'node:crypto';
import {lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {inspectDirectory,inspectFile,readFileChunks,siblingNames} from '../../build-storage/src/filesystem.js';
import {relative,uniquePaths} from '../../build-storage/src/checks.js';
import {check} from './plans.js';

export interface TreeFile {path:string;sha256:string;sizeBytes:number}
/** Caller holds the concrete kernel-readonly seal. Exact files AND directories;
 * bounded names, no alias/link/mount/special files, same-descriptor byte hashes. */
export async function verifyMacVmTree(path:string,files:readonly TreeFile[],directories:readonly string[],signal:AbortSignal):Promise<void> {
  check(files.length<=20000 && directories.length<=20000,'mac-vm-tree-count');
  uniquePaths(files.map(f=>f.path));const wanted=new Set(files.map(f=>f.path)),dirs=new Set(directories);
  check(dirs.size===directories.length,'mac-vm-directory-duplicates');
  for(const dir of dirs){relative(dir);check(!wanted.has(dir),'mac-vm-tree-overlap');}
  const root={path,uid:0},pending=[''];let count=0,seen=0,seenDirs=0;
  while(pending.length){
    const parent=pending.pop()!;
    for(const name of await siblingNames(join(path,parent),signal,20000)){
      check(++count<=20000,'mac-vm-tree-entry-budget');const p=parent?`${parent}/${name}`:name;
      const s=await lstat(join(path,p));
      if(s.isDirectory()){check(dirs.has(p),'mac-vm-extra-directory');await inspectDirectory(root,p,signal,false);pending.push(p);seenDirs++;}
      else{check(wanted.has(p),'mac-vm-extra-file');await inspectFile(root,p,signal,false);seen++;}
    }
  }
  check(seen===files.length && seenDirs===dirs.size,'mac-vm-incomplete-tree');
  for(const file of files){
    const stat=await inspectFile(root,file.path,signal,false),h=createHash('sha256');
    check(Number.isSafeInteger(file.sizeBytes)&&file.sizeBytes>=0&&stat.size===file.sizeBytes,'mac-vm-tree-size');
    await readFileChunks(root,file.path,stat,1048576,async bytes=>{h.update(bytes);},signal,false);
    check(h.digest('hex')===file.sha256,'mac-vm-tree-digest');
  }
}
export function parentDirectories(files:readonly {path:string}[]):string[]{
  const dirs=new Set<string>();for(const file of files){const parts=file.path.split('/');for(let i=1;i<parts.length;i++)dirs.add(parts.slice(0,i).join('/'));}return [...dirs];
}
export async function readMacVmMetadata(root:string,path:string,limit:number,signal:AbortSignal):Promise<Uint8Array>{
  const tree={path:root,uid:0},stat=await inspectFile(tree,path,signal,false);
  check(stat.size>0&&stat.size<=limit,'mac-vm-metadata-limit');const parts:Uint8Array[]=[];
  await readFileChunks(tree,path,stat,65536,async b=>{parts.push(b);},signal,false);return Buffer.concat(parts);
}

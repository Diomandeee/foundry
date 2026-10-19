import {lstat} from 'node:fs/promises';
import {basename, join} from 'node:path';
import type {Stats} from 'node:fs';
import {alive, check, CHUNK_BYTES, relative} from './checks';
import {inspectDirectory, inspectFile, readFileChunks, sameFile, siblingNames} from './filesystem';
import type {ManagedRoot} from './types';

export const MAX_BUNDLE_ENTRIES=20000;
export const isBundlePath=(path:string)=>/\.(app|dSYM|xcarchive)$/.test(path);
interface TarEntry {path:string; name:string; kind:'file'|'directory'; stat:Stats; children?:string[]}
export interface BundlePlan {root:ManagedRoot; entries:TarEntry[]; sizeBytes:number; sourceBytes:number}
const rounded=(n:number)=>Math.ceil(n/512)*512;
const ordered=(names:Iterable<string>)=>Array.from(names).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));

/** One POSIX PAX path record per entry: deterministic UTF-8 names, including long
 * paths, without platform encodings, locale ordering, shell, SDK or tar subprocess. */
function paxPath(path:string):Uint8Array {
  const payload=`path=${path}\n`, length=Buffer.byteLength(payload);
  let size=length+2;
  for(;;) {const next=length+String(size).length+1; if(next===size) break; size=next;}
  return Buffer.from(`${size} ${payload}`);
}
function header(name:string,size:number,mode:number,type:'0'|'5'|'x'):Uint8Array {
  const h=Buffer.alloc(512);
  const text=(offset:number,width:number,value:string)=>{const b=Buffer.from(value); check(b.length<=width,'tar-header-field'); h.set(b,offset);};
  const octal=(offset:number,width:number,value:number)=>{check(Number.isSafeInteger(value)&&value>=0,'tar-number'); const s=value.toString(8); check(s.length<width,'tar-number-overflow'); text(offset,width,s.padStart(width-1,'0')+'\0');};
  text(0,100,name); octal(100,8,mode); octal(108,8,0); octal(116,8,0);
  octal(124,12,size); octal(136,12,0); h.fill(32,148,156); text(156,1,type);
  text(257,6,'ustar\0'); text(263,2,'00');
  let checksum=0; for(const byte of h) checksum+=byte;
  text(148,8,checksum.toString(8).padStart(6,'0')+'\0 '); return h;
}

/** Full bounded inventory BEFORE capacity admission or publication. Caller holds the
 * host tree seal. All entries (including directories) share the conservative 20k cap. */
export async function planBundle(root:ManagedRoot,path:string,maxBytes:number,maxEntries:number,signal:AbortSignal):Promise<BundlePlan> {
  check(isBundlePath(path),'bundle-suffix-required'); relative(path);
  check(maxEntries>0&&maxEntries<=MAX_BUNDLE_ENTRIES,'bundle-entry-budget');
  const top=await inspectDirectory(root,path,signal), rootName=basename(path);
  const entries:TarEntry[]=[{path,name:rootName+'/',kind:'directory',stat:top}];
  let sizeBytes=1024,sourceBytes=0;
  const charge=(entry:TarEntry)=>{
    const pax=paxPath(entry.name);
    sizeBytes+=512+rounded(pax.length)+512+(entry.kind==='file'?rounded(entry.stat.size):0);
    check(Number.isSafeInteger(sizeBytes)&&sizeBytes<=maxBytes,'bundle-tar-byte-budget-including-headers');
  };
  charge(entries[0]);
  for(let cursor=0;cursor<entries.length;cursor++) {
    alive(signal); const entry=entries[cursor]; if(entry.kind!=='directory') continue;
    // Inventory each directory once; later file reads need not re-enumerate siblings.
    const children=ordered(await siblingNames(join(root.path,entry.path),signal,maxEntries)); entry.children=children;
    for(const name of children) {
      check(entries.length<maxEntries,'bundle-tree-entry-budget-20000');
      const childPath=entry.path+'/'+name; relative(childPath);
      const stat=await lstat(join(root.path,childPath)); alive(signal);
      check(!stat.isSymbolicLink(),'bundle-symlink-forbidden');
      let child:TarEntry;
      const archiveName=rootName+'/'+childPath.slice(path.length+1);
      if(stat.isDirectory()) child={path:childPath,name:archiveName+'/',kind:'directory',stat:await inspectDirectory(root,childPath,signal,false)};
      else {
        check(stat.isFile(),'bundle-special-file-forbidden');
        const actual=await inspectFile(root,childPath,signal,false); sourceBytes+=actual.size;
        child={path:childPath,name:archiveName,kind:'file',stat:actual};
      }
      check(Number.isSafeInteger(sourceBytes)&&sourceBytes<=maxBytes,'bundle-source-byte-budget');
      charge(child); entries.push(child);
    }
    check(sameFile(entry.stat,await inspectDirectory(root,entry.path,signal,false)),'bundle-directory-changed');
  }
  entries.sort((a,b)=>Buffer.compare(Buffer.from(a.name),Buffer.from(b.name)));
  return {root,entries,sizeBytes,sourceBytes};
}

async function verifyDirectories(plan:BundlePlan,signal:AbortSignal) {
  for(const entry of plan.entries) if(entry.kind==='directory') {
    check(sameFile(entry.stat,await inspectDirectory(plan.root,entry.path,signal,false)),'bundle-directory-changed');
    const names=ordered(await siblingNames(join(plan.root.path,entry.path),signal,MAX_BUNDLE_ENTRIES));
    check(names.length===entry.children!.length&&names.every((n,i)=>n===entry.children![i]),'bundle-membership-changed');
  }
}

/** Streams EXACT planned archive bytes to a bounded chunk accumulator. Actual tar
 * headers, PAX data, padding, file bytes and EOF blocks all contribute to its hash. */
export async function streamBundle(plan:BundlePlan,emit:(bytes:Uint8Array)=>Promise<void>,signal:AbortSignal):Promise<void> {
  await verifyDirectories(plan,signal);
  let emitted=0;
  const send=async(bytes:Uint8Array)=>{alive(signal); emitted+=bytes.length; check(emitted<=plan.sizeBytes,'tar-grew'); await emit(bytes);};
  const pad=async(n:number)=>{const size=rounded(n)-n; if(size) await send(new Uint8Array(size));};
  for(let i=0;i<plan.entries.length;i++) {
    const entry=plan.entries[i], pax=paxPath(entry.name), fallback=`entry-${i}`;
    await send(header(`PaxHeaders/${i}`,pax.length,0o644,'x')); await send(pax); await pad(pax.length);
    const file=entry.kind==='file';
    await send(header(fallback+(file?'':'/'),file?entry.stat.size:0,file?(entry.stat.mode&0o111?0o755:0o644):0o755,file?'0':'5'));
    if(file) {
      await readFileChunks(plan.root,entry.path,entry.stat,CHUNK_BYTES,async bytes=>send(bytes),signal,false);
      await pad(entry.stat.size);
    }
  }
  await send(new Uint8Array(1024)); check(emitted===plan.sizeBytes,'tar-size-mismatch');
  await verifyDirectories(plan,signal);
}

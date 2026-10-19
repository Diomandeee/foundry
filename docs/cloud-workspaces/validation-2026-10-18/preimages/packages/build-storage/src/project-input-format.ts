import {types} from 'node:util';
import * as v from '../../build-jobs/src/validation';
import {canonical, check, CHUNK_BYTES, exactRef, fold, freeze, relative, sha256, snapshot} from './checks';
import type {ApprovedFile, InputApproval, ObjectRef} from './types';

/** Structural ceilings, NEVER namespace admission or evidence of available disk. */
export const PROJECT_INPUT_LIMITS=Object.freeze({maxFiles:8192,maxRequiredInputs:8192,maxSegments:512,
  maxFilesPerSegment:32,maxRequiredPerSegment:32,maxChunksPerSegment:128,maxChunksPerFile:64,
  maxChunks:8192,maxBytes:4*1024**3,maxSegmentBytes:256*1024,maxRootBytes:256*1024,smallFileBytes:32*1024,
  maxPathBytes:4*1024**2,maxPathComponents:65536,maxPathDepth:32,maxDirectoryEntries:20000,
  maxObservedDirectoryEntries:200000,maxDirectoryNameBytes:16*1024**2,maxNamespaces:512});
export interface ProjectInputRange {object:number;offset:number;sizeBytes:number}
export interface ProjectInputFile extends ApprovedFile {
  retention:'retain'; sha256:string; sizeBytes:number; mode:number; chunks:ProjectInputRange[];
}
export interface ProjectInputCounts {files:number;chunks:number;bytes:number;required:number;missing:number}
export interface ProjectInputSegment {
  version:2; kind:'input-segment'; projectId:string; index:number;
  objects:ObjectRef[]; files:ProjectInputFile[]; requiredInputs:string[]; missingInputs:string[];
}
export interface ProjectInputSegmentRef extends ProjectInputCounts {ref:ObjectRef}
export interface ProjectInputSnapshot {
  version:2; kind:'segmented-input'; projectId:string; segments:ProjectInputSegmentRef[];
  totals:ProjectInputCounts; git:InputApproval['git']; historyEvidence:null;
}
export const emptyInputCounts=():ProjectInputCounts=>({files:0,chunks:0,bytes:0,required:0,missing:0});
export function addInputCounts(target:ProjectInputCounts,part:ProjectInputCounts) {
  for(const key of ['files','chunks','bytes','required','missing'] as const) target[key]+=part[key];
  validateInputCounts(target);
}
export function validateInputCounts(c:ProjectInputCounts) {
  v.exact(c,['files','chunks','bytes','required','missing']);
  v.uint(c.files,0,PROJECT_INPUT_LIMITS.maxFiles); v.uint(c.chunks,0,PROJECT_INPUT_LIMITS.maxChunks);
  v.uint(c.bytes,0,PROJECT_INPUT_LIMITS.maxBytes); v.uint(c.required,0,PROJECT_INPUT_LIMITS.maxRequiredInputs); v.uint(c.missing,0,c.required);
}
export function sameInputCounts(a:ProjectInputCounts,b:ProjectInputCounts) {return canonical(a)===canonical(b);}
export function segmentCounts(s:ProjectInputSegment):ProjectInputCounts {
  return {files:s.files.length,chunks:s.objects.length,bytes:s.files.reduce((n,f)=>n+f.sizeBytes,0),required:s.requiredInputs.length,missing:s.missingInputs.length};
}
/** Copy arrays one bounded item at a time, avoiding the legacy single-JSON limit. */
export function copyInputList<T>(value:readonly T[],max:number):T[] {
  check(value!==null&&typeof value==='object'&&!types.isProxy(value)&&Array.isArray(value)&&Object.getPrototypeOf(value)===Array.prototype,'project-input-list');
  const ds=Object.getOwnPropertyDescriptors(value), length=ds.length.value as number;
  check(Number.isSafeInteger(length)&&length<=max&&Reflect.ownKeys(ds).length===length+1,'project-input-list-budget');
  const result:T[]=[];
  for(let i=0;i<length;i++) {const d=ds[String(i)]; check(d&&'value' in d&&d.enumerable,'project-input-list-accessor'); result.push(snapshot(d.value) as T);}
  return result;
}
export function inputRequestFields(value:unknown,keys:readonly string[]):Record<string,unknown> {
  check(value!==null&&typeof value==='object'&&!types.isProxy(value)&&Object.getPrototypeOf(value)===Object.prototype,'project-input-request');
  const ds=Object.getOwnPropertyDescriptors(value);
  check(Reflect.ownKeys(ds).length===keys.length&&keys.every(k=>ds[k]&&'value' in ds[k]&&ds[k].enumerable),'project-input-request-fields');
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
export function validateProjectGit(git:InputApproval['git']) {
  v.exact(git,['remote','revision','historyPreserved']); check(git.historyPreserved===false,'project-history-not-attested');
  if(git.remote!==null) {
    v.text(git.remote,256); check(/^(https:\/\/|ssh:\/\/|git@)/.test(git.remote)&&!/[?#]/.test(git.remote),'git-remote');
    if(!git.remote.startsWith('git@')) {const u=new URL(git.remote); check(!u.password&&(!u.username||u.protocol==='ssh:'),'credential-in-remote');}
  }
  if(git.revision!==null) {v.text(git.revision,64); check(/^[a-f0-9]{40,64}$/.test(git.revision),'git-revision');}
}
/** One bounded index for the whole snapshot, including page boundaries. */
export class ProjectInputPaths {
  private readonly files=new Set<string>();
  private readonly components=new Map<string,string>();
  private bytes=0;
  add(path:string,allowExact=false) {
    relative(path); const key=fold(path), parts=path.split('/');
    check(parts.length<=PROJECT_INPUT_LIMITS.maxPathDepth,'project-path-depth');
    check(!this.files.has(key)||(allowExact&&this.components.get(key)===path),'project-path-collision');
    if(this.files.has(key)) return;
    check(!this.components.has(key),'project-file-directory-collision');
    this.bytes+=Buffer.byteLength(path); check(this.bytes<=PROJECT_INPUT_LIMITS.maxPathBytes,'project-path-byte-budget');
    for(let i=1;i<=parts.length;i++) {
      const prefix=parts.slice(0,i).join('/'), folded=fold(prefix), old=this.components.get(folded);
      check(old===undefined||old===prefix,'project-component-collision');
      if(i<parts.length) check(!this.files.has(folded),'project-file-directory-collision');
      this.components.set(folded,prefix); check(this.components.size<=PROJECT_INPUT_LIMITS.maxPathComponents,'project-component-budget');
    }
    this.files.add(key);
  }
}
export function validateProjectFile(file:ProjectInputFile,objects:ObjectRef[]) {
  v.exact(file,['path','classification','retention','sha256','sizeBytes','mode','chunks']);
  relative(file.path); check(['source-input','source-history'].includes(file.classification)&&file.retention==='retain','project-input-classification');
  v.digest(file.sha256); v.uint(file.sizeBytes,0,PROJECT_INPUT_LIMITS.maxChunksPerFile*CHUNK_BYTES); v.uint(file.mode,0,0o777);
  check((file.mode&0o022)===0&&Array.isArray(file.chunks)&&file.chunks.length===Math.ceil(file.sizeBytes/CHUNK_BYTES),'project-input-file-shape');
  if(!file.sizeBytes) check(file.sha256===sha256(new Uint8Array(0)),'empty-file-digest');
  for(let i=0;i<file.chunks.length;i++) {
    const range=file.chunks[i]; v.exact(range,['object','offset','sizeBytes']); v.uint(range.object,0,objects.length-1);
    v.uint(range.offset,0,CHUNK_BYTES); v.uint(range.sizeBytes,1,CHUNK_BYTES);
    check(range.sizeBytes===Math.min(CHUNK_BYTES,file.sizeBytes-i*CHUNK_BYTES)&&range.offset+range.sizeBytes<=objects[range.object].sizeBytes,'project-input-range-order-size');
  }
}
export function validateProjectSegment(s:ProjectInputSegment,projectId:string,index:number):ProjectInputCounts {
  v.exact(s,['version','kind','projectId','index','objects','files','requiredInputs','missingInputs']);
  check(s.version===2&&s.kind==='input-segment'&&s.projectId===projectId&&s.index===index,'project-segment-binding');
  check(Array.isArray(s.files)&&s.files.length<=PROJECT_INPUT_LIMITS.maxFilesPerSegment&&Array.isArray(s.requiredInputs)&&
    s.requiredInputs.length<=PROJECT_INPUT_LIMITS.maxRequiredPerSegment&&Array.isArray(s.missingInputs)&&s.missingInputs.length<=s.requiredInputs.length,'project-segment-shape');
  check(s.files.length+s.requiredInputs.length>0,'empty-project-segment');
  check(Array.isArray(s.objects)&&s.objects.length<=PROJECT_INPUT_LIMITS.maxChunksPerSegment,'project-segment-objects');
  s.objects.forEach(ref=>exactRef(ref,projectId,'objects'));
  s.files.forEach(f=>validateProjectFile(f,s.objects)); s.requiredInputs.forEach(relative); s.missingInputs.forEach(relative);
  const ranges=s.objects.map(()=>[] as {offset:number;sizeBytes:number}[]); let rangeCount=0;
  for(const file of s.files) for(const range of file.chunks) {ranges[range.object].push(range); rangeCount++;}
  check(rangeCount<=PROJECT_INPUT_LIMITS.maxChunksPerSegment+PROJECT_INPUT_LIMITS.maxFilesPerSegment,'project-segment-range-budget');
  // Every byte in a data blob belongs to exactly one selected file; no hidden tail,
  // overlap, gap or unused object. File range order independently fixes file bytes.
  ranges.forEach((list,index)=>{let offset=0; list.sort((a,b)=>a.offset-b.offset);
    for(const range of list) {check(range.offset===offset,'project-data-range-overlap-or-gap'); offset+=range.sizeBytes;}
    check(offset===s.objects[index].sizeBytes,'project-data-object-coverage');});
  const counts=segmentCounts(s); validateInputCounts(counts); check(counts.chunks<=PROJECT_INPUT_LIMITS.maxChunksPerSegment,'project-segment-chunks'); return counts;
}
export function validateProjectRoot(root:ProjectInputSnapshot) {
  v.exact(root,['version','kind','projectId','segments','totals','git','historyEvidence']);
  check(root.version===2&&root.kind==='segmented-input'&&root.historyEvidence===null,'project-root-version'); v.id(root.projectId); validateProjectGit(root.git);
  check(Array.isArray(root.segments)&&root.segments.length>0&&root.segments.length<=PROJECT_INPUT_LIMITS.maxSegments,'project-root-segments');
  validateInputCounts(root.totals); check(root.totals.files>0,'empty-project-snapshot');
  const total=emptyInputCounts(), refs=new Set<string>();
  for(const page of root.segments) {
    v.exact(page,['ref','files','chunks','bytes','required','missing']); const {ref,...counts}=page; validateInputCounts(counts);
    exactRef(ref,root.projectId,'manifests'); check(ref.sizeBytes<=PROJECT_INPUT_LIMITS.maxSegmentBytes&&!refs.has(ref.objectKey),'project-page-ref'); refs.add(ref.objectKey);
    check(counts.files<=PROJECT_INPUT_LIMITS.maxFilesPerSegment&&counts.required<=PROJECT_INPUT_LIMITS.maxRequiredPerSegment&&
      counts.chunks<=PROJECT_INPUT_LIMITS.maxChunksPerSegment&&counts.files+counts.required>0,'project-page-summary'); addInputCounts(total,counts);
  }
  check(sameInputCounts(total,root.totals),'project-root-totals');
}
export function projectMetadataBytes(value:unknown,kind:'root'|'segment'):Uint8Array {
  const bytes=Buffer.from(canonical(value)); check(bytes.length>0&&bytes.length<=(kind==='root'?PROJECT_INPUT_LIMITS.maxRootBytes:PROJECT_INPUT_LIMITS.maxSegmentBytes),'project-metadata-byte-budget'); return bytes;
}
export function decodeProjectMetadata<T>(bytes:Uint8Array,kind:'root'|'segment'):T {
  check(bytes.length>0&&bytes.length<=(kind==='root'?PROJECT_INPUT_LIMITS.maxRootBytes:PROJECT_INPUT_LIMITS.maxSegmentBytes),'project-metadata-byte-budget');
  return freeze(snapshot(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))) as T);
}
/** Retains only bounded path sets/counters, never all project file descriptors. */
export class ProjectInputValidation {
  private readonly paths=new ProjectInputPaths();
  readonly selected=new Set<string>(); readonly required=new Set<string>(); readonly missing=new Set<string>();
  private readonly total=emptyInputCounts(); private index=0;
  constructor(private readonly root:ProjectInputSnapshot) {validateProjectRoot(root);}
  accept(segment:ProjectInputSegment) {
    const counts=validateProjectSegment(segment,this.root.projectId,this.index), {ref,...summary}=this.root.segments[this.index];
    check(sameInputCounts(counts,summary),'project-segment-summary');
    for(const f of segment.files) {check(!this.selected.has(f.path),'duplicate-project-file'); this.paths.add(f.path,true); this.selected.add(f.path);}
    for(const p of segment.requiredInputs) {check(!this.required.has(p),'duplicate-required-input'); this.paths.add(p,true); this.required.add(p);}
    for(const p of segment.missingInputs) {check(segment.requiredInputs.includes(p)&&!this.missing.has(p),'project-missing-input-list'); this.missing.add(p);}
    addInputCounts(this.total,counts); this.index++;
  }
  finish(requireComplete:boolean) {
    check(this.index===this.root.segments.length&&sameInputCounts(this.total,this.root.totals),'project-segment-set-incomplete');
    for(const p of this.required) check(this.missing.has(p)===!this.selected.has(p),'project-missing-input-mismatch');
    if(requireComplete) check(this.missing.size===0,'snapshot-incomplete');
  }
}

import {join} from 'node:path';
import {check} from './checks';
import {inspectFile, siblingNames} from './filesystem';
import {PROJECT_INPUT_LIMITS as L} from './project-input-format';
import type {ManagedRoot} from './types';

/** Names only along explicitly selected paths, cached only while the caller holds
 * the exclusive tree seal. No recursive content discovery or secret scanning. */
export class ProjectInputTree {
  private readonly cache=new Map<string,Set<string>>(); private entries=0; private bytes=0;
  constructor(private readonly signal:AbortSignal) {}
  private debit(name:string) {this.entries++; this.bytes+=Buffer.byteLength(name);
    check(this.entries<=L.maxObservedDirectoryEntries&&this.bytes<=L.maxDirectoryNameBytes,'project-directory-metadata-budget');}
  async names(parent:string) {
    let names=this.cache.get(parent);
    if(!names) {
      check(this.cache.size<L.maxPathComponents,'project-directory-count-budget');
      names=await siblingNames(parent,this.signal,L.maxDirectoryEntries); for(const name of names) this.debit(name);
      this.cache.set(parent,names);
    }
    return names;
  }
  created(parent:string,name:string) {this.debit(name); const names=this.cache.get(parent); check(names,'project-directory-not-inventoried'); names.add(name);}
  async inspect(root:ManagedRoot,path:string) {
    // Validate ancestors/types/devices BEFORE enumerating a selected descendant.
    // The held seal then makes those checks stable during the names-only walk.
    const stat=await inspectFile(root,path,this.signal,false); let parent=root.path;
    for(const part of path.split('/')) {check((await this.names(parent)).has(part),'file-missing-or-name-mismatch'); parent=join(parent,part);}
    return stat;
  }
}

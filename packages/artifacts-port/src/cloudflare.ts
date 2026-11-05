// CloudflareAdapter — ArtifactsPort over the real Artifacts binding.
// Written against the Workers-binding docs; INTEGRATION-TESTED ONLY AFTER
// the Paid plan lands (spike). Logic must not depend on binding-specific
// behavior beyond this file.
import {
  UnsupportedContentError,
  type ArtifactsPort,
  type CommitInfo,
  type CreatedRepo,
  type CreateOpts,
  type ForkResult,
  type RepoHandle,
} from "./port.js";

type Binding = any; // narrowed by worker-configuration.d.ts at deploy time
type RepoBinding = any;

/** Changed paths between two trees, compared by object id (review M7). Only
 * subtrees whose ids differ are read, so cost follows the size of the change,
 * not of the repository. A budget overrun or a missing/invalid tree throws:
 * uncertainty, never a truncated complete diff. */
const DIFF_ENTRY_BUDGET = 20000;
const DIFF_PATH_BUDGET = 5000;
/** What a non-tree entry is when it is not a regular or executable file; null when it is one. Modes may come
 * as octal text or as a number. */
function unsupportedKind(e:{type:string,mode:unknown}):string|null{
  const mode=typeof e.mode==='number'?e.mode.toString(8):String(e.mode);
  if(e.type==='symlink'||mode==='120000')return 'symlink';
  if(e.type==='gitlink'||e.type==='commit'||mode==='160000')return 'submodule';
  return mode==='100644'||mode==='100755'?null:`mode ${mode}`;
}
async function diffTrees(binding:RepoBinding, mine:string|null, theirs:string|null):Promise<{paths:string[],unsupported:Record<string,string>}> {
  const out:string[]=[];const unsupported:Record<string,string>=Object.create(null);let visited=0;
  async function read(hash:string|null):Promise<Map<string,{hash:string,type:string,mode:unknown}>>{
    const m=new Map<string,{hash:string,type:string,mode:unknown}>();
    if(hash===null)return m;
    const entries=await binding.readTree(hash);
    if(!Array.isArray(entries))throw new Error('artifacts: missing tree');
    for(const e of entries){
      if(++visited>DIFF_ENTRY_BUDGET)throw new Error('artifacts: tree budget');
      if(typeof e.name!=='string'||!e.name||/[\/\x00-\x1f\x7f]/.test(e.name)||['.','..'].includes(e.name)||
        m.has(e.name)||!/^[a-f0-9]{40}$/.test(e.hash)||e.mode===undefined)
        throw new Error('artifacts: incomplete or invalid tree');
      m.set(e.name,{hash:e.hash,type:e.type,mode:e.mode});
    }
    return m;
  }
  function add(path:string){if(out.length>=DIFF_PATH_BUDGET)throw new Error('artifacts: diff budget');out.push(path);}
  async function walk(a:string|null,b:string|null,prefix:string,depth:number):Promise<void>{
    if(depth>64)throw new Error('artifacts: tree budget');
    if(a===b)return;
    const [ma,mb]=await Promise.all([read(a),read(b)]);
    for(const name of new Set([...ma.keys(),...mb.keys()])){
      const ea=ma.get(name),eb=mb.get(name);const path=prefix?`${prefix}/${name}`:name;
      if(ea&&eb&&ea.hash===eb.hash&&ea.type===eb.type&&ea.mode===eb.mode)continue;
      const ta=ea?.type==='tree'?ea.hash:null,tb=eb?.type==='tree'?eb.hash:null;
      if(ta!==null||tb!==null)await walk(ta,tb,path,depth+1);
      // A non-tree entry on either side is a changed file path (added, removed, edited, or tree<->file).
      if((ea&&ea.type!=='tree')||(eb&&eb.type!=='tree'))add(path);
      const kind=ea&&ea.type!=='tree'?unsupportedKind(ea):null;
      if(kind)unsupported[path]=kind;
    }
  }
  await walk(mine,theirs,'',0);
  return {paths:out.sort(),unsupported};
}
async function diffFiles(binding:RepoBinding,c:any):Promise<{paths:string[],unsupported:Record<string,string>}>{
  if(!Array.isArray(c.parents))throw new Error('artifacts: parent metadata');
  let parentTree:string|null=null;
  if(c.parents.length){
    const parent=await binding.readCommit(c.parents[0]);
    if(!parent)throw new Error('artifacts: missing parent');
    parentTree=parent.treeHash;
  }
  return diffTrees(binding,c.treeHash,parentTree);
}

function toHandle(
  binding: RepoBinding,
  meta: CreatedRepo | ForkResult,
): RepoHandle {
  return {
    name: meta.name,
    remote: meta.remote,
    defaultBranch: (meta as CreatedRepo).defaultBranch ?? "main",
    async info() {
      const i = await binding.info();
      return {
        defaultBranch: i.defaultBranch ?? "main",
        lastPushAt: i.lastPushAt ?? null,
      };
    },
    async readFile(ref: string, filePath: string) {
      const blob=await binding.readFile({ref,path:filePath});
      if(blob===null)return null; // Documented positive absence; exceptions propagate.
      if(!blob)throw new Error('artifacts: file unavailable');
      if(blob.size>8*1048576)throw new UnsupportedContentError(filePath,`is ${(blob.size/1048576).toFixed(1)} MiB, over the 8 MiB cap`);
      const bytes=await blob.arrayBuffer();
      try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}
      catch{throw new UnsupportedContentError(filePath,'is not UTF-8 text');}
    },
    async history(ref: string, limit = 50): Promise<CommitInfo[]> {
      // Real binding: log(), not history(). Commit metadata carries no file
      // list, so changed paths come from a tree diff against the first
      // parent (bounded: newest FILES_CAP commits; older entries omit files
      // and the gate treats unknown paths as conflict — safe default).
      const FILES_CAP = 25;
      // Binding documents an empty array for an unresolved ref. Do not infer
      // absence from error text: deleted repository, outage and auth errors throw.
      const commits=await binding.log({ref,limit});
      if(!Array.isArray(commits))throw new Error('artifacts: history unavailable');
      const out: CommitInfo[] = [];
      for (const c of commits ?? []) {
        const sha: string = c.hash ?? "";
        const info: CommitInfo = {
          sha,
          message: c.message ?? "",
          author: c.author?.name ?? "",
          date: c.authoredAt
            ? new Date(c.authoredAt * 1000).toISOString() : "",
          parents: c.parents ?? [],
        };
        if (out.length < FILES_CAP && sha) {
          try {
            const d = await diffFiles(binding, c);
            info.files = d.paths;
            if (Object.keys(d.unsupported).length) info.unsupported = d.unsupported;
          } catch {
            info.files = undefined;
          }
        }
        out.push(info);
      }
      return out;
    },
    async createToken(scope: "read" | "write", ttlSecs: number) {
      const r = await binding.createToken(scope, ttlSecs);
      // Binding returns {id, plaintext, scope, expiresAt}; the merge
      // transport needs the bare secret. Pass strings through (fake-compat).
      return typeof r === "string" ? r : (r?.plaintext ?? r?.token ?? "");
    },
    async fork(newName: string): Promise<ForkResult> {
      const f = await binding.fork(newName);
      return { name: f.name, remote: f.remote, token: f.token };
    },
    dispose() {
      binding[Symbol.dispose]?.();
    },
  };
}

export function cloudflarePort(env: { ARTIFACTS: unknown }): ArtifactsPort {
  const ARTIFACTS: Binding = env.ARTIFACTS;
  return {
    async create(name: string, opts: CreateOpts = {}): Promise<CreatedRepo> {
      const r = await ARTIFACTS.create(name, {
        description: opts.description,
        setDefaultBranch: opts.defaultBranch,
      });
      return {
        name: r.name,
        remote: r.remote,
        defaultBranch: r.defaultBranch,
        token: r.token,
      };
    },
    async get(name: string): Promise<RepoHandle> {
      const repo: RepoBinding = await ARTIFACTS.get(name);
      const i = await repo.info();
      return toHandle(repo, {
        name,
        remote: i.remote,
        defaultBranch: i.defaultBranch,
        token: "",
      });
    },
    async list(): Promise<string[]> {
      const repos = await ARTIFACTS.list();
      return (repos ?? []).map((r: any) => r.name ?? r);
    },
    async delete(name: string): Promise<void> {
      await ARTIFACTS.delete(name);
    },
  };
}

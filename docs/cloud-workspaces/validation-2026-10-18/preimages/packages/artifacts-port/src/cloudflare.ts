// CloudflareAdapter — ArtifactsPort over the real Artifacts binding.
// Written against the Workers-binding docs; INTEGRATION-TESTED ONLY AFTER
// the Paid plan lands (spike). Logic must not depend on binding-specific
// behavior beyond this file.
import type {
  ArtifactsPort,
  CommitInfo,
  CreatedRepo,
  CreateOpts,
  ForkResult,
  RepoHandle,
} from "./port.js";

type Binding = any; // narrowed by worker-configuration.d.ts at deploy time
type RepoBinding = any;

/** Complete bounded path -> object/type/mode inventory. A bound or missing
 * object is uncertainty, never a truncated complete diff. */
async function treeEntries(binding:RepoBinding, treeHash:string):Promise<Map<string,string>> {
  const out=new Map<string,string>();let visited=0;
  async function walk(hash:string,prefix:string,depth:number):Promise<void>{
    if(depth>64||++visited>4000)throw new Error('artifacts: tree budget');
    const entries=await binding.readTree(hash);
    if(!Array.isArray(entries))throw new Error('artifacts: missing tree');
    const names=new Set<string>();
    for(const e of entries){
      if(++visited>4000||typeof e.name!=='string'||!e.name||/[\/\x00-\x1f\x7f]/.test(e.name)||
        ['.','..'].includes(e.name)||names.has(e.name)||!/^[a-f0-9]{40}$/.test(e.hash)||e.mode===undefined)
        throw new Error('artifacts: incomplete or invalid tree');
      names.add(e.name);const path=prefix?`${prefix}/${e.name}`:e.name;
      if(e.type==='tree')await walk(e.hash,path,depth+1);
      else {if(out.size>=2000)throw new Error('artifacts: file budget');out.set(path,JSON.stringify([e.hash,e.type,e.mode]));}
    }
  }
  await walk(treeHash,'',0);return out;
}
async function diffFiles(binding:RepoBinding,c:any):Promise<string[]>{
  if(!Array.isArray(c.parents))throw new Error('artifacts: parent metadata');
  const mine=await treeEntries(binding,c.treeHash);
  let theirs=new Map<string,string>();
  if(c.parents.length){
    const parent=await binding.readCommit(c.parents[0]);
    if(!parent)throw new Error('artifacts: missing parent');
    theirs=await treeEntries(binding,parent.treeHash);
  }
  const paths=new Set([...mine.keys(),...theirs.keys()]);
  return [...paths].filter(p=>mine.get(p)!==theirs.get(p)).sort();
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
      if(!blob||blob.size>8*1048576)throw new Error('artifacts: file unavailable or oversized');
      return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await blob.arrayBuffer());
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
            info.files = await diffFiles(binding, c);
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

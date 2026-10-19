// Merge execution. IsomorphicMerger works against real git remotes over http
// (production; logic-tested in Node with real repos; Worker-fs wiring
// verified at spike). GitMerger (true-history merge over local git) lives in
// @foundry/artifacts-port alongside the node-only GitAdapter.
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import {
  StaleBaseError,
  type MergeRequest,
  type Merger,
} from "@foundry/artifacts-port";

export type { MergeRequest, Merger };

export function tokenSecret(token: string): string {
  return token.split("?expires=")[0];
}

type GitFS=Parameters<typeof git.clone>[0]['fs'];
async function completeTree(fs:GitFS,dir:string,oid:string|undefined):Promise<Map<string,string>>{
  const result=new Map<string,string>();let visited=0;
  if(!oid)return result;
  async function walk(hash:string,prefix:string,depth:number):Promise<void>{
    if(depth>64||++visited>40000)throw new Error('merge: tree budget');
    const {tree}=await git.readTree({fs,dir,oid:hash});
    for(const entry of tree){
      if(++visited>40000||!entry.path||/[\/\x00-\x1f\x7f]/.test(entry.path)||['.','..'].includes(entry.path))throw new Error('merge: invalid tree entry');
      const path=prefix?`${prefix}/${entry.path}`:entry.path;
      if(entry.type==='tree')await walk(entry.oid,path,depth+1);
      else{if(result.size>=20000||result.has(path))throw new Error('merge: incomplete tree');result.set(path,`${entry.mode} ${entry.type} ${entry.oid}`);}
    }
  }
  await walk(oid,'',0);return result;
}
function equalTrees(a:Map<string,string>,b:Map<string,string>):boolean{
  return a.size===b.size&&[...a].every(([p,e])=>b.get(p)===e);
}
function mergePath(path:string):void{
  if(!path||path.startsWith('/')||/[\\\x00-\x1f\x7f]/.test(path)||
    path.split('/').some(p=>!p||p==='.'||p==='..'||p.toLowerCase()==='.git'))throw new Error('merge: unsafe path');
}
async function admissionOverlay(base:Map<string,string>,proposal:Map<string,string>,req:MergeRequest):Promise<Map<string,string>>{
  const expected=new Map(base);
  for(const [path,content] of Object.entries(req.files)){
    mergePath(path);
    // The current admission port transports text. Refuse executable/symlink/gitlink
    // or non-roundtripping bytes rather than quietly changing their representation.
    const {oid}=await git.hashBlob({object:new TextEncoder().encode(content)});
    const entry=`100644 blob ${oid}`;
    if(proposal.get(path)!==entry)throw new Error('merge: unsupported or substituted proposal entry');
    const old=base.get(path);if(old&&!old.startsWith('100644 blob '))throw new Error('merge: unsupported destination entry');
    const parts=path.split('/');for(let i=1;i<parts.length;i++)if(base.has(parts.slice(0,i).join('/')))throw new Error('merge: destination ancestor is not directory');
    expected.set(path,entry);
  }
  for(const path of req.deletedFiles){mergePath(path);if(proposal.has(path)||Object.hasOwn(req.files,path))throw new Error('merge: deletion not absent');expected.delete(path);}
  return expected;
}

export class IsomorphicMerger implements Merger {
  /**
   * fs is injected: memfs in Workers, node:fs in tests.
   * workdirBase must be writable by fs (memfs root vs a tmp dir).
   */
  constructor(
    private fs: unknown,
    private workdirBase = "/merge",
  ) {}

  async merge(req: MergeRequest): Promise<string> {
    const fs = this.fs as Parameters<typeof git.clone>[0]["fs"];
    const dir = `${this.workdirBase}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const workDir = dir;
    const onAuth = () => ({ username: "x", password: tokenSecret(req.baseToken) });
    if(!/^[a-f0-9]{40}$/.test(req.forkHeadSha)||req.expectedBaseSha&&!/^[a-f0-9]{40}$/.test(req.expectedBaseSha))throw new Error('merge: commit identity');
    const refs=await git.listServerRefs({http,url:req.baseRemote,onAuth});
    const destination=refs.find(r=>r.ref===`refs/heads/${req.baseBranch}`);
    if(req.expectedBaseSha?destination?.oid!==req.expectedBaseSha:refs.length!==0)throw new StaleBaseError('destination changed or genesis is not empty');
    if(req.expectedBaseSha){
      await git.clone({fs,http,dir,url:req.baseRemote,ref:req.baseBranch,singleBranch:true,depth:50,onAuth});
    }else{
      await git.init({fs,dir,defaultBranch:req.baseBranch});
      await git.addRemote({fs,dir,remote:'origin',url:req.baseRemote});
    }
    // Fetch the proposal independently with its own read credential. Every
    // admitted byte/mode is checked against immutable objects before any write.
    const proposalDir=`${dir}-proposal`;
    await git.clone({fs,http,dir:proposalDir,url:req.forkRemote,ref:req.forkBranch??req.forkHeadSha,
      singleBranch:true,depth:1,noCheckout:true,onAuth:()=>({username:'x',password:tokenSecret(req.forkToken)})});
    const proposalHead=await git.resolveRef({fs,dir:proposalDir,ref:'HEAD'});
    if(proposalHead!==req.forkHeadSha)throw new Error('merge: proposal moved');
    const proposal=await completeTree(fs,proposalDir,proposalHead);
    const base=await completeTree(fs,dir,req.expectedBaseSha);
    const expected=await admissionOverlay(base,proposal,req);
    if(req.expectedBaseSha){
      const prior=await git.readCommit({fs,dir,oid:req.expectedBaseSha});
      if(prior.commit.parent.length<=1&&prior.commit.message.split('\n').includes(`Fork-Head: ${req.forkHeadSha}`)){
        const before=await completeTree(fs,dir,prior.commit.parent[0]);
        if(equalTrees(base,await admissionOverlay(before,proposal,req)))return req.expectedBaseSha;
        throw new Error('merge: ambiguous replay');
      }
    }
    // Refuse to land a decision made against a base that has since moved;
    // the caller re-decides against the new head.
    if (req.expectedBaseSha) {
      const head = await git.resolveRef({ fs, dir, ref: "HEAD" });
      if (head !== req.expectedBaseSha) {
        throw new StaleBaseError(
          `base moved ${req.expectedBaseSha.slice(0, 8)} -> ${head.slice(0, 8)}`,
        );
      }
    }
    let sha: string;
    try {
      sha = await commitForkFiles(
        this.fs,
        workDir,
        req.files,
        req.message,
        req.author,
        req.forkHeadSha,
        req.deletedFiles ?? [],
      );
    } catch (e) {
      throw new Error(
        `merge:commit: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const landed=await git.readCommit({fs,dir:workDir,oid:sha});
    const parents=req.expectedBaseSha?[req.expectedBaseSha]:[];
    if(JSON.stringify(landed.commit.parent)!==JSON.stringify(parents))throw new Error('merge: landed parent contract');
    if(!equalTrees(await completeTree(fs,workDir,sha),expected))throw new Error('merge: landed bytes/modes/kinds differ from admission');
    // Re-observe just before push. Git receive-pack still owns the ref CAS; no
    // force push is requested, and a racing update must remain an integration test.
    const current=await git.listServerRefs({http,url:req.baseRemote,onAuth});
    const currentHead=current.find(r=>r.ref===`refs/heads/${req.baseBranch}`)?.oid;
    if(currentHead!==req.expectedBaseSha)throw new StaleBaseError('destination changed before push');
    try {
      const pushed=await git.push({
        fs,
        http,
        dir: workDir,
        url: req.baseRemote,
        ref: req.baseBranch,
        remoteRef: `refs/heads/${req.baseBranch}`,
        onAuth,
      });
      if(!pushed.ok||pushed.refs[`refs/heads/${req.baseBranch}`]?.ok!==true)throw new Error("merge: destination update not acknowledged");
    } catch (e) {
      throw new Error(
        `merge:push: ${req.baseBranch} -> ${req.baseName}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    return sha;
  }
}

/**
 * Write fork files + squash-commit onto a checked-out base. Split out so the
 * merge logic is unit-testable; clone/push transport is verified at spike.
 * Squash-style: fork files as one commit on base. True 2-parent merges are
 * future work; conflicts route to the resolver regardless.
 */
export async function commitForkFiles(
  fsInput: unknown,
  dir: string,
  files: Record<string, string>,
  message: string,
  author: string,
  forkHeadSha: string,
  deletedFiles: string[] = [],
): Promise<string> {
  const fs = fsInput as Parameters<typeof git.clone>[0]["fs"];
  const promises = (fs as unknown as { promises: {
    mkdir(p: string, o?: object): Promise<unknown>;
    writeFile(p: string, c: string): Promise<void>;
  } }).promises;
  for (const [name, content] of Object.entries(files)) {
    mergePath(name);
    const fp = `${dir}/${name}`;
    const slash = fp.lastIndexOf("/");
    if (slash > 0) await promises.mkdir(fp.slice(0, slash), { recursive: true });
    await promises.writeFile(fp, content);
    await git.add({ fs, dir, filepath: name });
  }
  for (const name of deletedFiles) {
    // Absent on both sides (created-then-deleted on the fork) is a no-op.
    mergePath(name);
    const tracked=await git.listFiles({fs,dir});
    if(tracked.includes(name))await git.remove({fs,dir,filepath:name});
  }
  // Replay is proven by the caller against parents and whole-tree content.
  // An unchanged worktree alone is not replay evidence.
  const matrix = await git.statusMatrix({ fs, dir });
  const dirty = matrix.some(
    ([, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1),
  );
  if (!dirty) throw new Error("merge: no changed tree and no proven replay");
  return git.commit({
    fs,
    dir,
    message: `${message}\n\nFork-Head: ${forkHeadSha}`,
    author: { name: author, email: "foundry@local" },
  });
}

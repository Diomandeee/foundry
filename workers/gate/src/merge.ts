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
/** Every blob path in a tree as `mode type oid`. Exported for tests. */
export async function completeTree(fs:GitFS,dir:string,oid:string|undefined):Promise<Map<string,string>>{
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
/** The tree a merge must land: base plus the admitted change. Exported for tests. */
export async function admissionOverlay(base:Map<string,string>,proposal:Map<string,string>,req:Pick<MergeRequest,'files'|'deletedFiles'>):Promise<Map<string,string>>{
  const expected=new Map(base);
  // Deletions first, as the merger applies them, so a file -> directory change (or back) is admissible.
  for(const path of req.deletedFiles){mergePath(path);if(proposal.has(path)||Object.hasOwn(req.files,path))throw new Error('merge: deletion not absent');expected.delete(path);}
  for(const [path,content] of Object.entries(req.files)){
    mergePath(path);
    // The current admission port transports text: a regular file, executable or not. Refuse
    // symlink/gitlink or non-roundtripping bytes rather than quietly changing their representation.
    const {oid}=await git.hashBlob({object:new TextEncoder().encode(content)});
    const entry=proposal.get(path);
    if(entry!==`100644 blob ${oid}`&&entry!==`100755 blob ${oid}`)throw new Error('merge: unsupported or substituted proposal entry');
    const old=expected.get(path);if(old&&!/^100(644|755) blob /.test(old))throw new Error('merge: unsupported destination entry');
    expected.set(path,entry);
  }
  // A path is a file or a directory, never both.
  for(const path of expected.keys()){const parts=path.split('/');for(let i=1;i<parts.length;i++)if(expected.has(parts.slice(0,i).join('/')))throw new Error('merge: destination ancestor is not directory');}
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
    // File modes travel with the proposal's immutable objects, not with the admitted
    // text: read them from the proposal fetched above so an executable stays executable.
    const modes = await proposalModes(this.fs, proposalDir, proposalHead, req.files);
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
        modes,
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
  modes: Record<string, FileMode> = {},
): Promise<string> {
  const fs = fsInput as Parameters<typeof git.clone>[0]["fs"];
  const promises = (fs as unknown as { promises: {
    mkdir(p: string, o?: object): Promise<unknown>;
    writeFile(p: string, c: string): Promise<void>;
    chmod(p: string, m: number): Promise<void>;
    unlink(p: string): Promise<void>;
    rmdir(p: string): Promise<void>;
  } }).promises;
  // Deletions first, from the index and the working tree, so a fork that turns file `a` into directory
  // `a/` (or back) can write its new path. Emptied parent directories go too.
  for (const name of deletedFiles) {
    mergePath(name);
    // Absent on both sides (created-then-deleted on the fork) is a no-op: remove does not throw for a
    // path the index lacks, and a missing working file is the same absence.
    await git.remove({ fs, dir, filepath: name });
    await promises.unlink(`${dir}/${name}`).catch((e: { code?: string }) => {
      if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR") throw e;
    });
    for (let d = name.slice(0, Math.max(0, name.lastIndexOf("/"))); d; d = d.slice(0, Math.max(0, d.lastIndexOf("/")))) {
      if (!(await promises.rmdir(`${dir}/${d}`).then(() => true, () => false))) break;
    }
  }
  for (const [name, content] of Object.entries(files)) {
    mergePath(name);
    const fp = `${dir}/${name}`;
    const slash = fp.lastIndexOf("/");
    if (slash > 0) await promises.mkdir(fp.slice(0, slash), { recursive: true });
    await promises.writeFile(fp, content);
    // Explicit either way: an edited file must not keep a stale bit from the base checkout.
    await promises.chmod(fp, modes[name] === "100755" ? 0o755 : 0o644);
    // force: the admitted set is the gate's decision, not the base's .gitignore. Without it isomorphic-git
    // skipped every untracked path its ignore check matched, and that check misreads allowlist rules
    // (`/*` then `!/scripts/`): epoch-live 562/590/600 merged with all their new nested files missing.
    await git.add({ fs, dir, filepath: name, force: true });
  }
  // Replay is proven by the caller against parents and whole-tree content.
  // An unchanged worktree alone is not replay evidence.
  // statusMatrix compares content only, so a mode-only change (chmod +x) would read
  // as clean. Compare each admitted path's mode too.
  const matrix = await git.statusMatrix({ fs, dir });
  let dirty = matrix.some(
    ([, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1),
  );
  if (!dirty && Object.keys(files).length) {
    const head = await git.resolveRef({ fs, dir, ref: "HEAD" }).catch(() => null);
    const entryAt = head ? await treeEntries(fs, dir, head) : null;
    for (const name of Object.keys(files)) {
      const e = entryAt ? await entryAt(name) : undefined;
      if (e?.type !== "blob" || e.mode !== (modes[name] ?? "100644")) { dirty = true; break; }
    }
  }
  if (!dirty) throw new Error("merge: no changed tree and no proven replay");
  const sha = await git.commit({
    fs,
    dir,
    message: `${message}\n\nFork-Head: ${forkHeadSha}`,
    author: { name: author, email: "foundry@local" },
  });
  // A merge is reported only for a commit that holds exactly what was admitted.
  await assertLanded(fs, dir, sha, files, deletedFiles, modes);
  return sha;
}

/**
 * Throws unless commit `sha` carries every admitted file as its exact blob and mode and none of the
 * deletions. The merger staged through a working tree whose rules can skip a path in silence; this
 * check reads the commit itself, so such a skip refuses the push instead of recording a merge.
 */
export async function assertLanded(
  fsInput: unknown,
  dir: string,
  sha: string,
  files: Record<string, string>,
  deletedFiles: string[],
  modes: Record<string, FileMode>,
): Promise<void> {
  // Path lookups, not a whole-tree walk: the cost follows the change, not the base.
  const entryAt = await treeEntries(fsInput, dir, sha);
  const wrong: string[] = [];
  for (const [path, content] of Object.entries(files)) {
    const got = await entryAt(path);
    if (!got || got.type !== "blob") { wrong.push(`${path} absent`); continue; }
    const { oid } = await git.hashBlob({ object: new TextEncoder().encode(content) });
    if (got.oid !== oid) wrong.push(`${path} blob ${got.oid.slice(0, 8)} != ${oid.slice(0, 8)}`);
    const mode = modes[path] ?? "100644";
    if (got.mode !== mode) wrong.push(`${path} mode ${got.mode} != ${mode}`);
  }
  for (const path of deletedFiles) {
    // A directory now at a deleted file's path is the fork's file -> directory change, not the old file.
    if (((await entryAt(path))?.type ?? "tree") !== "tree") wrong.push(`${path} still present`);
  }
  if (wrong.length) {
    throw new Error(`merge: commit ${sha.slice(0, 8)} does not hold the admitted change: ${wrong.join("; ")}`);
  }
}

type TreeEntry = { mode: string; oid: string; type: string };

/** Entry lookup by path in commit `commitSha`, reading (and caching) only the directories on the way. */
async function treeEntries(
  fsInput: unknown,
  dir: string,
  commitSha: string,
): Promise<(path: string) => Promise<TreeEntry | undefined>> {
  const fs = fsInput as Parameters<typeof git.clone>[0]["fs"];
  const { commit } = await git.readCommit({ fs, dir, oid: commitSha });
  const trees = new Map<string, Map<string, TreeEntry> | null>();
  async function entries(path: string): Promise<Map<string, TreeEntry> | null> {
    const hit = trees.get(path);
    if (hit !== undefined) return hit;
    let oid = commit.tree;
    if (path) {
      const parent = await entries(path.slice(0, Math.max(0, path.lastIndexOf("/"))));
      const e = parent?.get(path.slice(path.lastIndexOf("/") + 1));
      if (!e || e.type !== "tree") {
        trees.set(path, null);
        return null;
      }
      oid = e.oid;
    }
    const { tree } = await git.readTree({ fs, dir, oid });
    const m = new Map(tree.map((e) => [e.path, { mode: e.mode, oid: e.oid, type: e.type }]));
    trees.set(path, m);
    return m;
  }
  return async (path: string) => {
    const slash = path.lastIndexOf("/");
    return (await entries(slash < 0 ? "" : path.slice(0, slash)))?.get(path.slice(slash + 1));
  };
}

export type FileMode = "100644" | "100755";

/**
 * Mode of every admitted path in the proposal commit. The admitted text must be
 * exactly the proposal's blob; symlinks, submodules and anything else the text
 * transport cannot carry are refused rather than landed as regular files.
 */
export async function proposalModes(
  fsInput: unknown,
  dir: string,
  commitSha: string,
  files: Record<string, string>,
): Promise<Record<string, FileMode>> {
  const entryAt = await treeEntries(fsInput, dir, commitSha);
  const out: Record<string, FileMode> = {};
  for (const [path, content] of Object.entries(files)) {
    const e = await entryAt(path);
    if (!e || e.type !== "blob" || (e.mode !== "100644" && e.mode !== "100755")) {
      throw new Error(`merge: unsupported proposal entry ${path} (${e ? e.mode : "absent"})`);
    }
    const { oid } = await git.hashBlob({ object: new TextEncoder().encode(content) });
    if (oid !== e.oid) throw new Error(`merge: admitted text differs from proposal blob ${path}`);
    out[path] = e.mode;
  }
  return out;
}

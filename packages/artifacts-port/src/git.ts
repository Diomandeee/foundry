// GitAdapter — REAL git backend for ArtifactsPort (node-only: shells out to
// the git CLI). Repos are bare dirs (<name>.git) under rootDir; agents use
// stock git against file paths. This is the no-funds backend with true git
// semantics. The Paid backend is cloudflare.ts. Never imported by Worker
// runtime code — only by tests, the agent runner, and local harnesses.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  StaleBaseError,
  type ArtifactsPort,
  type CommitInfo,
  type CreatedRepo,
  type CreateOpts,
  type ForkResult,
  type Merger,
  type MergeRequest,
  type RepoHandle,
} from "./port.js";

function gitEnvironment(): NodeJS.ProcessEnv {
  // Hooks export GIT_DIR (usually "."); scrub git discovery vars so every
  // call behaves identically whether invoked from a hook, test, or shell.
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_NAMESPACE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_COMMON_DIR;
  return env;
}

export function runGit(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    cwd,
    env: gitEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const NAME = /^[A-Za-z0-9._-]{1,64}$/;

function branchName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    !/^[A-Za-z0-9._/-]+$/.test(value) ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.endsWith(".lock") ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{")
  ) {
    throw new Error("invalid branch name");
  }
  return value;
}

function commitSha(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error("invalid commit sha");
  }
  return value.toLowerCase();
}

/** True only when git can prove the relationship; an error is a refusal. */
function isAncestor(ancestor: string, descendant: string, cwd: string): boolean {
  try {
    runGit(["merge-base", "--is-ancestor", ancestor, descendant], cwd);
    return true;
  } catch {
    return false;
  }
}

/** Git's well-known empty tree, used to diff an unborn base. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export class GitRepoHandle implements RepoHandle {
  name: string;
  remote: string;
  defaultBranch: string;
  private dir: string;

  constructor(
    rootDir: string,
    name: string,
    defaultBranch: string,
    private host?: string,
  ) {
    this.name = name;
    this.dir = path.join(rootDir, `${name}.git`);
    this.remote = host ? `${host}/${name}.git` : this.dir;
    this.defaultBranch = defaultBranch;
  }

  private bare(...args: string[]): string {
    return runGit([`--git-dir=${this.dir}`, ...args]);
  }

  private resolveCommit(ref: string): string | null {
    if (/^[a-f0-9]{40}$/i.test(ref)) {
      const sha = ref.toLowerCase();
      // Batch mode has an explicit "missing" record. cat-file -e and
      // rev-parse failures alone cannot distinguish absence from corruption.
      const result = spawnSync("git", [`--git-dir=${this.dir}`, "cat-file", "--batch-check"], {
        input: `${sha}\n`, encoding: "utf8", env: gitEnvironment(),
      });
      if (result.error) throw result.error;
      // Git can emit a missing record AND corruption diagnostics with exit 0.
      if (result.status !== 0 || result.stderr !== "") {
        throw new Error(`artifacts: git object lookup failed (status ${result.status})`);
      }
      if (result.stdout === `${sha} missing\n`) return null;
      if (!new RegExp(`^${sha} commit [0-9]+\\n$`).test(result.stdout)) {
        throw new Error("artifacts: expected a commit object");
      }
      return sha;
    }
    const branch = ref.startsWith("refs/heads/") ? ref : `refs/heads/${ref}`;
    this.bare("check-ref-format", branch);
    try {
      this.bare("show-ref", "--verify", "--quiet", branch);
    } catch (error) {
      if ((error as { status?: number }).status === 1) return null;
      throw error;
    }
    // Once a ref exists, an unreadable target is an error, never absence.
    return this.bare("rev-parse", "--verify", "--end-of-options", `${branch}^{commit}`);
  }

  async info() {
    const commit = this.resolveCommit(this.defaultBranch);
    const lastPushAt = commit === null ? null : this.bare("log", "-1", "--format=%cI", commit) || null;
    return { defaultBranch: this.defaultBranch, lastPushAt };
  }

  async readFile(ref:string,filePath:string):Promise<string|null>{
    const commit = this.resolveCommit(ref);
    if (commit === null) return null;
    const entries=execFileSync('git',['--literal-pathspecs',`--git-dir=${this.dir}`,'ls-tree','-z',commit,'--',filePath],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
    if(entries==='')return null;
    const match=/^([0-7]{6}) blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(entries);
    if(!match||match[3]!==filePath||match[1]!=='100644')throw new Error('artifacts: text transport supports regular nonexecutable blobs only');
    const bytes=execFileSync('git',[`--git-dir=${this.dir}`,'cat-file','blob',match[2]],{stdio:['ignore','pipe','pipe'],maxBuffer:8*1048576});
    return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
  }

  async history(ref: string, limit = 50): Promise<CommitInfo[]> {
    const commit = this.resolveCommit(ref);
    if (commit === null) return [];
    const raw = this.bare(
        "log",
        commit,
        "-n",
        String(limit),
        // `%B`, not `%s`: the subject alone hides the commit body, and the
        // `Fork-Head: <proposal sha>` trailer lives there. That trailer is the
        // canonical proposal -> landed link (see docs/INTEGRATION-STATUS.md §3),
        // so truncating it here made the link unreadable through the port.
        // The Workers binding returns the platform's message unmodified, so
        // this also brings the two adapters closer, not further apart.
        "--pretty=format:%H%x1f%B%x1f%an%x1f%cI%x1f%P%x1e",
      );
    const commits: CommitInfo[] = [];
    for (const block of raw.split("\x1e")) {
      const parts = block.trim().split("\x1f");
      if (parts.length < 5 || !parts[0]) continue;
      const [sha, message, author, date, parents] = parts;
      let files: string[] | undefined;
      try {
        files = (parents ? this.bare('diff','--name-only','-z',parents.split(' ')[0],sha) :
          this.bare('diff-tree','--root','--no-commit-id','--name-only','-r','-z',sha))
          .split('\0').filter(f=>f.length>0);
        if(files.some(f=>/[\x00-\x1f\x7f]/.test(f)))throw new Error('unsupported path');
      } catch {
        files = undefined;
      }
      commits.push({
        sha,
        message,
        author,
        date,
        parents: parents ? parents.split(" ").filter(Boolean) : [],
        files,
      });
    }
    return commits;
  }

  async createToken(scope: "read" | "write", ttlSecs: number): Promise<string> {
    return `local_${scope}_${ttlSecs}_${randomUUID().slice(0, 8)}`;
  }

  async fork(newName: string): Promise<ForkResult> {
    if (!NAME.test(newName)) throw new Error(`invalid repo name: ${newName}`);
    const dest = path.join(path.dirname(this.dir), `${newName}.git`);
    if (existsSync(dest)) throw new Error(`repo already exists: ${newName}`);
    runGit(["clone", "--bare", "--quiet", this.dir, dest]);
    const token = `local_write_3600_${randomUUID().slice(0, 8)}`;
    const remote = this.host ? `${this.host}/${newName}.git` : dest;
    return { name: newName, remote, token };
  }

  dispose(): void {
    // No handles to release.
  }
}

export class GitAdapter implements ArtifactsPort {
  /**
   * @param host optional remote prefix for agents
   * (e.g. "git@k11:/srv/foundry"). Omit for plain local paths.
   */
  constructor(private rootDir: string, private host?: string) {}

  private remoteFor(name: string): string {
    return this.host ? `${this.host}/${name}.git` : this.dirFor(name);
  }

  private dirFor(name: string): string {
    if (!NAME.test(name)) throw new Error(`invalid repo name: ${name}`);
    return path.join(this.rootDir, `${name}.git`);
  }

  async create(name: string, opts: CreateOpts = {}): Promise<CreatedRepo> {
    const dir = this.dirFor(name);
    if (existsSync(path.join(dir, "HEAD"))) {
      throw new Error(`repo already exists: ${name}`);
    }
    mkdirSync(this.rootDir, { recursive: true });
    const branch = opts.defaultBranch ?? "main";
    runGit(["init", "--bare", "-b", branch, "--quiet", dir]);
    return {
      name,
      remote: this.remoteFor(name),
      defaultBranch: branch,
      token: `local_write_3600_${randomUUID().slice(0, 8)}`,
    };
  }

  async get(name: string): Promise<GitRepoHandle> {
    const dir = this.dirFor(name);
    if (!existsSync(path.join(dir, "HEAD"))) {
      throw new Error(`repo not found: ${name}`);
    }
    const branch = runGit([`--git-dir=${dir}`, "symbolic-ref", "--short", "HEAD"]);
    return new GitRepoHandle(this.rootDir, name, branch, this.host);
  }

  async list(): Promise<string[]> {
    let entries: string[] = [];
    try {
      entries = readdirSync(this.rootDir);
    } catch {
      return [];
    }
    return entries
      .filter(
        (e) =>
          e.endsWith(".git") && existsSync(path.join(this.rootDir, e, "HEAD")),
      )
      .map((e) => e.slice(0, -".git".length))
      .sort();
  }

  async delete(name: string): Promise<void> {
    rmSync(this.dirFor(name), { recursive: true, force: true });
  }
}

/**
 * True-history merge over real git: clone base, fetch fork, merge, push.
 * Unlike IsomorphicMerger's squash path, this preserves both parents.
 * `workRoot` parents the scratch clone (callers own cleanup).
 *
 * DECIDED 2026-10-15: the two-parent shape is intentional, not drift. This
 * merger is the local runner's (`tools/gate-runner.ts`), where keeping the
 * fork's commits visible in the base is the point — it is how you inspect what
 * an agent actually did. Production squashes (`IsomorphicMerger`), because a
 * shared base should not carry every agent's intermediate history. Both write
 * the same `Fork-Head: <proposal sha>` trailer, which is the link that makes
 * the two policies interchangeable at the record level; that trailer is what
 * you should depend on, never the parent count.
 * See docs/INTEGRATION-STATUS.md §3.
 */
function gitEntries(dir:string,revision:string):Map<string,string>{
  if(revision===EMPTY_TREE)return new Map();
  const raw=execFileSync('git',['ls-tree','-r','-z',revision],{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:8*1048576});
  const result=new Map<string,string>();
  for(const entry of raw.split('\0').filter(Boolean)){
    const m=/^([0-7]{6}) (blob|commit) ([a-f0-9]{40})\t(.+)$/.exec(entry);
    if(!m||result.has(m[4])||result.size>=20000)throw new Error('merge: incomplete tree');
    result.set(m[4],`${m[1]} ${m[2]} ${m[3]}`);
  }
  return result;
}
function equalEntries(a:Map<string,string>,b:Map<string,string>):boolean{
  return a.size===b.size&&[...a].every(([p,e])=>b.get(p)===e);
}
function overlayAdmission(base:Map<string,string>,fork:Map<string,string>,req:MergeRequest):Map<string,string>{
  const expected=new Map(base);
  for(const [p,content] of Object.entries(req.files)){
    const bytes=Buffer.from(content,'utf8'),oid=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    const entry=`100644 blob ${oid}`;
    if(fork.get(p)!==entry)throw new Error('merge: unsupported or changed proposal entry');
    expected.set(p,entry);
  }
  for(const p of req.deletedFiles){if(fork.has(p)||Object.hasOwn(req.files,p))throw new Error('merge: deletion not absent in proposal');expected.delete(p);}
  return expected;
}

export class GitMerger implements Merger {
  constructor(private workRoot: string = tmpdir()) {}

  async merge(req: MergeRequest): Promise<string> {
    const baseBranch = branchName(req.baseBranch);
    const forkHeadSha = commitSha(req.forkHeadSha);
    const expectedBaseSha = req.expectedBaseSha
      ? commitSha(req.expectedBaseSha)
      : undefined;
    const dir = mkdtempSync(path.join(this.workRoot, "foundry-merge-"));
    runGit(["clone", "--quiet", "--", req.baseRemote, dir]);
    if(!expectedBaseSha&&runGit(['for-each-ref','--count=1','--format=%(refname)'],dir)!=='')
      throw new StaleBaseError('genesis destination is not empty');
    // Select the declared destination branch, never the clone's default HEAD.
    // An empty base has no branch yet and is the only checkout fallback.
    try {
      if (expectedBaseSha) {
        // The declared destination ref, not merely an object reachable from the
        // clone. A detached object is not permission to create or move another
        // branch during the push below.
        const remoteRef = `refs/remotes/origin/${baseBranch}`;
        const branchHead = runGit(
          ["rev-parse", "--verify", `${remoteRef}^{commit}`],
          dir,
        );
        if (branchHead !== expectedBaseSha) {
          throw new StaleBaseError(
            `base branch ${baseBranch} moved ${expectedBaseSha.slice(0, 8)} -> ${branchHead.slice(0, 8)}`,
          );
        }
        runGit(["checkout", "--quiet", "--detach", expectedBaseSha], dir);
      } else {
        runGit(["checkout", "--quiet", baseBranch], dir);
      }
    } catch (error) {
      if (expectedBaseSha) {
        if (error instanceof StaleBaseError) throw error;
        throw new StaleBaseError(
          `base branch ${baseBranch} cannot resolve ${expectedBaseSha.slice(0, 8)}`,
        );
      }
      // No expected base means the only legitimate fallback is an actually
      // empty repository. A nonempty clone missing the declared branch must
      // not silently merge onto the clone's default HEAD and push it there.
      const anyRef = runGit(
        ["for-each-ref", "--count=1", "--format=%(refname)"],
        dir,
      );
      if (anyRef !== "") {
        throw new Error(`base branch ${baseBranch} does not exist`);
      }
    }
    // Refuse to land a decision made against a base that has since moved.
    if (expectedBaseSha) {
      const head = runGit(["rev-parse", "HEAD"], dir);
      if (head !== expectedBaseSha) {
        throw new StaleBaseError(
          `base moved ${expectedBaseSha.slice(0, 8)} -> ${head.slice(0, 8)}`,
        );
      }
    }
    // Resolve the exact admitted proposal. When the event names a branch, fetch
    // that branch into a private ref and prove it still points at the event SHA;
    // a moved/deleted branch is a refusal, not permission to merge its successor.
    let forkRef = "FETCH_HEAD";
    if (req.forkBranch) {
      forkRef = `refs/foundry/proposals/${forkHeadSha}`;
      runGit(
        [
          "fetch",
          "--quiet",
          "--no-tags",
          "--",
          req.forkRemote,
          `+refs/heads/${branchName(req.forkBranch)}:${forkRef}`,
        ],
        dir,
      );
    } else {
      runGit(
        ["fetch", "--quiet", "--no-tags", "--", req.forkRemote, forkHeadSha],
        dir,
      );
    }
    const resolvedFork = runGit(
      ["rev-parse", "--verify", `${forkRef}^{commit}`],
      dir,
    );
    if (resolvedFork !== forkHeadSha) {
      throw new Error(
        `fork moved ${forkHeadSha.slice(0, 8)} -> ${resolvedFork.slice(0, 8)}`,
      );
    }
    const forkTree=gitEntries(dir,forkHeadSha);
    const baseTree=gitEntries(dir,expectedBaseSha??EMPTY_TREE);
    const expectedTree=overlayAdmission(baseTree,forkTree,req);
    // A replay may only reuse the current landed commit when its actual parent
    // shape, exact trailer and entire overlay tree prove this proposal landed.
    if(expectedBaseSha){
      const priorParents=runGit(['rev-list','--parents','-n','1',expectedBaseSha],dir).split(' ').slice(1);
      const message=runGit(['show','-s','--format=%B',expectedBaseSha],dir);
      if((priorParents.length===2||priorParents.length===1)&&priorParents.at(-1)===forkHeadSha&&
        message.split('\n').includes(`Fork-Head: ${forkHeadSha}`)){
        const priorBase=priorParents.length===2?priorParents[0]:EMPTY_TREE;
        if(equalEntries(baseTree,overlayAdmission(gitEntries(dir,priorBase),forkTree,req)))return expectedBaseSha;
        throw new Error('merge: ambiguous replay tree');
      }
    }
    // Prove the admitted ancestry, not just the identity of the tip. A fork
    // point that is no longer an ancestor means either the proposal or the
    // destination was rewritten; neither is mergeable under this decision.
    if (req.forkPointSha) {
      const forkPoint = commitSha(req.forkPointSha);
      if (!isAncestor(forkPoint, forkHeadSha, dir)) {
        throw new Error(
          `proposal ${forkHeadSha.slice(0, 8)} does not descend from fork point ${forkPoint.slice(0, 8)}`,
        );
      }
      if (expectedBaseSha && !isAncestor(forkPoint, expectedBaseSha, dir)) {
        throw new StaleBaseError(
          `base ${expectedBaseSha.slice(0, 8)} no longer contains fork point ${forkPoint.slice(0, 8)}`,
        );
      }
    }
    if(!expectedBaseSha){
      // An explicit wrapper commit gives genesis the documented proposal parent;
      // git merge on an unborn branch would simply fast-forward to the proposal.
      const root=runGit(['-c',`user.name=${req.author}`,'-c','user.email=foundry@local','commit-tree',
        `${forkHeadSha}^{tree}`,'-p',forkHeadSha,'-m',`${req.message}\n\nFork-Head: ${forkHeadSha}`],dir);
      runGit(['update-ref','HEAD',root],dir);
    }else {
    runGit(
      [
        "-c",
        `user.name=${req.author}`,
        "-c",
        "user.email=foundry@local",
        "merge",
        "--no-ff",
        "--quiet",
        "-m",
        `${req.message}\n\nFork-Head: ${forkHeadSha}`,
        forkHeadSha,
      ],
      dir,
    );
    }
    // Bind the landed object to the admission before it can be pushed: the
    // parents must be exactly the expected base and the admitted proposal, and
    // the diff must contain every admitted path and nothing else.
    const landedSha = runGit(["rev-parse", "HEAD"], dir);
    const parents = runGit(["rev-list", "--parents", "-n", "1", landedSha], dir)
      .split(" ")
      .slice(1);
    const parentError = expectedBaseSha
      ? parents.length === 2 &&
        parents[0] === expectedBaseSha &&
        parents[1] === forkHeadSha
        ? ""
        : `expected ${expectedBaseSha.slice(0, 8)}+${forkHeadSha.slice(0, 8)}`
      : parents.length === 1 && parents[0] === forkHeadSha
        ? ""
        : `expected single parent ${forkHeadSha.slice(0, 8)}`;
    if (parentError) {
      throw new Error(
        `landed merge ${landedSha.slice(0, 8)} parents ${parents.join(",")} do not bind: ${parentError}`,
      );
    }
    if(!equalEntries(gitEntries(dir,landedSha),expectedTree))throw new Error('merge: landed bytes/modes/kinds differ from admitted overlay');
    const pushArgs = ["push", "--quiet"];
    pushArgs.push(`--force-with-lease=refs/heads/${baseBranch}:${expectedBaseSha??""}`);
    pushArgs.push("--", "origin", `HEAD:refs/heads/${baseBranch}`);
    runGit(pushArgs, dir);
    return landedSha;
  }
}

// GitAdapter — REAL git backend for ArtifactsPort (node-only: shells out to
// the git CLI). Repos are bare dirs (<name>.git) under rootDir; agents use
// stock git against file paths. This is the no-funds backend with true git
// semantics. The Paid backend is cloudflare.ts. Never imported by Worker
// runtime code — only by tests, the agent runner, and local harnesses.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
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

export function runGit(args: string[], cwd?: string): string {
  // Hooks export GIT_DIR (usually "."); scrub git discovery vars so every
  // call behaves identically whether invoked from a hook, test, or shell.
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_NAMESPACE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_COMMON_DIR;
  return execFileSync("git", args, {
    encoding: "utf8",
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const NAME = /^[A-Za-z0-9._-]{1,64}$/;

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

  async info() {
    let lastPushAt: string | null = null;
    try {
      lastPushAt = this.bare("log", "-1", "--format=%cI", "HEAD") || null;
    } catch {
      // Empty repo.
    }
    return { defaultBranch: this.defaultBranch, lastPushAt };
  }

  async readFile(ref: string, filePath: string): Promise<string | null> {
    try {
      return execFileSync(
        "git",
        [`--git-dir=${this.dir}`, "show", `${ref}:${filePath}`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch {
      return null;
    }
  }

  async history(ref: string, limit = 50): Promise<CommitInfo[]> {
    let raw: string;
    try {
      raw = this.bare(
        "log",
        ref,
        "-n",
        String(limit),
        "--pretty=format:%H%x1f%s%x1f%an%x1f%cI%x1f%P%x1e",
      );
    } catch {
      return [];
    }
    const commits: CommitInfo[] = [];
    for (const block of raw.split("\x1e")) {
      const parts = block.trim().split("\x1f");
      if (parts.length < 5 || !parts[0]) continue;
      const [sha, message, author, date, parents] = parts;
      let files: string[] = [];
      try {
        files = this.bare("show", "--pretty=", "--name-only", sha)
          .split("\n")
          .map((f) => f.trim())
          .filter((f) => f.length > 0);
      } catch {
        files = [];
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
 */
export class GitMerger implements Merger {
  constructor(private workRoot: string = tmpdir()) {}

  async merge(req: MergeRequest): Promise<string> {
    const dir = mkdtempSync(path.join(this.workRoot, "foundry-merge-"));
    runGit(["clone", "--quiet", req.baseRemote, dir]);
    // Refuse to land a decision made against a base that has since moved.
    if (req.expectedBaseSha) {
      const head = runGit(["rev-parse", "HEAD"], dir);
      if (head !== req.expectedBaseSha) {
        throw new StaleBaseError(
          `base moved ${req.expectedBaseSha.slice(0, 8)} -> ${head.slice(0, 8)}`,
        );
      }
    }
    runGit(["fetch", "--quiet", req.forkRemote], dir);
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
        `${req.message}\n\nFork-Head: ${req.forkHeadSha}`,
        "FETCH_HEAD",
      ],
      dir,
    );
    runGit(["push", "--quiet", "origin", `HEAD:${req.baseBranch}`], dir);
    return runGit(["rev-parse", "HEAD"], dir);
  }
}

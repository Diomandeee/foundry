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
    let workDir = dir;
    const onAuth = () => ({ username: "x", password: tokenSecret(req.baseToken) });
    try {
      await git.clone({
        fs,
        http,
        dir,
        url: req.baseRemote,
        ref: req.baseBranch,
        singleBranch: true,
        depth: 50,
        onAuth,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (req.expectedBaseSha || !/could not find/i.test(msg)) {
        throw new Error(
          `merge:clone: ${req.baseName}@${req.baseBranch}: ${msg}`,
        );
      }
      // Else: possibly an empty base — verified below via listBranches.
    }
    // A clone of an empty repo can "succeed" with HEAD pointing at a
    // branch that was never created (commits would land on the wrong
    // branch and the push would fail). When the expected branch is
    // absent and no base was expected, start from a fresh checkout in
    // a sibling dir; the push below creates the branch remotely.
    const branches = await git
      .listBranches({ fs, dir })
      .catch(() => [] as string[]);
    if (!branches.includes(req.baseBranch)) {
      if (req.expectedBaseSha) {
        throw new StaleBaseError(
          `base has no ${req.baseBranch} (expected ${req.expectedBaseSha.slice(0, 8)})`,
        );
      }
      workDir = `${dir}-emptybase`;
      await git.init({ fs, dir: workDir, defaultBranch: req.baseBranch });
      await git.addRemote({
        fs,
        dir: workDir,
        remote: "origin",
        url: req.baseRemote,
      });
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
    // File modes travel with the proposal's immutable objects, not with the
    // admitted text: read them from the pushed commit so an executable stays
    // executable (the 2026-10-19 hotfix still wrote every file as 100644).
    const proposalDir = `${dir}-proposal`;
    await git.clone({
      fs, http, dir: proposalDir, url: req.forkRemote,
      ref: req.forkBranch ?? "main", singleBranch: true, depth: 1, noCheckout: true,
      onAuth: () => ({ username: "x", password: tokenSecret(req.forkToken) }),
    });
    const proposalHead = await git.resolveRef({ fs, dir: proposalDir, ref: "HEAD" });
    if (proposalHead !== req.forkHeadSha) throw new Error("merge: proposal moved");
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
    try {
      await git.push({
        fs,
        http,
        dir: workDir,
        url: req.baseRemote,
        ref: req.baseBranch,
        remoteRef: `refs/heads/${req.baseBranch}`,
        onAuth,
      });
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
  } }).promises;
  for (const [name, content] of Object.entries(files)) {
    const fp = `${dir}/${name}`;
    const slash = fp.lastIndexOf("/");
    if (slash > 0) await promises.mkdir(fp.slice(0, slash), { recursive: true });
    await promises.writeFile(fp, content);
    // Explicit either way: an edited file must not keep a stale bit from the base checkout.
    await promises.chmod(fp, modes[name] === "100755" ? 0o755 : 0o644);
    await git.add({ fs, dir, filepath: name });
  }
  for (const name of deletedFiles) {
    // Absent on both sides (created-then-deleted on the fork) is a no-op.
    await git.remove({ fs, dir, filepath: name }).catch(() => {});
  }
  // Idempotent redelivery: the merge already landed (crash between push
  // and record) — return the current head instead of an empty commit.
  // statusMatrix compares content only, so a mode-only change (chmod +x) would read
  // as clean and return the base. Compare each admitted path's mode too.
  const matrix = await git.statusMatrix({ fs, dir });
  let dirty = matrix.some(
    ([, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1),
  );
  if (!dirty && Object.keys(files).length) {
    const head = await git.resolveRef({ fs, dir, ref: "HEAD" }).catch(() => null);
    const headModes = new Map<string, string>();
    if (head) {
      await git.walk({ fs, dir, trees: [git.TREE({ ref: head })],
        map: async (path, [e]) => {
          if (e && Object.hasOwn(files, path) && (await e.type()) === "blob") {
            headModes.set(path, ((await e.mode()) as number).toString(8));
          }
          return true;
        } });
    }
    dirty = Object.keys(files).some((name) => headModes.get(name) !== (modes[name] ?? "100644"));
  }
  if (!dirty) return git.resolveRef({ fs, dir, ref: "HEAD" });
  return git.commit({
    fs,
    dir,
    message: `${message}\n\nFork-Head: ${forkHeadSha}`,
    author: { name: author, email: "foundry@local" },
  });
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
  const fs = fsInput as Parameters<typeof git.clone>[0]["fs"];
  const { commit } = await git.readCommit({ fs, dir, oid: commitSha });
  const trees = new Map<string, Map<string, { mode: string; oid: string; type: string }>>();
  async function entries(path: string) {
    const hit = trees.get(path);
    if (hit) return hit;
    let oid = commit.tree;
    if (path) {
      const parent = await entries(path.slice(0, Math.max(0, path.lastIndexOf("/"))));
      const e = parent.get(path.slice(path.lastIndexOf("/") + 1));
      if (!e || e.type !== "tree") throw new Error(`merge: proposal has no directory ${path}`);
      oid = e.oid;
    }
    const { tree } = await git.readTree({ fs, dir, oid });
    const m = new Map(tree.map((e) => [e.path, { mode: e.mode, oid: e.oid, type: e.type }]));
    trees.set(path, m);
    return m;
  }
  const out: Record<string, FileMode> = {};
  for (const [path, content] of Object.entries(files)) {
    const slash = path.lastIndexOf("/");
    const e = (await entries(slash < 0 ? "" : path.slice(0, slash))).get(path.slice(slash + 1));
    if (!e || e.type !== "blob" || (e.mode !== "100644" && e.mode !== "100755")) {
      throw new Error(`merge: unsupported proposal entry ${path} (${e ? e.mode : "absent"})`);
    }
    const { oid } = await git.hashBlob({ object: new TextEncoder().encode(content) });
    if (oid !== e.oid) throw new Error(`merge: admitted text differs from proposal blob ${path}`);
    out[path] = e.mode;
  }
  return out;
}

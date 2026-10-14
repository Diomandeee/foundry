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
        throw new Error(`merge:clone: ${msg}`);
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
        `merge:push: ${e instanceof Error ? e.message : String(e)}`,
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
    const fp = `${dir}/${name}`;
    const slash = fp.lastIndexOf("/");
    if (slash > 0) await promises.mkdir(fp.slice(0, slash), { recursive: true });
    await promises.writeFile(fp, content);
    await git.add({ fs, dir, filepath: name });
  }
  for (const name of deletedFiles) {
    // Absent on both sides (created-then-deleted on the fork) is a no-op.
    await git.remove({ fs, dir, filepath: name }).catch(() => {});
  }
  // Idempotent redelivery: the merge already landed (crash between push
  // and record) — return the current head instead of an empty commit.
  const matrix = await git.statusMatrix({ fs, dir });
  const dirty = matrix.some(
    ([, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1),
  );
  if (!dirty) return git.resolveRef({ fs, dir, ref: "HEAD" });
  return git.commit({
    fs,
    dir,
    message: `${message}\n\nFork-Head: ${forkHeadSha}`,
    author: { name: author, email: "foundry@local" },
  });
}

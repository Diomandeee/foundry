// ArtifactsPort — the seam between Foundry's decision logic and repo storage.
// Production: CloudflareAdapter (workers/gate + orchestrator, over the
// Artifacts binding). Pre-Paid dev/test/demo: LocalGitAdapter (fs-backed
// behavioral fake). Workers must only depend on these interfaces.

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
  parents: string[];
  /** Changed paths, when the backend tracks them (fake: always). */
  files?: string[];
}

export interface RepoMeta {
  name: string;
  remote: string;
  defaultBranch: string;
}

export interface CreatedRepo extends RepoMeta {
  token: string;
}

export interface ForkResult {
  name: string;
  remote: string;
  token: string;
}

export interface RepoHandle extends RepoMeta {
  info(): Promise<{ defaultBranch: string; lastPushAt: string | null }>;
  readFile(ref: string, path: string): Promise<string | null>;
  history(ref: string, limit?: number): Promise<CommitInfo[]>;
  createToken(scope: "read" | "write", ttlSecs: number): Promise<string>;
  fork(newName: string): Promise<ForkResult>;
  dispose(): void;
}

export interface CreateOpts {
  description?: string;
  defaultBranch?: string;
}

export interface ArtifactsPort {
  create(name: string, opts?: CreateOpts): Promise<CreatedRepo>;
  get(name: string): Promise<RepoHandle>;
  list(): Promise<string[]>;
  delete(name: string): Promise<void>;
}

/** Normalized push event (Artifacts queue shape → worker logic). */
export interface PushEvent {
  namespace: string;
  repo: string;
  ref: string;
  before: string;
  after: string;
}

export interface MergeRequest {
  baseName: string;
  baseRemote: string;
  baseToken: string;
  baseBranch: string;
  forkRemote: string;
  forkToken: string;
  forkHeadSha: string;
  files: Record<string, string>;
  /** Fork-side deletions the merger must apply (true merges handle natively). */
  deletedFiles: string[];
  message: string;
  author: string;
}

export interface Merger {
  /** Apply the fork side onto base; returns the merge commit sha. */
  merge(req: MergeRequest): Promise<string>;
}

export function toPushEvent(
  namespace: string,
  body: {
    type?: string;
    source?: { namespace?: string; repoName?: string };
    payload?: { ref?: string; before?: string; after?: string };
  },
): PushEvent | null {
  if (
    body?.type !== "cf.artifacts.repo.pushed" &&
    body?.type !== "foundry.local.pushed"
  ) {
    return null;
  }
  const repo = body.source?.repoName;
  const after = body.payload?.after;
  if (!repo || !after) return null;
  return {
    namespace: body.source?.namespace ?? namespace,
    repo,
    ref: body.payload?.ref ?? "refs/heads/main",
    before: body.payload?.before ?? "0".repeat(40),
    after,
  };
}

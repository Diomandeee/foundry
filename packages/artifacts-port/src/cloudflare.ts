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
      const blob = await binding.readFile({ ref, path: filePath });
      return blob ? await blob.text() : null;
    },
    async history(ref: string, limit = 50): Promise<CommitInfo[]> {
      // Binding surface verified in spike; adapt field names there if needed.
      const commits = await binding.history({ ref, limit });
      return (commits ?? []).map((c: any) => ({
        sha: c.sha ?? c.id ?? "",
        message: c.message ?? "",
        author: c.author?.name ?? c.author ?? "",
        date: c.date ?? c.timestamp ?? "",
        parents: c.parents ?? [],
      }));
    },
    async createToken(scope: "read" | "write", ttlSecs: number) {
      return binding.createToken(scope, ttlSecs);
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

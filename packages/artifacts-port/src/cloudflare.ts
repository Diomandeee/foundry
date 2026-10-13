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

/** All file paths in a tree, recursive. Bounded for worker CPU safety. */
async function treeFiles(
  binding: RepoBinding, treeHash: string, prefix = "",
  cap = 2000,
): Promise<Set<string>> {
  const out = new Set<string>();
  const entries = (await binding.readTree(treeHash)) ?? [];
  for (const e of entries) {
    if (out.size >= cap) break;
    const p = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.type === "tree") {
      for (const sub of await treeFiles(binding, e.hash, p, cap - out.size)) {
        out.add(sub);
      }
    } else {
      out.add(p);
    }
  }
  return out;
}

/** Changed paths in one commit: tree diff vs first parent (or all files if root). */
async function diffFiles(binding: RepoBinding, c: any): Promise<string[]> {
  const mine = await treeFiles(binding, c.treeHash);
  if (!c.parents || c.parents.length === 0) return [...mine].sort();
  const parent = await binding.readCommit(c.parents[0]);
  const parentTree: string | null = parent ? parent.treeHash : null;
  const theirs = parentTree
    ? await treeFiles(binding, parentTree) : new Set<string>();
  const changed = new Set<string>();
  for (const p of mine) if (!theirs.has(p)) changed.add(p);
  for (const p of theirs) if (!mine.has(p)) changed.add(p);
  // Fast path covers add/delete; same-size trees may still hide content
  // edits, so compare blob hashes for the intersection when small.
  if (changed.size === 0 && parentTree && mine.size === theirs.size
      && mine.size < 500) {
    const [a, b] = await Promise.all([
      treeBlobs(binding, c.treeHash), treeBlobs(binding, parentTree),
    ]);
    for (const [p, h] of a) if (b.get(p) !== h) changed.add(p);
  }
  return [...changed].sort();
}

/** path -> blob hash for a tree, recursive (for content-edit detection). */
async function treeBlobs(
  binding: RepoBinding, treeHash: string, prefix = "",
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const entries = (await binding.readTree(treeHash)) ?? [];
  for (const e of entries) {
    const p = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.type === "tree") {
      for (const [sp, sh] of await treeBlobs(binding, e.hash, p)) out.set(sp, sh);
    } else {
      out.set(p, e.hash);
    }
  }
  return out;
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
      const blob = await binding.readFile({ ref, path: filePath });
      return blob ? await blob.text() : null;
    },
    async history(ref: string, limit = 50): Promise<CommitInfo[]> {
      // Real binding: log(), not history(). Commit metadata carries no file
      // list, so changed paths come from a tree diff against the first
      // parent (bounded: newest FILES_CAP commits; older entries omit files
      // and the gate treats unknown paths as conflict — safe default).
      const FILES_CAP = 25;
      const commits = await binding.log({ ref, limit });
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

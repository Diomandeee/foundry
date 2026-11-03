// Test kit: the gate's production adapters against real git. Bare repos under one root are served
// over smart HTTP (git http-backend behind a local server) for IsomorphicMerger's clone/push, and an
// Artifacts binding fake reads the same repos with the git CLI, so cloudflarePort runs unchanged.
// Not imported by the Worker.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

const BACKEND = join(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "git-http-backend");
const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...ENV } }).trim();
}

/** Serves every bare repo under `root` at `${url}/<name>.git`, push included. */
export async function serveGit(root: string): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const cgi = spawn(BACKEND, [], { env: {
      ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", REMOTE_USER: "x",
      PATH_INFO: u.pathname, QUERY_STRING: u.search.slice(1), REQUEST_METHOD: req.method ?? "GET",
      CONTENT_TYPE: req.headers["content-type"] ?? "", GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
    } });
    req.pipe(cgi.stdin);
    const out: Buffer[] = [];
    cgi.stdout.on("data", (b: Buffer) => out.push(b));
    cgi.on("close", () => {
      const all = Buffer.concat(out);
      const split = all.indexOf("\r\n\r\n");
      let status = 200;
      for (const h of all.subarray(0, split).toString().split("\r\n")) {
        const at = h.indexOf(":");
        const [k, v] = [h.slice(0, at), h.slice(at + 1).trim()];
        if (k.toLowerCase() === "status") status = parseInt(v, 10);
        else res.setHeader(k, v);
      }
      res.writeHead(status);
      res.end(all.subarray(split + 4));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  return { url, close: () => new Promise((r) => server.close(() => r())) };
}

const TYPES: Record<string, string> = { "040000": "tree", "100644": "blob", "100755": "exec", "120000": "symlink", "160000": "gitlink" };

/** The Artifacts binding surface cloudflarePort uses, over the bare repos under `root`. */
export function fakeArtifacts(root: string, url: string) {
  function repo(name: string) {
    const dir = join(root, `${name}.git`);
    const bare = (...args: string[]) => git(root, `--git-dir=${dir}`, ...args);
    const resolve = (ref: string): string | null => {
      const r = spawnSync("git", [`--git-dir=${dir}`, "rev-parse", "--verify", "--quiet",
        /^[0-9a-f]{40}$/.test(ref) ? `${ref}^{commit}` : `refs/heads/${ref.replace(/^refs\/heads\//, "")}^{commit}`],
      { encoding: "utf8" });
      return r.status === 0 ? r.stdout.trim() : null;
    };
    const commit = (sha: string) => {
      const [hash, treeHash, parents, an, ae, at, ...msg] = bare("log", "-1", "--format=%H%n%T%n%P%n%an%n%ae%n%at%n%B", sha).split("\n");
      return { hash, treeHash, parents: parents ? parents.split(" ") : [], message: msg.join("\n"),
        author: { name: an, email: ae }, committer: { name: an, email: ae }, authoredAt: Number(at), committedAt: Number(at) };
    };
    return {
      async info() {
        return { remote: `${url}/${name}.git`, defaultBranch: bare("symbolic-ref", "--short", "HEAD"), lastPushAt: null };
      },
      async readFile({ ref, path }: { ref: string; path: string }) {
        const sha = resolve(ref);
        if (sha === null) return null;
        const entry = bare("ls-tree", sha, "--", path);
        const m = /^(\d{6}) (\w+) ([0-9a-f]{40})\t/.exec(entry);
        if (!m || m[2] !== "blob") return null;
        return new Blob([execFileSync("git", [`--git-dir=${dir}`, "cat-file", "blob", m[3]], { maxBuffer: 64 * 1048576 })]);
      },
      async log({ ref = "HEAD", limit = 50 }: { ref?: string; limit?: number } = {}) {
        const sha = ref === "HEAD" ? resolve(bare("symbolic-ref", "--short", "HEAD")) : resolve(ref);
        if (sha === null) return [];
        return bare("rev-list", "--first-parent", "-n", String(limit), sha).split("\n").filter(Boolean).map(commit);
      },
      async readCommit(hash: string) {
        return spawnSync("git", [`--git-dir=${dir}`, "cat-file", "-e", `${hash}^{commit}`]).status === 0 ? commit(hash) : null;
      },
      async readTree(hash: string) {
        const raw = execFileSync("git", [`--git-dir=${dir}`, "ls-tree", "-z", hash], { encoding: "utf8" });
        return raw.split("\0").filter(Boolean).map((line) => {
          const m = /^(\d{6}) \w+ ([0-9a-f]{40})\t(.+)$/s.exec(line)!;
          return { mode: m[1], hash: m[2], name: m[3], type: TYPES[m[1]] ?? "blob" };
        });
      },
      async createToken() {
        return { plaintext: "tok?expires=1" };
      },
      async fork(newName: string) {
        git(root, "clone", "-q", "--bare", dir, `${newName}.git`);
        return { name: newName, remote: `${url}/${newName}.git`, token: "tok" };
      },
    };
  }
  return {
    async get(name: string) {
      if (!fs.existsSync(join(root, `${name}.git`, "HEAD"))) throw new Error(`repo not found: ${name}`);
      return repo(name);
    },
    async list() {
      return fs.readdirSync(root).filter((e) => e.endsWith(".git")).map((e) => e.slice(0, -4));
    },
  };
}

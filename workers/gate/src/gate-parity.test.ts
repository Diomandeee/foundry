// What a lane's push gets back, end to end: handlePush with the production port (cloudflarePort over a
// fake Artifacts binding) and the production merger (IsomorphicMerger over git smart HTTP). The same
// file runs against the gate-hotfix tree; PARITY_OUT=<file> writes every scenario's observed outcome so
// the two gates can be compared row by row (docs/app-fleet/GATE-PARITY.md).
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cloudflarePort } from "@foundry/artifacts-port";
import { newScopeToken } from "@foundry/gate-ts";
import { InMemoryTicketStore, MemoryDecisionStore } from "@foundry/stores";
import type { Verifier, VerifyRequest } from "@foundry/verify";
import { fakeArtifacts, git, serveGit } from "./git-http.testkit.js";
import { IsomorphicMerger } from "./merge.js";
import { handlePush, type PipelineDeps } from "./pipeline.js";

let root: string;
let server: { url: string; close(): Promise<void> };
const observed: Record<string, unknown> = {};

beforeAll(async () => {
  root = fs.mkdtempSync(join(tmpdir(), "foundry-parity-"));
  server = await serveGit(root);
});

afterAll(async () => {
  await server.close();
  if (process.env.PARITY_OUT) fs.writeFileSync(process.env.PARITY_OUT, JSON.stringify(observed, null, 1));
  fs.rmSync(root, { recursive: true, force: true });
});

type Outcome = { attempts: string[]; verdict: string; reason: string; landed: string; verify: VerifyRequest[] };

let n = 0;
/** A base, a fork of it with a ticket, and work trees to commit on either side. */
async function lane(seed: Record<string, string>, opts: { exec?: string[]; symlink?: Record<string, string>; empty?: boolean } = {}) {
  n += 1;
  const base = `base${n}`, fork = `fork${n}`;
  const bw = join(root, `bw${n}`), fw = join(root, `fw${n}`);
  fs.mkdirSync(bw);
  git(bw, "init", "-q", "-b", "main");
  if (!opts.empty) {
    write(bw, seed, opts.exec ?? []);
    for (const [p, target] of Object.entries(opts.symlink ?? {})) fs.symlinkSync(target, join(bw, p));
    git(bw, "add", "-A", "-f");
    git(bw, "commit", "-q", "-m", "seed");
  }
  git(root, "init", "-q", "--bare", "-b", "main", `${base}.git`);
  if (!opts.empty) git(bw, "push", "-q", join(root, `${base}.git`), "HEAD:main");
  git(root, "clone", "-q", "--bare", `${base}.git`, `${fork}.git`);
  git(root, "clone", "-q", `${fork}.git`, fw);
  if (opts.empty) git(fw, "checkout", "-q", "-b", "main");
  const baseSha = opts.empty ? "" : git(root, `--git-dir=${base}.git`, "rev-parse", "main");
  const tickets = new InMemoryTicketStore();
  const scope = newScopeToken();
  scope.allowed_tools = ["foundry.merge"];
  scope.can_mutate = true;
  await tickets.saveTicket({ taskId: `t${n}`, baseRepo: base, baseSha, forkRepo: fork, agentId: "agent", scope });
  const verify: VerifyRequest[] = [];
  const verifier: Verifier = { async run(r) { verify.push(r); return { checked: false, ok: true, runs: [] }; } };
  const deps: PipelineDeps = {
    port: cloudflarePort({ ARTIFACTS: fakeArtifacts(root, server.url) }),
    tickets, store: new MemoryDecisionStore(), verifier,
    merger: new IsomorphicMerger(fs, join(root, `merge${n}`)),
  };
  const head = (repo: string, ref = "main") => {
    try { return git(root, `--git-dir=${repo}.git`, "rev-parse", "--verify", "--quiet", ref); } catch { return ""; }
  };
  return {
    base, fork, baseSha, deps, verify,
    /** Commit on the fork work tree; returns the sha (not pushed). */
    commit(files: Record<string, string | Buffer>, o: { exec?: string[]; rm?: string[]; amend?: boolean; symlink?: Record<string, string> } = {}) {
      for (const p of o.rm ?? []) fs.rmSync(join(fw, p), { recursive: true, force: true });
      write(fw, files, o.exec ?? []);
      for (const [p, target] of Object.entries(o.symlink ?? {})) fs.symlinkSync(target, join(fw, p));
      git(fw, "add", "-A", "-f");
      git(fw, "commit", "-q", "--allow-empty", ...(o.amend ? ["--amend", "--no-edit", "--date=now"] : ["-m", "change"]));
      return git(fw, "rev-parse", "HEAD");
    },
    push(ref = "main", force = false) {
      git(fw, "push", "-q", ...(force ? ["-f"] : []), join(root, `${fork}.git`), `HEAD:refs/heads/${ref}`);
    },
    /** Commit straight onto the base (another lane's merge). */
    baseCommit(files: Record<string, string>) {
      git(bw, "pull", "-q", join(root, `${base}.git`), "main");
      write(bw, files, []);
      git(bw, "add", "-A", "-f");
      git(bw, "commit", "-q", "-m", "other lane");
      git(bw, "push", "-q", join(root, `${base}.git`), "HEAD:main");
    },
    head,
    /** One push event through the gate; an `error` row is redelivered, as the queue does, up to 3 times. */
    async run(before: string, after: string, ref = "refs/heads/main", proposal = after): Promise<Outcome> {
      const attempts: string[] = [];
      const preHead = head(base);
      let rec: { verdict: string; reason?: unknown; merged_sha?: string | null } | null = null;
      for (let i = 0; i < 4; i++) {
        const res = await handlePush(deps, "test", { type: "foundry.local.pushed", source: { namespace: "test", repoName: fork },
          payload: { ref, before, after } });
        rec = res.handled ? res.record : { verdict: "unhandled", reason: res };
        const why = rec.reason ? JSON.stringify(rec.reason) : "";
        attempts.push(`${rec.verdict}${why ? ` ${why.slice(0, 160)}` : ""}`);
        if (rec.verdict !== "error") break;
      }
      const postHead = head(base);
      let landed = "base unchanged";
      if (rec?.verdict === "merge") {
        const same = git(root, `--git-dir=${base}.git`, "rev-parse", `${postHead}^{tree}`) === git(root, `--git-dir=${fork}.git`, "rev-parse", `${proposal}^{tree}`);
        landed = `${postHead === preHead ? "no new commit" : "new commit"}, base tree ${same ? "==" : "!="} proposal tree` +
          (rec.merged_sha === postHead ? "" : ` (merged_sha ${String(rec.merged_sha).slice(0, 8)} != base head)`);
      } else if (postHead !== preHead) landed = "BASE MOVED WITHOUT A MERGE VERDICT";
      return { attempts, verdict: rec!.verdict, reason: rec?.reason ? JSON.stringify(rec.reason).slice(0, 200) : "", landed, verify: [...verify] };
    },
  };
}

function write(dir: string, files: Record<string, string | Buffer>, exec: string[]) {
  for (const [p, text] of Object.entries(files)) {
    fs.mkdirSync(join(dir, p, ".."), { recursive: true });
    fs.writeFileSync(join(dir, p), text);
    fs.chmodSync(join(dir, p), exec.includes(p) ? 0o755 : 0o644);
  }
}

function record(id: string, o: Outcome, extra: Record<string, unknown> = {}) {
  observed[id] = { ...o, verify: o.verify.map((v) => ({ baseBranch: v.baseBranch, files: v.files })), ...extra };
  return o;
}

describe("gate parity: what a lane's push gets back", () => {
  it("P1 text edit and a new file", async () => {
    const l = await lane({ "app.txt": "v1\n" });
    const sha = l.commit({ "app.txt": "v2\n", "src/new.txt": "n\n" });
    l.push();
    const o = record("P1", await l.run(l.baseSha, sha));
    expect(o.verdict).toBe("merge");
    expect(o.landed).toBe("new commit, base tree == proposal tree");
  });

  it("P2 an edit to an executable and a new executable keep their modes", async () => {
    const l = await lane({ "app.txt": "v1\n", "bin/tool.sh": "#!/bin/sh\n" }, { exec: ["bin/tool.sh"] });
    const sha = l.commit({ "bin/tool.sh": "#!/bin/sh\necho 2\n", "bin/new.sh": "#!/bin/sh\n" }, { exec: ["bin/tool.sh", "bin/new.sh"] });
    l.push();
    const o = record("P2", await l.run(l.baseSha, sha));
    expect(o.verdict).toBe("merge");
    expect(o.landed).toBe("new commit, base tree == proposal tree");
  });

  it("P3 a mode-only change", async () => {
    const l = await lane({ "run.sh": "#!/bin/sh\n" });
    const sha = l.commit({ "run.sh": "#!/bin/sh\n" }, { exec: ["run.sh"] });
    l.push();
    const o = record("P3", await l.run(l.baseSha, sha));
    expect(o.verdict).toBe("merge");
    expect(o.landed).toBe("new commit, base tree == proposal tree");
  });

  it("P4 new nested files on a base with an allowlist .gitignore", async () => {
    const l = await lane({ ".gitignore": "/*\n!/.gitignore\n!/src/\n", "src/a.txt": "a\n" });
    const sha = l.commit({ "src/deep/new.txt": "n\n", "src/b.txt": "b\n" });
    l.push();
    const o = record("P4", await l.run(l.baseSha, sha));
    expect(o.verdict).toBe("merge");
    expect(o.landed).toBe("new commit, base tree == proposal tree");
  });

  it("P5 a deletion, and a file that becomes a directory", async () => {
    const l = await lane({ "app.txt": "v1\n", "gone.txt": "g\n", "d": "file\n" });
    const sha = l.commit({ "d/inner.txt": "in\n" }, { rm: ["gone.txt", "d"] });
    l.push();
    const o = record("P5", await l.run(l.baseSha, sha));
    expect(o.verdict).toBe("merge");
    expect(o.landed).toBe("new commit, base tree == proposal tree");
  });

  it("P6 the same change pushed again under a new sha after it merged (decision 643)", async () => {
    const l = await lane({ "app.txt": "v1\n" });
    const first = l.commit({ "app.txt": "v2\n" });
    l.push();
    await l.run(l.baseSha, first);
    const merged = l.head(l.base);
    const second = l.commit({}, { amend: true });
    l.push("main", true);
    const o = record("P6", await l.run(first, second));
    expect(o.verdict).toBe("merge");
    expect(o.landed).toBe("no new commit, base tree == proposal tree");
    expect(l.head(l.base)).toBe(merged);
  });

  it("P7 the merged push delivered again (queue redelivery)", async () => {
    const l = await lane({ "app.txt": "v1\n" });
    const sha = l.commit({ "app.txt": "v2\n" });
    l.push();
    await l.run(l.baseSha, sha);
    const o = record("P7", await l.run(l.baseSha, sha));
    expect(o.verdict).toBe("merge");
    expect(o.landed).toBe("no new commit, base tree == proposal tree");
  });

  it("P8 two quick pushes: the first event is handled after the branch fast-forwarded", async () => {
    const l = await lane({ "app.txt": "v1\n" });
    const first = l.commit({ "app.txt": "v2\n" });
    const second = l.commit({ "more.txt": "m\n" });
    l.push();
    const o1 = record("P8a", await l.run(l.baseSha, first, "refs/heads/main", first));
    const o2 = record("P8b", await l.run(first, second));
    expect(o2.verdict).toBe("merge");
    expect(o2.landed).toMatch(/base tree == proposal tree/);
    // gate-hotfix errored here until the queue dropped the push, running the verifier on every retry.
    expect(o1.attempts).toEqual([expect.stringMatching(/^reject .*moved past .*the newer push is decided on its own/)]);
    expect(o1.verify).toEqual([]);
  });

  it("P9 two quick pushes: the first event is handled after an amend force-pushed over it", async () => {
    const l = await lane({ "app.txt": "v1\n" });
    const first = l.commit({ "app.txt": "v2\n" });
    l.push();
    const second = l.commit({ "app.txt": "v3\n" }, { amend: true });
    l.push("main", true);
    const o1 = record("P9a", await l.run(l.baseSha, first));
    const o2 = record("P9b", await l.run(first, second));
    expect(o1.attempts).toEqual([expect.stringMatching(/^reject .*moved past/)]);
    expect(o2.verdict).toBe("merge");
    expect(o2.landed).toBe("new commit, base tree == proposal tree");
  });

  it("P10 another lane merged a different file since the fork point", async () => {
    const l = await lane({ "app.txt": "v1\n", "other.txt": "o\n" });
    const sha = l.commit({ "app.txt": "v2\n" });
    l.push();
    l.baseCommit({ "other.txt": "o2\n" });
    const o = record("P10", await l.run(l.baseSha, sha));
    expect(o.verdict).toBe("merge");
    expect(o.landed).toBe("new commit, base tree != proposal tree");
  });

  it("P11 another lane changed the same file differently", async () => {
    const l = await lane({ "app.txt": "v1\n" });
    const sha = l.commit({ "app.txt": "mine\n" });
    l.push();
    l.baseCommit({ "app.txt": "theirs\n" });
    const o = record("P11", await l.run(l.baseSha, sha));
    expect(o.verdict).toBe("conflict");
  });

  it("P12 another lane made the identical change", async () => {
    const l = await lane({ "app.txt": "v1\n", "x.txt": "x\n" });
    const sha = l.commit({ "app.txt": "same\n", "y.txt": "y\n" });
    l.push();
    l.baseCommit({ "app.txt": "same\n" });
    const o = record("P12", await l.run(l.baseSha, sha));
    expect(o.verdict).toBe("merge");
    expect(o.landed).toBe("new commit, base tree == proposal tree");
  });

  it("P13 a push to a fork branch other than main", async () => {
    const l = await lane({ "app.txt": "v1\n" });
    const sha = l.commit({ "app.txt": "v2\n" });
    l.push("feature");
    const o = record("P13", await l.run(l.baseSha, sha, "refs/heads/feature"));
    expect(o.verdict).toBe("merge");
    // The verifier fetches the head from the fork at `baseBranch`; it must be the branch the push moved.
    expect(o.verify[0]?.baseBranch).toBe("feature");
  });

  it("P14 an event naming a sha the fork does not have", async () => {
    const l = await lane({ "app.txt": "v1\n" });
    l.commit({ "app.txt": "v2\n" });
    l.push();
    const o = record("P14", await l.run(l.baseSha, "e".repeat(40)));
    expect(o.verdict).toBe("reject");
    expect(o.reason).toContain("proposal_not_found");
  });

  // P15, P16, P21: content the text transport cannot carry. Both gates once recorded `infra_failure` and
  // retried until the queue dropped the push; now a single reject names the path, before any verifier run.
  const UNSUPPORTED = /unsupported content: .*the gate lands regular and executable UTF-8 text files up to 8 MiB/;

  it("P15 a symlink in the proposal", async () => {
    const l = await lane({ "app.txt": "v1\n" });
    const sha = l.commit({}, { symlink: { "link": "app.txt" } });
    l.push();
    const o = record("P15", await l.run(l.baseSha, sha));
    expect(o.attempts).toHaveLength(1);
    expect(o.verdict).toBe("reject");
    expect(o.reason).toMatch(UNSUPPORTED);
    expect(o.reason).toContain("link is a symlink");
    expect(o.verify).toHaveLength(0);
    expect(o.landed).toBe("base unchanged");
  });

  it("P15b a symlink an earlier commit added and a later one made a file merges as the file", async () => {
    const l = await lane({ "app.txt": "v1\n" });
    l.commit({}, { symlink: { "link": "app.txt" } });
    const sha = l.commit({ "link": "now a file\n" }, { rm: ["link"] });
    l.push();
    const o = record("P15b", await l.run(l.baseSha, sha));
    expect(o.verdict).toBe("merge");
    expect(o.landed).toBe("new commit, base tree == proposal tree");
  });

  it("P15c a file a later commit turned into a symlink is refused", async () => {
    const l = await lane({ "app.txt": "v1\n" });
    l.commit({ "link": "a file first\n" });
    const sha = l.commit({}, { rm: ["link"], symlink: { "link": "app.txt" } });
    l.push();
    const o = record("P15c", await l.run(l.baseSha, sha));
    expect(o.verdict).toBe("reject");
    expect(o.reason).toContain("link is a symlink");
  });

  it("P16 a file that is not UTF-8 text", async () => {
    const l = await lane({ "app.txt": "v1\n" });
    const sha = l.commit({ "blob.bin": Buffer.from([0xff, 0xfe, 0x00, 0x62]) });
    l.push();
    const o = record("P16", await l.run(l.baseSha, sha));
    expect(o.attempts).toHaveLength(1);
    expect(o.verdict).toBe("reject");
    expect(o.reason).toMatch(UNSUPPORTED);
    expect(o.reason).toContain("blob.bin is not UTF-8 text");
    expect(o.verify).toHaveLength(0);
  });

  it("P21 a text file over 8 MiB", async () => {
    const l = await lane({ "app.txt": "v1\n" });
    const sha = l.commit({ "big.txt": "x".repeat(9 * 1048576) });
    l.push();
    const o = record("P21", await l.run(l.baseSha, sha));
    expect(o.attempts).toHaveLength(1);
    expect(o.verdict).toBe("reject");
    expect(o.reason).toContain("big.txt is 9.0 MiB, over the 8 MiB cap");
    expect(o.verify).toHaveLength(0);
  });

  it("P17 the first merge onto an empty base", async () => {
    const l = await lane({}, { empty: true });
    const sha = l.commit({ "README.md": "hi\n" });
    l.push();
    const o = record("P17", await l.run("0".repeat(40), sha));
    expect(o.verdict).toBe("merge");
    expect(o.landed).toBe("new commit, base tree == proposal tree");
  });

  it("P18 a deletion reaches the verifier's file list", async () => {
    const l = await lane({ "app.txt": "v1\n", "gone.txt": "g\n" });
    const sha = l.commit({ "app.txt": "v2\n" }, { rm: ["gone.txt"] });
    l.push();
    const o = record("P18", await l.run(l.baseSha, sha));
    expect(o.verdict).toBe("merge");
    expect(o.verify[0]?.files).toEqual(["app.txt", "gone.txt"]);
  });

  it("P19 a proposal that changes 2,100 files", async () => {
    const l = await lane({ "app.txt": "v1\n" });
    const many: Record<string, string> = {};
    for (let i = 0; i < 2100; i++) many[`gen/f${i}.txt`] = `${i}\n`;
    const sha = l.commit(many);
    l.push();
    const o = record("P19", await l.run(l.baseSha, sha));
    expect(o.verdict).toBe("merge");
    expect(o.landed).toBe("new commit, base tree == proposal tree");
  }, 120000);

  it("P20 a proposal with 9 MB of text across three files", async () => {
    const l = await lane({ "app.txt": "v1\n" });
    const mb3 = "x".repeat(3 * 1048576 - 1) + "\n";
    const sha = l.commit({ "a.txt": mb3, "b.txt": mb3, "c.txt": mb3 });
    l.push();
    const o = record("P20", await l.run(l.baseSha, sha));
    expect(o.verdict).toBe("merge");
    expect(o.landed).toBe("new commit, base tree == proposal tree");
  }, 120000);
});

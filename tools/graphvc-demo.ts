// graphvc-demo — set up base + fork bare repos, seed a ticket, install the
// post-receive hook, then push as an agent. The hook runs the gate and writes
// the verdict back into the K11 graph. Prints the decision for verification.
import { execFile } from "node:child_process";
import { KGClient, intakeTriples } from "@foundry/lkg-client";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile, chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitAdapter } from "@foundry/artifacts-port/node";
import { newScopeToken } from "@foundry/gate-ts";

const run = promisify(execFile);
const git = (cwd: string, args: string[]) =>
  run("git", ["-C", cwd, ...args]).then((r) => r.stdout.trim());

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

async function main() {
  const requestedRoot = arg("root");
  if (process.argv.filter(x => x === '--root').length > 1) throw new Error('duplicate --root');
  // A demo must never erase a pre-existing directory, including a prior receipt.
  const root = requestedRoot ?? await mkdtemp(join(tmpdir(), 'foundry-graphvc-'));
  if (requestedRoot) await mkdir(root, {mode:0o700});
  const work = arg("work", join(root, "work"))!;
  // K11 intake is optional: unset (judge default) skips graph writes.
  const lkg = arg("lkg", process.env.LKG_URL ?? "")!;
  const runner = arg(
    "runner",
    join(process.cwd(), "tools", "dist", "gate-runner.mjs"),
  )!;
  const tmpl = arg("tmpl", join(process.cwd(), "tools", "post-receive"))!;

  // The hook shells out to the bundled gate-runner; build it on first run
  // instead of silently recording nothing (tools/dist is gitignored).
  if (!existsSync(runner)) {
    console.log("building gate-runner bundle (first run)…");
    await run("npm", ["run", "bundle:runner"]);
    if (!existsSync(runner)) {
      throw new Error(`gate-runner bundle missing after build: ${runner}`);
    }
  }

  await mkdir(work, { recursive: true });

  const port = new GitAdapter(root);
  await port.create("base");

  // base gets an initial commit
  const basewc = join(work, "basewc");
  await git(work, ["clone", join(root, "base.git"), basewc]);
  await git(basewc, ["config", "user.email", "foundry@local"]);
  await git(basewc, ["config", "user.name", "foundry"]);
  await writeFile(join(basewc, "README.md"), "# base repo\n");
  await git(basewc, ["add", "-A"]);
  await git(basewc, ["commit", "-m", "base: initial"]);
  await git(basewc, ["push", "origin", "main"]);
  const baseSha = await git(join(root, "base.git"), ["rev-parse", "main"]);

  // fork AFTER the base commit so the fork shares the fork point
  const fork = await port.get("base").then((h) => h.fork("fork-1"));

  // seed the task ticket
  const scope = newScopeToken("proj-foundry");
  scope.can_mutate = true;
  const ticket = {
    taskId: "task-1", baseRepo: "base", baseSha,
    forkRepo: "fork-1", agentId: "agent-scratch-88", scope,
  };
  await writeFile(join(root, "tickets.json"), JSON.stringify([ticket], null, 1));
  // intake triples (what POST /tasks would write): task->fork + task->base
  if (lkg) {
    try {
      const kg = new KGClient(lkg);
      for (const t of intakeTriples("task-1", "base", "fork-1")) {
        await kg.addTriple(t);
      }
    } catch (e) {
      console.warn("lkg intake notify failed", e);
    }
  }
  console.log(`fork=${fork.name} baseSha=${baseSha.slice(0, 9)}`);

  // install the hook on the fork
  const hook = (await readFile(tmpl, "utf8"))
    .replaceAll("__ROOT__", root).replaceAll("__NS__", "foundry-local")
    .replaceAll("__LKG__", lkg).replaceAll("__REPO__", "fork-1").replaceAll("__RUNNER__", runner);
  const hookPath = join(root, "fork-1.git", "hooks", "post-receive");
  await writeFile(hookPath, hook);
  await chmod(hookPath, 0o755);

  // agent pushes a proposal to the fork → hook fires
  const forkwc = join(work, "forkwc");
  await git(work, ["clone", join(root, "fork-1.git"), forkwc]);
  await git(forkwc, ["config", "user.email", "agent@local"]);
  await git(forkwc, ["config", "user.name", "agent-scratch-88"]);
  await writeFile(join(forkwc, "feature.txt"), "agent proposal under gate\n");
  await git(forkwc, ["add", "-A"]);
  await git(forkwc, ["commit", "-m", "agent: add feature"]);
  const pushed = await git(forkwc, ["rev-parse", "HEAD"]);
  await git(forkwc, ["push", "origin", "main"]);
  console.log(`pushed=${pushed.slice(0, 9)}`);

  const decisions = await readFile(join(root, "decisions.jsonl"), "utf8").catch(() => "");
  console.log("--- decisions ---");
  process.stdout.write(decisions);
  if (!decisions.trim()) {
    const hookLog = await readFile(join(root, "hook.log"), "utf8").catch(() => "");
    console.error("--- hook.log (tail) ---");
    console.error(hookLog.trim().split("\n").slice(-15).join("\n") || "(empty)");
    throw new Error("gate recorded no decision — the demo did not exercise the gate");
  }
  if (!decisions.includes('"merge"')) {
    throw new Error("gate decision was not a merge — see decisions above");
  }
  const baseMain = await git(join(root, "base.git"), ["log", "--oneline", "-3"]);
  console.log("--- base main log ---");
  console.log(baseMain);
}

main().catch((e) => { console.error(e); process.exit(1); });

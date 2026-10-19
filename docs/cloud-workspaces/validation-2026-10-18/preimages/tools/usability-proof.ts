// usability-proof — one command that says whether Foundry is actually usable.
//
// Runs the whole documented loop in-process against real git repos in a temp
// directory: intake mints a ticket, an agent pushes, the gate decides, the
// merge lands (or does not), and the API surfaces answer. No Cloudflare
// account, no network, no wrangler, nothing outside the temp dir.
//
// Every step prints PASS/FAIL with the observed value, so a reader can see the
// evidence rather than a summary. Exit code is 1 if anything failed.
//
//   npx tsx tools/usability-proof.ts
//
// This is the short path. `npm run demo:graphvc` runs the same gate through a
// real `git push` and a post-receive hook, which is closer to production and
// slower; run both if you are deciding whether to trust the thing.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitAdapter, GitMerger, GitTestKit, runGit } from "@foundry/artifacts-port/node";
import { createApi } from "../workers/api/src/index.js";
import { checkAdmissibility, cheapCost, InMemoryLedger, Layer, newKernelState, newProposedCall } from "@foundry/gate-ts";
import { MemoryDecisionStore, InMemoryTicketStore } from "@foundry/stores";
import type { Verifier } from "@foundry/verify";
import { createTask } from "../workers/orchestrator/src/tasks.js";
import { handlePush, type PipelineDeps } from "../workers/gate/src/pipeline.js";

const NS = "usability";
let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  const mark = ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${label}${detail ? ` — ${detail}` : ""}`);
}

function section(title: string) {
  console.log(`\n== ${title}`);
}

// The gate judges the whole diff between the ticket's fork point and the pushed
// head, so a refused commit keeps poisoning every later proposal until it is
// gone. Rewind the fork (working clone *and* bare) to the last admitted sha.
function rewindFork(repo: string, workdir: string, sha: string) {
  runGit(["reset", "--hard", "--quiet", sha], workdir);
  runGit([`--git-dir=${kit.bare(repo)}`, "update-ref", "refs/heads/main", sha]);
}

function pushBody(repo: string, before: string, after: string) {
  return {
    type: "foundry.local.pushed",
    source: { namespace: NS, repoName: repo },
    payload: { ref: "refs/heads/main", before, after },
  };
}

const root = mkdtempSync(join(tmpdir(), "foundry-usability-"));
const port = new GitAdapter(root);
const kit = new GitTestKit(root, port);
const tickets = new InMemoryTicketStore();
const store = new MemoryDecisionStore();
const forkWork = join(root, "w-fork");
const baseWork = join(root, "w-base");
const deps: PipelineDeps = { port, tickets, store, merger: new GitMerger(root) };

try {
  // ---- 1. Intake -----------------------------------------------------------
  section("1. Task intake (workers/orchestrator)");
  // `createTask` forks whatever base already holds, so give the base one real
  // commit first — otherwise the fork has no fork point and there is nothing
  // for the gate to evaluate a diff against.
  const seeded = await kit.seedBase("base", { "README.md": "# base repo\n" }, baseWork);
  const intake = await createTask(port, tickets, {
    baseRepo: "base",
    taskId: "task-1",
    agents: ["a"],
    allowedRoots: ["src"],
  });
  const forkRepo = intake.dispatches[0].forkRepo;
  const ticket = await tickets.getTicketByFork(forkRepo);
  check("intake forked the task and minted a ticket", intake.dispatches.length === 1, `fork=${forkRepo}`);
  check("the scope carries the declared path roots", JSON.stringify(ticket?.scope.allowed_roots) === '["src"]',
    `allowed_roots=${JSON.stringify(ticket?.scope.allowed_roots)}`);
  check("the granted surface is echoed to the caller", JSON.stringify(intake.allowedRoots) === '["src"]');

  kit.cloneTo(forkRepo, forkWork);
  const base = await port.get("base");
  const base0 = (await base.history("main", 1))[0].sha;
  check("the fork starts from the seeded base commit", base0 === seeded, `${base0.slice(0, 9)}`);

  // ---- 2. The happy path ---------------------------------------------------
  section("2. An agent pushes an allowed change");
  const good = kit.commitAll(forkWork, "agent: add src/feature.ts", { "src/feature.ts": "export const a = 1;\n" });
  const merged = await handlePush(deps, NS, pushBody(forkRepo, base0, good));
  check("the gate admitted it", merged.handled && merged.record.verdict === "merge",
    merged.handled ? `verdict=${merged.record.verdict}` : "not handled");
  const mergedSha = merged.handled ? merged.record.merged_sha : null;
  check("a merge sha was recorded", !!mergedSha, `${mergedSha?.slice(0, 9)}`);
  check("the file reached the base", (await (await port.get("base")).readFile("main", "src/feature.ts")) !== null);
  const base1 = (await (await port.get("base")).history("main", 1))[0].sha;

  // ---- 3. Refusal: outside the declared roots ------------------------------
  section("3. The same agent pushes outside its declared roots");
  const bad = kit.commitAll(forkWork, "agent: touch something else", { "secrets.env": "TOKEN=1\n" });
  const refused = await handlePush(deps, NS, pushBody(forkRepo, base1, bad));
  const reason = refused.handled ? (refused.record.reason as { reason?: string } | null)?.reason : undefined;
  check("the gate refused it", refused.handled && refused.record.verdict === "reject", `verdict=${refused.handled ? refused.record.verdict : "?"}`);
  check("the refusal names the rule that failed", reason === "path_not_allowed", `reason=${reason}`);
  check("the base did not move", (await (await port.get("base")).history("main", 1))[0].sha === base1);
  rewindFork(forkRepo, forkWork, good);

  // ---- 4. Required verification (enforced) ---------------------------------
  section("4. A required check fails, and enforcement is on");
  const contested = kit.commitAll(forkWork, "agent: another allowed change", { "src/two.ts": "export const b = 2;\n" });
  const failing: Verifier = {
    run: async () => ({ checked: true, ok: false, runs: [{ name: "tsc", ok: false, output: "TS2304" }] }),
  };
  deps.verifier = failing;
  deps.verifyEnforce = true;
  const vFail = await handlePush(deps, NS, pushBody(forkRepo, base1, contested));
  const vReason = vFail.handled ? (vFail.record.reason as { reason?: string; message?: string } | null) : null;
  check("the merge was blocked", vFail.handled && vFail.record.verdict === "reject", `verdict=${vFail.handled ? vFail.record.verdict : "?"}`);
  check("the refusal is about verification, not admission", vReason?.reason === "verification_failed", `reason=${vReason?.reason} (${vReason?.message})`);
  check("the base still did not move", (await (await port.get("base")).history("main", 1))[0].sha === base1);

  // ---- 5. Same failure, advisory ------------------------------------------
  section("5. The same failing check, advisory only");
  deps.verifyEnforce = false;
  // A fresh commit: re-pushing `contested` would hit event idempotency and
  // replay the §4 refusal instead of re-deciding.
  const advisorySha = kit.commitAll(forkWork, "agent: one more allowed change", { "src/three.ts": "export const c = 3;\n" });
  const advisory = await handlePush(deps, NS, pushBody(forkRepo, base1, advisorySha));
  check("it merged anyway", advisory.handled && advisory.record.verdict === "merge", `verdict=${advisory.handled ? advisory.record.verdict : "?"}`);

  // ---- 6. The API surfaces -------------------------------------------------
  section("6. The API surfaces answer");
  const app = createApi(store, { tickets });
  const decisions = await app.request("/decisions?limit=50");
  const decisionsBody = (await decisions.json()) as { decisions: unknown[] };
  check("GET /decisions", decisions.status === 200 && decisionsBody.decisions.length >= 4, `${decisionsBody.decisions.length} rows`);

  const history = await app.request("/history.json?limit=50");
  const historyBody = (await history.json()) as { commits: { proposal_sha: string; merge_sha: string | null }[] };
  check("GET /history.json", history.status === 200 && historyBody.commits.length >= 4, `${historyBody.commits.length} commits`);
  check("a refusal has no merge sha", historyBody.commits.some((c) => c.merge_sha === null));

  const spatial = await app.request("/git-history.json");
  const spatialBody = (await spatial.json()) as { branches: string[]; commits: { verdict: string; message: string }[] };
  check("GET /git-history.json (the spatial viewer's own shape)", spatial.status === 200 && Array.isArray(spatialBody.branches) && spatialBody.commits.length >= 4,
    `branches=${JSON.stringify(spatialBody.branches)}`);
  check("the verdict is visible in the viewer's feed", spatialBody.commits.some((c) => c.message.includes("REJECT")) && spatialBody.commits.some((c) => c.message.includes("MERGE")));

  const evidence = await app.request("/evidence/task-1");
  const evidenceBody = (await evidence.json()) as { links: { kind: string }[]; claim: { ok: boolean }; gaps: string[] };
  check("GET /evidence/:taskId recovers the chain", evidence.status === 200 && evidenceBody.claim.ok, `${evidenceBody.links.length} links`);
  check("it names the legs that are missing", evidenceBody.gaps.length > 0, evidenceBody.gaps[0]);

  const ghost = await app.request("/evidence/ghost");
  check("an unrecoverable task is 404, not an empty success", ghost.status === 404);

  // ---- 7. The kernel on its own -------------------------------------------
  section("7. Kernel rule 10, called directly");
  const syscall = {
    id: "foundry.merge",
    layer: Layer.OBSERVE,
    mutability: "read_only" as const,
    cost: cheapCost(),
    maxSnapshotAgeMs: null,
    validateArgs: () => {},
  };
  const traversed = checkAdmissibility(
    syscall,
    newProposedCall("foundry.merge", { path: "src/../secrets.env" }, ticket!.scope),
    newKernelState(),
    new InMemoryLedger(),
  );
  check("a traversal out of the root is refused", !traversed.ok, traversed.ok ? "admitted" : `reason=${traversed.reason.reason}`);

  base.dispose();
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? "\nALL PASS — the loop from intake to API surface works on this machine."
    : `\n${failures} FAILED — see above.`,
);
process.exit(failures === 0 ? 0 : 1);

// lkg-path-proof — live receipt that the canonical Foundry write path lands:
// task intake -> fork -> merge verdict -> touches, and that the overlap
// oracle reads them back. Writes synthetic task:<ts> triples; asserts the
// contender the oracle returns. Run: npm run proof:lkg -- --lkg <url>
import {
  intakeTriples,
  KGClient,
  KgOverlapOracle,
  touchTriples,
  verdictTriples,
} from "@foundry/lkg-client";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

async function main() {
  const base = arg("lkg", process.env.LKG_URL ?? "http://127.0.0.1:8002")!;
  const kg = new KGClient(base);
  const stamp = Date.now();
  const taskA = `proof-a-${stamp}`;
  const taskB = `proof-b-${stamp}`;
  const baseRepo = "proof-base";
  const forkA = `proof-fork-a-${stamp}`;
  const shaA = `aaa${stamp}`;
  const sharedPath = `proof/shared-${stamp}.txt`;

  const writes = [
    ...intakeTriples(taskA, baseRepo, forkA),
    ...verdictTriples({
      after_sha: shaA,
      merged_sha: `mmm${stamp}`,
      repo: baseRepo,
      verdict: "merge",
      agent_id: "proof-agent",
      task_id: taskA,
    }),
    ...touchTriples(shaA, [sharedPath, `proof/only-a-${stamp}.txt`]),
  ];
  for (const t of writes) await kg.addTriple(t);

  // Read-back: task A triples queryable.
  const back = await kg.query(`task:${taskA}`);
  const sawFork = back.some(
    (r) => r.predicate === "has_fork" && r.object === `repo:${forkA}`,
  );
  if (!sawFork) {
    throw new Error(`intake triple missing in read-back: ${JSON.stringify(back)}`);
  }

  // Overlap: task B on the same base touching the shared path sees task A.
  const oracle = new KgOverlapOracle(kg, { timeoutMs: 10000 });
  const contenders = await oracle.findContenders({
    baseRepo,
    taskId: taskB,
    paths: [sharedPath],
    knownCommits: [],
  });
  console.log(
    JSON.stringify(
      { base, taskA, wrote: writes.length, readBack: back.length, contenders },
      null,
      1,
    ),
  );
  if (!contenders || !contenders.includes(sharedPath)) {
    throw new Error(`oracle missed contender ${sharedPath}: ${contenders}`);
  }
  console.log("LKG PATH PROOF OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// ppact-loop — first consumer of the pPACT advisory server.
//   printf '<turn text>' | tsx tools/ppact-loop.ts --k 5
//   tsx tools/ppact-loop.ts --text "deploy the canary" --pick 0
// Env: PPACT_URL (default http://localhost:8760, via ssh tunnel to Mac4).
// Prints ranked next-turn proposals with PACT receipts; --pick N appends a
// selection receipt to --log (default ./ppact-receipts.jsonl).

interface PactReceipt {
  checked: boolean;
  members: string[];
  compose_rate: number | null;
  pairs: { a: string; b: string; op: string }[];
}

interface Proposal {
  id: string;
  score: number;
  roles: string[];
  excerpt: string;
  refs: string[];
  pact: PactReceipt;
}

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

async function main(): Promise<void> {
  const base = process.env.PPACT_URL ?? "http://localhost:8760";
  const k = Number(arg("k", "5"));
  const text = arg("text") ?? (process.stdin.isTTY ? "" : await readStdin());
  if (!text.trim()) {
    console.error("usage: ppact-loop --text '<turn>' [--k 5] [--pick N] [--log file]");
    process.exit(2);
  }
  const res = await fetch(`${base}/propose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, k }),
  });
  if (!res.ok) {
    console.error(`ppact server error: ${res.status}`);
    process.exit(1);
  }
  const { proposals } = (await res.json()) as { proposals: Proposal[] };
  proposals.forEach((p, i) => {
    const r = p.pact;
    const verdict = !r.checked
      ? "uncheckable (<2 members)"
      : `compose ${(r.compose_rate ?? 0).toFixed(2)}`;
    console.log(`[${i}] ${p.score.toFixed(4)} ${p.id} :: ${verdict}`);
    console.log(`    roles=${p.roles.join(",") || "-"} refs=${p.refs.slice(0, 3).join(", ") || "-"}`);
    console.log(`    ${p.excerpt.slice(0, 160).replace(/\n/g, " ")}`);
  });
  const pick = arg("pick");
  if (pick !== undefined) {
    const p = proposals[Number(pick)];
    if (!p) {
      console.error(`no proposal ${pick}`);
      process.exit(1);
    }
    const receipt = {
      ts: new Date().toISOString(),
      query: text.slice(0, 200),
      picked: p.id,
      score: p.score,
      pact: p.pact,
    };
    const { appendFile } = await import("node:fs/promises");
    await appendFile(arg("log", "./ppact-receipts.jsonl")!, JSON.stringify(receipt) + "\n");
    console.log(`receipt -> ${arg("log", "./ppact-receipts.jsonl")}`);
  }
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});

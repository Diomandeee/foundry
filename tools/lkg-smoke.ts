// lkg-smoke — live check that KGClient talks to a running Graph Kernel:
// write a probe triple, read it back, and traverse from it.
import { KGClient } from "@foundry/lkg-client";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

async function main() {
  const base = arg("lkg", process.env.LKG_URL ?? "http://127.0.0.1:8002")!;
  const kg = new KGClient(base);
  const id = `smoke:${Date.now()}`;

  await kg.addTriple({
    subject: id,
    predicate: "checks",
    object: "graph_kernel",
    source: "foundry",
  });
  const rows = await kg.query(id);
  const path = await kg.traverse(id, 2);

  console.log(JSON.stringify({ base, wrote: id, query: rows, traverse: path }, null, 1));
  if (rows.length < 1) throw new Error(`expected >=1 triple, got ${rows.length}`);
  if (!path.paths.some((p) => p.edges.some((e) => e.predicate === "checks"))) {
    throw new Error("traverse did not return the checks edge");
  }
  console.log("LKG SMOKE OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

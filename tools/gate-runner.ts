// gate-runner — run Foundry's gate on a local push event and record the
// verdict as graph edges. Invoked by a git post-receive hook:
//   printf '{"type":"foundry.local.pushed",...}' | tsx gate-runner.ts --root <repos>
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { GitAdapter, GitMerger } from "@foundry/artifacts-port";
import { KGClient, touchTriples, verdictTriples } from "@foundry/lkg-client";
import type { TicketStore, TaskTicket, DecisionStore, DecisionRecord } from "@foundry/stores";
import { serializeScope, reviveScope } from "@foundry/stores";
import { handlePush } from "../workers/gate/src/pipeline.js";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

class JsonTicketStore implements TicketStore {
  constructor(private file: string) {}
  private async load(): Promise<TaskTicket[]> {
    try {
      const rows = JSON.parse(await readFile(this.file, "utf8")) as TaskTicket[];
      return rows.map((r) => ({
        ...r,
        scope: reviveScope(JSON.stringify(r.scope)),
      }));
    } catch {
      return [];
    }
  }
  async getTicketByFork(forkRepo: string) {
    return (await this.load()).find((t) => t.forkRepo === forkRepo) ?? null;
  }
  async saveTicket(t: TaskTicket) {
    const all = await this.load();
    const row = { ...t, scope: JSON.parse(serializeScope(t.scope)) };
    const i = all.findIndex((x) => x.forkRepo === t.forkRepo);
    if (i >= 0) all[i] = row as TaskTicket;
    else all.push(row as TaskTicket);
    await writeFile(this.file, JSON.stringify(all, null, 1));
  }
}

class JsonlDecisionStore implements DecisionStore {
  constructor(private file: string) {}
  async record(d: Omit<DecisionRecord, "id" | "decided_at">) {
    const rows = await this.list();
    const row = {
      ...d,
      id: rows.length + 1,
      decided_at: new Date().toISOString(),
    } as DecisionRecord;
    await appendFile(this.file, JSON.stringify(row) + "\n");
    return row;
  }
  async list(repo?: string, limit = 50) {
    const raw = await readFile(this.file, "utf8").catch(() => "");
    const rows = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as DecisionRecord);
    const filtered = repo ? rows.filter((r) => r.repo === repo) : rows;
    return filtered.slice(-limit).reverse();
  }
}

async function readStdin(): Promise<string> {
  return new Promise((res) => {
    let b = "";
    process.stdin.on("data", (c: Buffer) => (b += String(c)));
    process.stdin.on("end", () => res(b.trim()));
  });
}

async function main() {
  const root = arg("root")!;
  const ns = arg("namespace", "foundry-local")!;
  const lkg = arg("lkg", process.env.LKG_URL ?? "http://127.0.0.1:8002")!;
  const event = JSON.parse(await readStdin());

  const deps = {
    port: new GitAdapter(root),
    tickets: new JsonTicketStore(join(root, "tickets.json")),
    store: new JsonlDecisionStore(join(root, "decisions.jsonl")),
    merger: new GitMerger(root),
  };

  const result = await handlePush(deps, ns, event);
  if (!result.handled) { console.log("event not handled (not a push)"); return; }
  const r = result.record;
  console.log(`verdict=${r.verdict} after=${r.after_sha.slice(0, 9)} merged=${r.merged_sha?.slice(0, 9) ?? "-"}` +
              (r.reason ? ` reason=${JSON.stringify(r.reason)}` : ""));

  const kg = new KGClient(lkg, process.env.LKG_TOKEN);
  const triples = [...verdictTriples(r), ...touchTriples(r.after_sha, r.files ?? [])];
  for (const t of triples) {
    try { await kg.addTriple(t); console.log(`graph += ${t.subject} -${t.predicate}-> ${t.object}`); }
    catch (e) { console.warn(`graph append failed: ${(e as Error).message}`); }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

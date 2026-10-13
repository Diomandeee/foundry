// Evidence recovery: the read path counterpart to the gate's write path.
//
// Given a task, repo+sha, or claim, recover the chain of records that
// justifies it: ticket -> gate decisions -> LKG triples -> memory hits.
// Every link carries a pointer; a chain with no links is returned as
// unrecoverable, never as an empty success.
import type { KGClient, StoredTriple } from "@foundry/lkg-client";
import type {
  DecisionRecord,
  DecisionStore,
  TaskTicket,
  TicketStore,
} from "@foundry/stores";

export interface EvidenceLink {
  kind: "ticket" | "decision" | "triple" | "memory";
  /** Stable pointer the claim gate can re-fetch (id, sha, parcel id). */
  pointer: string;
  summary: string;
}

export interface EvidenceChain {
  subject: string;
  links: EvidenceLink[];
  /** True when no leg produced evidence. The caller must not claim. */
  unrecoverable: boolean;
  gaps: string[];
}

/** Memory-leg client (K11 parcels). Injected so the core stays offline-safe. */
export interface MemoryLeg {
  search(query: string, k?: number): Promise<
    Array<{ id: string; kind: string; source: string; text: string }>
  >;
}

export interface EvidenceStores {
  tickets: TicketStore;
  decisions: DecisionStore;
  kg?: KGClient;
  memory?: MemoryLeg;
}

function link(
  kind: EvidenceLink["kind"],
  pointer: string,
  summary: string,
): EvidenceLink {
  return { kind, pointer, summary };
}

/** Recover the chain behind a task: ticket, decisions, LKG intake triples. */
export async function recoverTask(
  stores: EvidenceStores,
  taskId: string,
): Promise<EvidenceChain> {
  const links: EvidenceLink[] = [];
  const gaps: string[] = [];

  // Decisions carry the task_id; the ticket is found via the fork repo.
  const decisions = await stores.decisions.list();
  const mine = decisions.filter((d) => d.task_id === taskId);
  let ticket: TaskTicket | null = null;
  const forks = [...new Set(mine.map((d) => d.repo))];
  for (const fork of forks) {
    ticket = await stores.tickets.getTicketByFork(fork);
    if (ticket) break;
  }
  if (ticket) {
    links.push(
      link(
        "ticket",
        `ticket:${ticket.forkRepo}`,
        `task ${ticket.taskId} agent ${ticket.agentId} ` +
          `fork ${ticket.forkRepo} @ ${ticket.baseSha.slice(0, 8)}`,
      ),
    );
  } else {
    gaps.push(`no ticket resolves task ${taskId}`);
  }

  for (const d of mine) {
    links.push(
      link(
        "decision",
        `decision:${d.id ?? `${d.repo}@${d.after_sha.slice(0, 8)}`}`,
        `${d.verdict} ${d.repo} ${d.before_sha.slice(0, 8)}..` +
          `${d.after_sha.slice(0, 8)}` +
          (d.merged_sha ? ` merged ${d.merged_sha.slice(0, 8)}` : "") +
          (d.reason ? ` reason=${JSON.stringify(d.reason).slice(0, 120)}` : ""),
      ),
    );
  }
  if (mine.length === 0) gaps.push(`no gate decisions for task ${taskId}`);

  if (stores.kg) {
    try {
      const triples: StoredTriple[] = await stores.kg.query(
        `task:${taskId}`,
        { limit: 20 },
      );
      for (const t of triples) {
        links.push(
          link(
            "triple",
            `triple:${t.subject} ${t.predicate} ${t.object}`,
            `${t.predicate} -> ${t.object}`,
          ),
        );
      }
      if (triples.length === 0) gaps.push(`no LKG triples for task:${taskId}`);
    } catch (e) {
      gaps.push(`LKG unreachable: ${(e as Error).message.slice(0, 100)}`);
    }
  } else {
    gaps.push("no KG client configured");
  }

  return {
    subject: `task:${taskId}`,
    links,
    unrecoverable: links.length === 0,
    gaps,
  };
}

/** Recover the chain behind a merged sha: the decision that merged it. */
export async function recoverSha(
  stores: EvidenceStores,
  repo: string,
  sha: string,
): Promise<EvidenceChain> {
  const links: EvidenceLink[] = [];
  const gaps: string[] = [];
  const decisions = await stores.decisions.list(repo, 200);
  const hit = decisions.find(
    (d) => d.merged_sha === sha || d.after_sha === sha,
  );
  if (!hit) {
    return {
      subject: `${repo}@${sha.slice(0, 8)}`,
      links,
      unrecoverable: true,
      gaps: [`no decision merged ${sha.slice(0, 12)} in ${repo}`],
    };
  }
  links.push(
    link(
      "decision",
      `decision:${hit.id ?? sha.slice(0, 8)}`,
      `${hit.verdict} ${hit.before_sha.slice(0, 8)}..${hit.after_sha.slice(0, 8)}` +
        (hit.task_id ? ` task ${hit.task_id}` : "") +
        (hit.agent_id ? ` agent ${hit.agent_id}` : ""),
    ),
  );
  if (hit.task_id) {
    const sub = await recoverTask(stores, hit.task_id);
    links.push(...sub.links);
    gaps.push(...sub.gaps);
  }
  return {
    subject: `${repo}@${sha.slice(0, 8)}`,
    links,
    unrecoverable: links.length === 0,
    gaps,
  };
}

/** Recover memory evidence for a claim: parcel hits as links. */
export async function recoverClaim(
  stores: EvidenceStores,
  claim: string,
  k = 4,
): Promise<EvidenceChain> {
  if (!stores.memory) {
    return {
      subject: claim,
      links: [],
      unrecoverable: true,
      gaps: ["no memory leg configured"],
    };
  }
  const hits = await stores.memory.search(claim, k);
  const links = hits.map((h) =>
    link("memory", `${h.kind}:${h.id}`, `${h.source} :: ${h.text.slice(0, 160)}`)
  );
  return {
    subject: claim,
    links,
    unrecoverable: links.length === 0,
    gaps: links.length === 0 ? ["memory returned no hits"] : [],
  };
}

/** Claim gate: a claim is printable only when its chain is recoverable. */
export function checkClaim(chain: EvidenceChain): {
  ok: boolean;
  safe: string;
} {
  if (chain.unrecoverable) {
    return {
      ok: false,
      safe: `UNRECOVERABLE ${chain.subject}: ${chain.gaps.join("; ")}`,
    };
  }
  return {
    ok: true,
    safe: `${chain.subject} [${chain.links.map((l) => l.pointer).join(", ")}]`,
  };
}

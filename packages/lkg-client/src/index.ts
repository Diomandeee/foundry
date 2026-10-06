// Re-exports: canonical triple shapes + cross-task overlap oracle.
export { intakeTriples, touchTriples, verdictTriples, type VerdictRecord } from "./triples.js";
export { KgOverlapOracle, type KgOverlapOpts, type OverlapInput, type OverlapOracle } from "./overlap.js";

// KGClient — fetch client for the Live Knowledge Graphs REST API.
// Shapes follow graph-kernel/src/service/knowledge_handlers.rs exactly:
// query unwraps {triples,total}; traverse posts {start,max_hops,...} and
// returns {paths,stats}. Default target is the K11 graph (port 8002).

export interface NewTriple {
  subject: string;
  predicate: string;
  object: string;
  confidence?: number;
  source?: string;
}

export interface StoredTriple {
  id?: number;
  subject: string;
  predicate: string;
  object: string;
  confidence?: number;
  source?: string;
  created_at?: string;
}

export interface TraversalEdge {
  subject: string;
  predicate: string;
  object: string;
  confidence?: number;
}

/** Raw edge as served (K11: {predicate,source,target}; repo: full triple). */
interface RawEdge {
  predicate: string;
  source?: string;
  target?: string;
  subject?: string;
  object?: string;
  confidence?: number;
}

function normalizeEdge(e: RawEdge): TraversalEdge {
  return {
    subject: e.subject ?? e.source ?? "",
    predicate: e.predicate,
    object: e.object ?? e.target ?? "",
    ...(e.confidence !== undefined ? { confidence: e.confidence } : {}),
  };
}

export interface TraversalPath {
  entities: string[];
  edges: TraversalEdge[];
  hops: number;
  min_confidence: number;
}

export interface TraversalStats {
  entities_visited?: number;
  edges_traversed?: number;
  elapsed_ms?: number;
  nodes?: number;
  start?: string;
}

export interface TraversalResponse {
  paths: TraversalPath[];
  stats: TraversalStats;
}

export interface TraverseOpts {
  direction?: string;
  maxResults?: number;
  predicates?: string[];
  minConfidence?: number;
  signal?: AbortSignal;
}

export interface QueryOpts {
  predicate?: string;
  object?: string;
  minConfidence?: number;
  limit?: number;
  signal?: AbortSignal;
}

export class KGClient {
  constructor(
    private baseUrl: string,
    private token?: string,
  ) {}

  /** Bearer header for private Graph Kernel Spaces; empty for public K11. */
  private authHeaders(): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
  }

  async addTriple(t: NewTriple): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/api/knowledge`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.authHeaders() },
      body: JSON.stringify({
        subject: t.subject,
        predicate: t.predicate,
        object: t.object,
        ...(t.confidence !== undefined ? { confidence: t.confidence } : {}),
        ...(t.source !== undefined ? { source: t.source } : {}),
      }),
    });
    if (!res.ok) throw new Error(`KG addTriple failed: ${res.status}`);
    return res.json();
  }

  async query(subject: string, opts: QueryOpts = {}): Promise<StoredTriple[]> {
    const params = new URLSearchParams({ subject });
    if (opts.predicate) params.set("predicate", opts.predicate);
    if (opts.object) params.set("object", opts.object);
    if (opts.minConfidence !== undefined) {
      params.set("min_confidence", String(opts.minConfidence));
    }
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    const init: RequestInit = {};
    const auth = this.authHeaders();
    if (Object.keys(auth).length > 0) init.headers = auth;
    if (opts.signal) init.signal = opts.signal;
    const res = await fetch(`${this.baseUrl}/api/knowledge?${params}`, init);
    if (!res.ok) throw new Error(`KG query failed: ${res.status}`);
    // Live K11 serves a bare array; repo source wraps in {triples,total}.
    const body = (await res.json()) as
      | StoredTriple[]
      | { triples: StoredTriple[] };
    return Array.isArray(body) ? body : body.triples;
  }

  async traverse(
    entity: string,
    maxHops = 3,
    opts: TraverseOpts = {},
  ): Promise<TraversalResponse> {
    const res = await fetch(`${this.baseUrl}/api/knowledge/traverse`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.authHeaders() },
      body: JSON.stringify({
        start: entity,
        max_hops: maxHops,
        // NOTE: live K11 returns [] for "outgoing"; "both" works.
        direction: opts.direction ?? "both",
        max_results: opts.maxResults ?? 100,
        ...(opts.predicates ? { predicates: opts.predicates } : {}),
        ...(opts.minConfidence !== undefined
          ? { min_confidence: opts.minConfidence }
          : {}),
        return_paths: true,
      }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok) throw new Error(`KG traverse failed: ${res.status}`);
    const body = (await res.json()) as {
      paths: Array<{
        entities?: string[];
        edges: RawEdge[];
        hops?: number;
        min_confidence?: number;
      }>;
      stats: TraversalStats;
    };
    return {
      stats: body.stats,
      paths: body.paths.map((p) => ({
        entities: p.entities ?? [],
        edges: p.edges.map(normalizeEdge),
        hops: p.hops ?? p.edges.length,
        min_confidence: p.min_confidence ?? 0,
      })),
    };
  }
}

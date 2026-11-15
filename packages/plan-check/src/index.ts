// PlanCheck port — PACT chain validation at task intake.
// Pure interface + stub (advisory pass) + PACT-server client.
// Server contract: POST /api/check-chains {chains: string[]} ->
// {results: [{name, found, present?, missing?, typechecks?, word?}]}.
// A chain is usable when it is found and typechecks. `present`/`missing`
// count the four canonical stages (fan-out, execute, select, repeat); a
// pipeline lacks some by design (PACT finding 0009: a chain rooted at
// Subject cannot close), so they describe the chain and never block.
// Outages fail open (checked=false, ok=true); only negative verdicts
// can block, and only when the caller enforces.
export interface ChainCheckResult {
  name: string;
  found: boolean;
  present?: number;
  missing?: string[];
  typechecks?: boolean;
  word?: string;
}

export interface PlanVerdict {
  /** False when no server is configured or it was unreachable. */
  checked: boolean;
  /** False when a declared chain is missing or unusable. */
  ok: boolean;
  results: ChainCheckResult[];
  error?: string;
}

export interface PlanCheck {
  check(chains: string[]): Promise<PlanVerdict>;
}

/** Advisory pass: records that nothing was checked. Default when PACT_URL unset. */
export class StubPlanCheck implements PlanCheck {
  async check(chains: string[]): Promise<PlanVerdict> {
    return { checked: false, ok: true, results: chains.map((name) => ({ name, found: true })) };
  }
}

export interface PactServerOpts {
  timeoutMs?: number;
  /** Route the request, e.g. through a Workers VPC binding to a private host. Defaults to fetch. */
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
}

/** Found and typechecking. Missing canonical stages are reported, not refused. */
export function usable(r: ChainCheckResult | undefined): boolean {
  return !!r && r.found && r.typechecks !== false;
}

export class PactServerPlanCheck implements PlanCheck {
  constructor(
    private baseUrl: string,
    private opts: PactServerOpts = {},
  ) {}

  async check(chains: string[]): Promise<PlanVerdict> {
    if (chains.length === 0) return { checked: true, ok: true, results: [] };
    try {
      const send = this.opts.fetcher ?? ((url: string, init: RequestInit) => fetch(url, init));
      const res = await send(`${this.baseUrl}/api/check-chains`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chains }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 2000),
      });
      if (!res.ok) {
        return { checked: false, ok: true, results: [], error: `pact ${res.status}` };
      }
      const body = (await res.json()) as { results?: ChainCheckResult[] };
      const results = Array.isArray(body.results) ? body.results : [];
      const byName = new Map(results.map((r) => [r.name, r]));
      return { checked: true, ok: chains.every((name) => usable(byName.get(name))), results };
    } catch (e) {
      return {
        checked: false,
        ok: true,
        results: [],
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
}

// PlanCheck port — PACT chain validation at task intake.
// Pure interface + stub (advisory pass) + PACT-server client.
// Server contract: POST /api/check-chains {chains: string[]} ->
// {results: [{name, found, present?, missing?, typechecks?, word?}]}.
// A chain is usable when found, fully present, and typechecking.
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
}

export class PactServerPlanCheck implements PlanCheck {
  constructor(
    private baseUrl: string,
    private opts: PactServerOpts = {},
  ) {}

  async check(chains: string[]): Promise<PlanVerdict> {
    if (chains.length === 0) return { checked: true, ok: true, results: [] };
    try {
      const res = await fetch(`${this.baseUrl}/api/check-chains`, {
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
      const usable = (name: string): boolean => {
        const r = byName.get(name);
        return (
          !!r && r.found && (r.missing?.length ?? 0) === 0 && r.typechecks !== false
        );
      };
      return { checked: true, ok: chains.every(usable), results };
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

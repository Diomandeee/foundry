// Verify port — the checks a repository declares must pass before a merge is
// finalised.
//
// This is deliberately NOT admission control. Admission asks whether a proposal
// MAY land (ticket, scope, freshness, conflicts) and its answers are
// deterministic. Verification asks whether the result is CORRECT, its answers
// depend on the repository, and a refusal here means "admissible but not
// verified" — a different statement, recorded as a different reason.
//
// Posture, mirroring @foundry/plan-check:
//
// - Not configured, or unreachable, is `checked: false, ok: true`. It never
//   blocks under legacy advisory policy. A separately selected requireChecked
//   policy can block missing evidence without calling it a failed test.
// - A missing or absent runner is `checked: false` too, for the same reason:
//   "nothing ran" must never be recorded as "the tests passed".
// - Only `checked: true, ok: false` can block, and only when the caller sets
//   `verifyEnforce`. Enforcement is the caller's decision, not this module's.
//
// Every request carries the exact revision the checks run against, so a result
// can never be attached to a different commit than the one that was tested.

export interface CheckRun {
  name: string;
  ok: boolean;
  /** Bounded, secret-free summary. */
  output?: string;
}

export interface VerifyVerdict {
  /** False when no verifier was configured or it could not be reached. */
  checked: boolean;
  /** False when at least one check ran and failed. */
  ok: boolean;
  runs: CheckRun[];
  error?: string;
}

export interface VerifyRequest {
  /** The fork the proposal came from. */
  repo: string;
  /** The branch the result would land on. */
  baseBranch: string;
  /** Paths the proposal changes, so a checker can scope its work. */
  files: readonly string[];
  /** The exact revision tested. Recorded with the outcome, always. */
  headSha: string;
}

export interface Verifier {
  run(req: VerifyRequest): Promise<VerifyVerdict>;
}

/** One check's output cannot be allowed to fill the ledger. */
export const MAX_OUTPUT_CHARS = 400;

export function truncateOutput(s: string): string {
  return s.length <= MAX_OUTPUT_CHARS
    ? s
    : `${s.slice(0, MAX_OUTPUT_CHARS)}…`;
}

/** Advisory pass: records that nothing was checked. Default when unset. */
export class StubVerifier implements Verifier {
  async run(_req: VerifyRequest): Promise<VerifyVerdict> {
    return { checked: false, ok: true, runs: [] };
  }
}

export interface HttpVerifierOpts {
  timeoutMs?: number;
}

/**
 * Server contract:
 *   POST <baseUrl>/api/verify
 *     { repo, baseBranch, files, headSha }
 *     -> { runs: [{ name, ok, output? }] }
 *
 * A non-2xx response or a transport failure is an outage (`checked: false`),
 * never a failed check: a verifier that is down has not judged the change.
 */
export class HttpVerifier implements Verifier {
  constructor(
    private baseUrl: string,
    private opts: HttpVerifierOpts = {},
  ) {}

  async run(req: VerifyRequest): Promise<VerifyVerdict> {
    try {
      const res = await fetch(`${this.baseUrl}/api/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
      });
      if (!res.ok) {
        return {
          checked: false,
          ok: true,
          runs: [],
          error: `verify ${res.status}`,
        };
      }
      const body = (await res.json()) as { runs?: CheckRun[] };
      const runs: CheckRun[] = (Array.isArray(body.runs) ? body.runs : []).map(
        (r) => ({
          name: String(r.name),
          ok: r.ok === true,
          ...(r.output === undefined
            ? {}
            : { output: truncateOutput(String(r.output)) }),
        }),
      );
      // No runs is "nothing was verified", not "everything passed".
      if (runs.length === 0) {
        return { checked: false, ok: true, runs, error: "no checks ran" };
      }
      return { checked: true, ok: runs.every((r) => r.ok), runs };
    } catch (e) {
      return {
        checked: false,
        ok: true,
        runs: [],
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
}

/**
 * Whether a verdict should stop a merge. A function, because the two rules that
 * matter — legacy enforcement blocks checked failures; an explicit independent
 * requireChecked policy also blocks missing evidence — live in one place.
 */
export function blocksMerge(v: VerifyVerdict, enforce: boolean, requireChecked=false): boolean {
  return (requireChecked && (!v.checked || !v.ok)) || (enforce && v.checked && !v.ok);
}

/** One secret-free line for the decision record, and for operators. */
export function summarize(v: VerifyVerdict): string {
  if (!v.checked) {
    return v.error ? `not checked: ${v.error}` : "not checked";
  }
  const failed = v.runs.filter((r) => !r.ok);
  if (failed.length === 0) return `passed ${v.runs.length} check(s)`;
  return `failed ${failed.map((r) => r.name).join(", ")}`;
}

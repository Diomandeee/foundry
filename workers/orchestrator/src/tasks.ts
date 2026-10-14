// Task intake core: base resolve → fork per agent → ticket + scope → dispatch.
// Pure over ArtifactsPort + TicketStore; the Hono route adds HTTP + KG notify.
import type { ArtifactsPort } from "@foundry/artifacts-port";
import { newScopeToken } from "@foundry/gate-ts";
import { StubPlanCheck, type PlanCheck, type PlanVerdict } from "@foundry/plan-check";
import type { TicketStore } from "@foundry/stores";

export interface CreateTaskInput {
  baseRepo: string;
  taskId: string;
  agents: string[];
  instructions?: string;
  scopeTtlMs?: number;
  /** PACT chain names the agents will run; validated at intake. */
  chains?: string[];
  /** Reject the task when the plan check reports unusable chains. */
  planCheckEnforce?: boolean;
}

export interface AgentDispatch {
  agentId: string;
  forkRepo: string;
  remote: string;
  token: string;
  instructions: string;
  baseSha: string;
}

export interface CreateTaskResult {
  taskId: string;
  baseRepo: string;
  baseSha: string;
  dispatches: AgentDispatch[];
  planCheck: PlanVerdict;
  /**
   * Operator follow-ups: the event API is per-repo, so each fork must be
   * subscribed before its pushes reach the gate. Run with the env name
   * filled in (`staging` or `production`).
   */
  subscribeCommands: string[];
}

const NAME = /^[A-Za-z0-9._-]{1,64}$/;
const CHAIN = /^[A-Za-z0-9._:-]{1,80}$/;

function validate(input: CreateTaskInput): void {
  if (!input || typeof input !== "object") throw new Error("invalid body");
  if (!NAME.test(input.baseRepo ?? "")) throw new Error("invalid baseRepo");
  if (!NAME.test(input.taskId ?? "")) throw new Error("invalid taskId");
  if (!Array.isArray(input.agents) || input.agents.length < 1) {
    throw new Error("invalid agents: need 1..20 agent ids");
  }
  if (input.agents.length > 20) {
    throw new Error("invalid agents: need 1..20 agent ids");
  }
  for (const a of input.agents) {
    if (typeof a !== "string" || !NAME.test(a)) {
      throw new Error(`invalid agent id: ${String(a)}`);
    }
  }
  if (new Set(input.agents).size !== input.agents.length) {
    throw new Error("invalid agents: duplicate ids");
  }
  if (input.chains !== undefined) {
    if (!Array.isArray(input.chains)) throw new Error("invalid chains: need an array");
    for (const c of input.chains) {
      if (typeof c !== "string" || !CHAIN.test(c)) {
        throw new Error(`invalid chain name: ${String(c)}`);
      }
    }
  }
}

export async function createTask(
  port: ArtifactsPort,
  tickets: TicketStore,
  input: CreateTaskInput,
  now: number = Date.now(),
  planCheck: PlanCheck = new StubPlanCheck(),
): Promise<CreateTaskResult> {
  validate(input);

  // Intake plan check runs BEFORE any fork exists: a bad plan rejects
  // without side effects. Advisory unless planCheckEnforce; outages
  // always fail open (checked=false, ok=true).
  const chains = input.chains ?? [];
  const verdict = await planCheck.check(chains);
  if (!verdict.ok && input.planCheckEnforce) {
    const bad = new Set<string>();
    for (const r of verdict.results) {
      if (!r.found || (r.missing?.length ?? 0) > 0 || r.typechecks === false) bad.add(r.name);
    }
    for (const c of chains) {
      if (!verdict.results.some((r) => r.name === c)) bad.add(c);
    }
    throw new Error(`invalid plan: chains not usable: ${[...bad].join(", ") || chains.join(", ")}`);
  }

  let base;
  try {
    base = await port.get(input.baseRepo);
  } catch {
    await port.create(input.baseRepo, { defaultBranch: "main" });
    base = await port.get(input.baseRepo);
  }
  try {
    const info = await base.info();
    const hist = await base.history(info.defaultBranch, 1);
    const baseSha = hist.length > 0 ? hist[0].sha : "";
    const instructions =
      input.instructions ??
      (await base.readFile(info.defaultBranch, "AGENTS.md")) ??
      "";

    const dispatches: AgentDispatch[] = [];
    for (const agentId of input.agents) {
      const forkRepo = `${input.taskId}--${agentId}`;
      const fork = await base.fork(forkRepo);
      const scope = newScopeToken();
      scope.allowed_tools = ["foundry.merge"];
      scope.can_mutate = true;
      scope.expires_at = now + (input.scopeTtlMs ?? 4 * 3_600_000);
      await tickets.saveTicket({
        taskId: input.taskId,
        baseRepo: input.baseRepo,
        baseSha,
        forkRepo,
        agentId,
        scope,
      });
      dispatches.push({
        agentId,
        forkRepo,
        remote: fork.remote,
        token: fork.token,
        instructions,
        baseSha,
      });
    }
    const subscribeCommands = dispatches.map(
      (d) => `bash tools/subscribe-repo.sh <env> '${d.forkRepo}'`,
    );
    return {
      taskId: input.taskId,
      baseRepo: input.baseRepo,
      baseSha,
      dispatches,
      planCheck: verdict,
      subscribeCommands,
    };
  } finally {
    base.dispose();
  }
}

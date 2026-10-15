// handlePush — full gate pipeline: normalize event → decide → merge → record.
// Deps-injected so tests use fakes and the Worker uses real bindings + D1.
import {
  StaleBaseError,
  toPushEvent,
  type ArtifactsPort,
  type PushEvent,
} from "@foundry/artifacts-port";
import { decidePush } from "./decide.js";
import type { Merger } from "./merge.js";
import type { OverlapOracle } from "@foundry/lkg-client";
import type { PlanCheck } from "@foundry/plan-check";
import type {
  DecisionRecord,
  DecisionStore,
  TicketStore,
} from "@foundry/stores";

export interface PipelineDeps {
  port: ArtifactsPort;
  tickets: TicketStore;
  store: DecisionStore;
  merger: Merger;
  overlap?: OverlapOracle;
  planCheck?: PlanCheck;
  planCheckEnforce?: boolean;
  /** When true, pipeline-error reasons carry the stack (DEBUG=1). */
  debug?: boolean;
}

export type PipelineResult =
  | { handled: true; record: DecisionRecord }
  | { handled: false };

export async function handlePush(
  deps: PipelineDeps,
  namespace: string,
  rawBody: Parameters<typeof toPushEvent>[1],
  now: number = Date.now(),
): Promise<PipelineResult> {
  const push: PushEvent | null = toPushEvent(namespace, rawBody);
  if (!push) return { handled: false };

  // Idempotent redelivery: this exact event already has a decision.
  const prior = await deps.store.findByEvent(
    push.namespace,
    push.repo,
    push.ref,
    push.before,
    push.after,
  );
  if (prior) return { handled: true, record: prior };

  try {
    // One stale-base retry: re-decide against the moved base, then give up
    // to a conflict record rather than landing on an unchecked head.
    for (let attempt = 0; ; attempt++) {
    const decision = await decidePush(
      deps.port,
      deps.tickets,
      push,
      now,
      deps.overlap,
      deps.planCheck
        ? { check: deps.planCheck, enforce: deps.planCheckEnforce }
        : undefined,
    );

    if (decision.verdict === "merge") {
      const forkHandle = await deps.port.get(decision.ticket.forkRepo);
      const baseHandle = await deps.port.get(decision.ticket.baseRepo);
      let mergedSha: string;
      try {
        const baseInfo = await baseHandle.info();
        mergedSha = await deps.merger.merge({
          baseName: decision.ticket.baseRepo,
          baseRemote: baseHandle.remote,
          baseToken: await baseHandle.createToken("write", 600),
          baseBranch: baseInfo.defaultBranch,
          forkRemote: forkHandle.remote,
          forkToken: await forkHandle.createToken("read", 600),
          forkHeadSha: push.after,
          files: decision.files,
          deletedFiles: decision.deletedFiles,
          message: `Merge ${push.repo}@${push.after.slice(0, 8)}`,
          author: "foundry",
          expectedBaseSha: decision.baseHead ?? undefined,
        });
      } catch (e) {
        if (e instanceof StaleBaseError && attempt === 0) continue;
        if (e instanceof StaleBaseError) {
          const record = await deps.store.record({
            namespace: push.namespace,
            repo: push.repo,
            ref: push.ref,
            before_sha: push.before,
            after_sha: push.after,
            verdict: "conflict",
            conflict_files: [],
            files: Object.keys(decision.files),
            task_id: decision.ticket.taskId,
            agent_id: decision.ticket.agentId,
          });
          return { handled: true, record };
        }
        throw e;
      } finally {
        forkHandle.dispose();
        baseHandle.dispose();
      }
      const record = await deps.store.record({
        namespace: push.namespace,
        repo: push.repo,
        ref: push.ref,
        before_sha: push.before,
        after_sha: push.after,
        verdict: "merge",
        merged_sha: mergedSha,
        files: [...Object.keys(decision.files), ...decision.deletedFiles],
        task_id: decision.ticket.taskId,
        agent_id: decision.ticket.agentId,
      });
      return { handled: true, record };
    }

    if (decision.verdict === "conflict") {
      const record = await deps.store.record({
        namespace: push.namespace,
        repo: push.repo,
        ref: push.ref,
        before_sha: push.before,
        after_sha: push.after,
        verdict: "conflict",
        conflict_files: decision.files,
        files: decision.files,
        task_id: decision.ticket.taskId,
        agent_id: decision.ticket.agentId,
      });
      return { handled: true, record };
    }

    const record = await deps.store.record({
      namespace: push.namespace,
      repo: push.repo,
      ref: push.ref,
      before_sha: push.before,
      after_sha: push.after,
      verdict: "reject",
      reason: decision.reason,
    });
    return { handled: true, record };
    }
  } catch (e) {
    const stack =
      deps.debug && e instanceof Error && e.stack
        ? ` :: ${e.stack.split("\n").slice(0, 6).join(" | ")}`
        : "";
    // An infrastructure failure is not a verdict. Recording it as `error`
    // keeps it visible, retryable and out of the refusal counts — a repo
    // outage must never read as an agent's mistake (7 staging rows were).
    const record = await deps.store.record({
      namespace: push.namespace,
      repo: push.repo,
      ref: push.ref,
      before_sha: push.before,
      after_sha: push.after,
      verdict: "error",
      reason: {
        reason: "infra_failure",
        message: `${e instanceof Error ? e.message : String(e)}${stack}`,
      },
    });
    return { handled: true, record };
  }
}

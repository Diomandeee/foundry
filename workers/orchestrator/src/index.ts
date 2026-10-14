import { Hono } from "hono";
import { cloudflarePort } from "@foundry/artifacts-port";
import { intakeTriples, KGClient } from "@foundry/lkg-client";
import { PactServerPlanCheck, StubPlanCheck } from "@foundry/plan-check";
import { D1TicketStore } from "@foundry/stores";
import { createTask } from "./tasks.js";

// Env comes from worker-configuration.d.ts (run `wrangler types`).

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, worker: "orchestrator" }));

// Task intake mints repo write tokens, so it is authenticated. Fail
// closed when TASK_TOKEN is unset (same posture as the coordinator).
app.post("/tasks", async (c) => {
  if (!c.env.TASK_TOKEN) {
    return c.json(
      { error: "task intake disabled: TASK_TOKEN secret not set" },
      503,
    );
  }
  if (c.req.header("Authorization") !== `Bearer ${c.env.TASK_TOKEN}`) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const body = await c.req.json().catch(() => null);
  try {
    const planCheck = c.env.PACT_URL
      ? new PactServerPlanCheck(c.env.PACT_URL)
      : new StubPlanCheck();
    const result = await createTask(
      cloudflarePort(c.env),
      new D1TicketStore(c.env.DB),
      body,
      Date.now(),
      planCheck,
    );
    // Best-effort KG registration; the task stands without it.
    try {
      if (c.env.LKG_URL) {
        const kg = new KGClient(c.env.LKG_URL, c.env.LKG_TOKEN);
        for (const d of result.dispatches) {
          for (const t of intakeTriples(result.taskId, result.baseRepo, d.forkRepo)) {
            await kg.addTriple(t);
          }
        }
      }
    } catch (e) {
      console.warn("lkg notify failed", e);
    }
    return c.json(result, 201);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = message.startsWith("invalid") ? 400 : 500;
    return c.json({ error: message }, status);
  }
});

export default app;

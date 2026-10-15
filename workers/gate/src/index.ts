// Gate worker: consumes Artifacts repo events, runs decide→merge→record.
// Production deps: CloudflareAdapter + D1 stores + IsomorphicMerger/memfs.
import { memfs } from "memfs";
import { cloudflarePort } from "@foundry/artifacts-port";
import {
  isVerdictRecord,
  KGClient,
  KgOverlapOracle,
  touchTriples,
  verdictTriples,
} from "@foundry/lkg-client";
import { PactServerPlanCheck } from "@foundry/plan-check";
import { IsomorphicMerger } from "./merge.js";
import { handlePush, type PipelineDeps } from "./pipeline.js";
import { D1DecisionStore, D1TicketStore } from "@foundry/stores";

// Env comes from ./env.d.ts (bindings mirror wrangler.toml; committed so
// a clean clone typechecks without `wrangler types`).

function depsFromEnv(env: Env): PipelineDeps {
  const { fs } = memfs();
  const deps: PipelineDeps = {
    port: cloudflarePort(env),
    tickets: new D1TicketStore(env.DB),
    store: new D1DecisionStore(env.DB),
    merger: new IsomorphicMerger(fs),
  };
  if (env.LKG_URL) {
    deps.overlap = new KgOverlapOracle(new KGClient(env.LKG_URL, env.LKG_TOKEN));
  }
  // PACT chain check, previously constructible only in tests. Advisory
  // unless a deployment opts into enforcement out-of-band.
  if (env.PACT_URL) {
    deps.planCheck = new PactServerPlanCheck(env.PACT_URL);
  }
  if (env.DEBUG === "1") deps.debug = true;
  return deps;
}

export default {
  async fetch(): Promise<Response> {
    return new Response("foundry/gate: queue consumer", { status: 200 });
  },

  async queue(batch: any, env: Env): Promise<void> {
    const deps = depsFromEnv(env);
    for (const msg of batch.messages) {
      try {
        const res = await handlePush(deps, env.ARTIFACTS_NS, msg.body);
        console.log(
          "foundry/gate",
          msg.body?.type,
          msg.body?.source?.repoName,
          res.handled ? "handled" : "ignored",
        );
        // An unfinished attempt is retried, not acked: the push gets another
        // chance, and the `error` row stays as its discoverable explanation.
        // Only a real verdict is worth telling the graph about.
        if (res.handled && res.record.verdict === "error") {
          msg.retry();
          continue;
        }
        // Best-effort verdict triples; the D1 record stands without them.
        const record = res.handled ? res.record : null;
        if (record && isVerdictRecord(record) && env.LKG_URL) {
          try {
            const kg = new KGClient(env.LKG_URL, env.LKG_TOKEN);
            for (const t of verdictTriples(record)) {
              await kg.addTriple(t);
            }
            for (const t of touchTriples(record.after_sha, record.files ?? [])) {
              await kg.addTriple(t);
            }
          } catch (e) {
            console.warn("lkg verdict notify failed", e);
          }
        }
        msg.ack();
      } catch (e) {
        console.error("foundry/gate message failed", e);
        msg.retry();
      }
    }
  },
};

// T2 acceptance: outbound claim/renew/complete cycle + Pi census translation,
// including the real :9107 payload shape observed on minenode 2026-10-15.
import { describe, expect, it } from "vitest";
import {testAuthority, RESULT, POLICY} from "./test-artifacts.js";
import { OutboundAgent, collectPiCensus } from "./agent.js";

describe("outbound agent lifecycle", () => {
  it("claims, renews, completes against the authority", () => {
    const auth = testAuthority();
    auth.registerWorker("vps", 1, 'general');
    auth.submitWorkload("job", 1, "retry-new-attempt", 3, POLICY);
    const agent = new OutboundAgent(auth, "vps", 0);
    expect(agent.claim("job", "c1")).not.toBeNull();
    expect(agent.renew()).toBe(true);
    expect(agent.complete(RESULT)).toEqual({ accepted: true, reason: "committed" });
    expect(agent.renew()).toBe(false);
  });

  it("second claim while holding a lease is refused (one active attempt)", () => {
    const auth = testAuthority();
    auth.registerWorker("vps", 2, 'general');
    auth.submitWorkload("job", 1, "retry-new-attempt", 3, POLICY);
    auth.submitWorkload("job2", 1, "retry-new-attempt", 3, POLICY);
    const agent = new OutboundAgent(auth, "vps", 0);
    expect(agent.claim("job", "c1")).not.toBeNull();
    expect(agent.claim("job2", "c2")).toBeNull();
  });

  it("renew fails after fence; agent drops the lease", () => {
    const auth = testAuthority();
    auth.registerWorker("vps", 1, 'general');
    auth.submitWorkload("job", 1, "retry-new-attempt", 3, POLICY);
    const agent = new OutboundAgent(auth, "vps", 0);
    agent.claim("job", "c1");
    auth.fenceWorker("vps");
    expect(agent.renew()).toBe(false);
    expect(agent.complete(RESULT)).toEqual({ accepted: false, reason: "no-lease" });
  });

  it("completion without a verified receipt is rejected", () => {
    const auth = testAuthority();
    auth.registerWorker("vps", 1, 'general');
    auth.submitWorkload("job", 1, "retry-new-attempt", 3, POLICY);
    const agent = new OutboundAgent(auth, "vps", 0);
    agent.claim("job", "c1");
    expect(agent.complete(RESULT, { kind: "cpu-job" })).toEqual({
      accepted: false, reason: "policy-override",
    });
  });
});

describe("pi collector", () => {
  it("translates the live :9107 shape", () => {
    const reading = collectPiCensus({
      worker_id: "foundry-node-01",
      heartbeat_sequence: 6,
      observed_at: 1792105728,
      cpu_load_1m: 0.135,
      ram_available_mib: 3419,
      active_lease_ids: [],
      blockers: [],
      host: { hostname: "foundry-node-01", loadavg: [0.13, 0.1, 0.05] },
    });
    expect(reading.workerId).toBe("foundry-node-01");
    expect(reading.blockers).toEqual([]);
    expect(reading.cpuLoad1m).toBeCloseTo(0.13);
  });

  it("rejects garbage payloads", () => {
    expect(() => collectPiCensus(null)).toThrow();
    expect(() => collectPiCensus({})).toThrow("identity");
  });
});

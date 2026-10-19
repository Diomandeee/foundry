import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { execBounded } from "./executor.js";
import { verifyResult } from "./verifier.js";

// This is a fixed reference job, not a user-program registry.
const source = '"use strict";let sum=0;for(let i=0;i<1000;i++)sum+=i;process.stdout.write(String(sum)+"\\n");';
const digest = createHash("sha256").update(source).digest("hex");
const request = () => ({ leaseId: "issued", templateId: "reference-cpu", templateVersion: 1,
  scriptSha256: digest, timeoutMs: 5000, maxBytes: 1024 });
const host = () => ({ executablePath: realpathSync(process.execPath), managedCwd: process.cwd(),
  authorize: vi.fn(async () => true) });
// Exercise the runtime boundary too: malformed callers do not gain authority through types.
const run = (req: object, config?: object) => (execBounded as Function)(req, config);

describe("host-only bounded reference executor", () => {
  it("denies old arbitrary argv/cwd even with an approving owner callback", async () => {
    const result = await run({ ...request(), argv: ["git", "--version"], cwd: process.cwd() }, host());
    expect(result.outcome).toBe("start-failed");
  });
  it("requires trusted authorization, not just a lease ID", async () => {
    expect((await run(request())).outcome).toBe("start-failed");
    expect((await run(request(), { ...host(), authorize: async () => false })).outcome).toBe("start-failed");
    expect((await run(request(), { ...host(), authorize: async () => { throw Error("secret"); } })).stderrTail).not.toContain("secret");
  });
  it("runs only the pinned immutable reference and preserves verifier fields", async () => {
    const config = host();
    const result = await run(request(), config);
    expect(result.outcome).toBe("exited");
    expect(result.exitCode).toBe(0);
    expect(result.resolvedBin).toBe(realpathSync(process.execPath));
    expect(result.stdoutBytes).toBe(7);
    expect(result.stdoutSha256).toBe(createHash("sha256").update("499500\n").digest("hex"));
    const trustedBytes = Buffer.from("499500\n");
    const expectation = { kind: "reference", exitCode: 0,
      stdoutSha256: createHash("sha256").update(trustedBytes).digest("hex"), minBytes: 7 };
    expect(verifyResult(result, expectation, trustedBytes).verified).toBe(true);
    expect(verifyResult(result, expectation).verified).toBe(false);
    expect(config.authorize).toHaveBeenCalledWith(expect.objectContaining({ leaseId: "issued", templateId: "reference-cpu", scriptSha256: digest }));
  });
  it("denies wrong pins, argument overrides, and invalid resource bounds", async () => {
    for (const change of [{ templateId: "other" }, { templateVersion: 2 }, { scriptSha256: "0".repeat(64) },
      { argv: [] }, { cwd: "/tmp" }, { args: ["2000"] }, { env: {} },
      ...[0, -1, NaN, Infinity, 60001, 1.5].map(timeoutMs => ({ timeoutMs })),
      ...[null, 0, -1, NaN, Infinity, 1048577, 1.5].map(maxBytes => ({ maxBytes }))]) {
      expect((await run({ ...request(), ...change }, host())).outcome).toBe("start-failed");
    }
  });
  it("does not inherit Node injection environment", async () => {
    const previous = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = "--definitely-invalid-option";
    try { expect((await run(request(), host())).outcome).toBe("exited"); }
    finally { if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous; }
  });
  it("rejects noncanonical executable/cwd and pre-cancelled requests", async () => {
    expect((await run(request(), { ...host(), executablePath: "node" })).outcome).toBe("start-failed");
    expect((await run(request(), { ...host(), managedCwd: "." })).outcome).toBe("start-failed");
    const controller = new AbortController(); controller.abort();
    expect((await run({ ...request(), signal: controller.signal }, host())).outcome).toBe("signalled");
  });
  it("bounds output and timeout without reporting successful exit", async () => {
    expect((await run({ ...request(), maxBytes: 1 }, host())).outcome).toBe("start-failed");
    expect((await run({ ...request(), timeoutMs: 1 }, host())).outcome).toBe("timed-out");
  });
  it("cancels a running child without a successful outcome", async () => {
    const controller = new AbortController();
    const result = await run({ ...request(), signal: controller.signal }, {
      ...host(), authorize: async () => { setTimeout(() => controller.abort(), 0); return true; },
    });
    expect(result.outcome).toBe("signalled");
    expect(result.exitCode).toBeNull();
  });
  it("snapshots request before awaiting authorization", async () => {
    const req = request();
    const result = await run(req, { ...host(), authorize: async () => { req.templateId = "mutated"; return true; } });
    expect(result.outcome).toBe("exited");
  });
  it("stages actual stdout bytes with a captured owner callback", async () => {
    const staged: Uint8Array[] = [];
    const config = { ...host(), stageStdout: (bytes: Uint8Array) => {
      staged.push(bytes); bytes.fill(0); return "artifact.reference-1";
    } };
    const original = config.stageStdout;
    config.stageStdout = (bytes) => {
      expect(Buffer.from(bytes).equals(Buffer.from("499500\n"))).toBe(true);
      return original(bytes);
    };
    const trustedHost = { ...config, authorize: async () => {
      trustedHost.stageStdout = () => { throw Error("must not use mutated callback"); }; return true;
    } };
    const result = await run(request(), trustedHost);
    expect(result.outcome).toBe("exited");
    expect(result.artifactRef).toBe("artifact.reference-1");
    expect(staged).toHaveLength(1);
    expect(result.stdoutSha256).toBe(createHash("sha256").update("499500\n").digest("hex"));
  });
  it("fails safely for staging exceptions and invalid artifact identifiers", async () => {
    for (const stageStdout of [() => { throw Error("private host details"); },
      ...["", "../private/path", "bad ref", "artifact:colon", "x".repeat(65), "x".repeat(257), 42].map(ref => () => ref)]) {
      const result = await run(request(), { ...host(), stageStdout });
      expect(result.outcome).toBe("start-failed");
      expect(result.exitCode).toBeNull();
      expect(result.artifactRef).toBeUndefined();
      expect(result.stderrTail).not.toContain("private");
    }
  });
  it("does not stage denied, cancelled, timed out, or output-limited executions", async () => {
    const stageStdout = vi.fn(() => "artifact-never");
    await run(request(), { ...host(), authorize: async () => false, stageStdout });
    await run({ ...request(), timeoutMs: 1 }, { ...host(), stageStdout });
    await run({ ...request(), maxBytes: 1 }, { ...host(), stageStdout });
    const controller = new AbortController(); controller.abort();
    await run({ ...request(), signal: controller.signal }, { ...host(), stageStdout });
    expect(stageStdout).not.toHaveBeenCalled();
  });

  it("keeps failure status when the staging owner disposes output and throws", async () => {
    const result = await run(request(), { ...host(), stageStdout: (bytes: Uint8Array) => {
      expect(Buffer.from(bytes).toString()).toBe("499500\n");
      bytes.fill(0); // Dispose only the owner's copied staging buffer.
      throw Error("disposed private output");
    } });
    expect(result.outcome).toBe("start-failed");
    expect(result.exitCode).toBeNull();
    expect(result.artifactRef).toBeUndefined();
    expect(result.stdoutSha256).toBe(createHash("sha256").update("499500\n").digest("hex"));
    expect(result.stderrTail).toBe("stdout staging failed");
  });
  it("accepts authority-compatible artifact identifier boundaries", async () => {
    for (const ref of [".", "a_b-c.d", "x".repeat(64)]) {
      const result = await run(request(), { ...host(), stageStdout: () => ref });
      expect(result.outcome).toBe("exited");
      expect(result.artifactRef).toBe(ref);
    }
  });

});

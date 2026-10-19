// The Workers adapter must agree with the local one about a ref that does not
// exist yet: an empty history, not an exception. Seven staging decisions read
// "pipeline error: ... Could not find main." because the opposite was true and
// the gate's catch-all turned it into a refusal.
import { describe, expect, it } from "vitest";
import { cloudflarePort } from "./cloudflare.js";

function repoWith(over: Record<string, unknown> = {}) {
  return {
    info: async () => ({
      remote: "https://example.invalid/task-1.git",
      defaultBranch: "main",
      lastPushAt: null,
    }),
    readFile: async () => null,
    log: async () => [],
    readTree: async () => [],
    readCommit: async () => null,
    ...over,
  };
}

function port(over: Record<string, unknown> = {}) {
  return cloudflarePort({
    ARTIFACTS: { get: async () => repoWith(over) },
  } as unknown as { ARTIFACTS: unknown });
}

describe("cloudflarePort missing refs", () => {
  it("reads a branch that does not exist as an empty history", async () => {
    const handle = await port({
      log: async () => {
        throw new Error("Could not find main.");
      },
    }).get("task-1");
    expect(await handle.history("main", 50)).toEqual([]);
    handle.dispose();
  });

  it("reads a file on a ref that does not exist as absent", async () => {
    const handle = await port({
      readFile: async () => {
        throw new Error("Could not find main.");
      },
    }).get("task-1");
    expect(await handle.readFile("main", "app.ts")).toBeNull();
    handle.dispose();
  });

  it("still surfaces an outage as a failure, not as an empty repo", async () => {
    const handle = await port({
      log: async () => {
        throw new Error("network unreachable: connect ETIMEDOUT");
      },
    }).get("task-1");
    await expect(handle.history("main", 50)).rejects.toThrow(/timedout/i);
    handle.dispose();
  });

  it("does not swallow a read failure in a file lookup", async () => {
    const handle = await port({
      readFile: async () => {
        throw new Error("internal error: binding unavailable");
      },
    }).get("task-1");
    await expect(handle.readFile("main", "app.ts")).rejects.toThrow(
      /binding unavailable/i,
    );
    handle.dispose();
  });
});

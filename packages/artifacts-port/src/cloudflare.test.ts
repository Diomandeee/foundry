// Only explicit binding results prove absence. Error messages cannot establish
// whether a ref is missing or the repository itself is unavailable.
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
    const handle = await port({ log: async () => [] }).get("task-1");
    expect(await handle.history("main", 50)).toEqual([]);
    handle.dispose();
  });

  it("reads a file on a ref that does not exist as absent", async () => {
    const handle = await port({ readFile: async () => null }).get("task-1");
    expect(await handle.readFile("main", "app.ts")).toBeNull();
    handle.dispose();
  });

  it.each([
    new Error("Could not find main."),
    new Error("repository not found"),
    "Could not find main.",
    { status: 404, message: "Could not find main.", toString() { throw new Error("must not stringify"); } },
  ])("preserves missing-looking exceptions without inferring absence (%#)", async error => {
    const handle = await port({
      log: async () => { throw error; },
      readFile: async () => { throw error; },
    }).get("task-1");
    await expect(handle.history("main")).rejects.toBe(error);
    await expect(handle.readFile("main", "app.ts")).rejects.toBe(error);
  });

  it.each([undefined, null, {}])("rejects malformed history results (%#)", async result => {
    const handle = await port({ log: async () => result }).get("task-1");
    await expect(handle.history("main")).rejects.toThrow("history unavailable");
  });

  it("rejects an unavailable file and invalid UTF-8 instead of returning absence", async () => {
    const unavailable = await port({ readFile: async () => undefined }).get("task-1");
    await expect(unavailable.readFile("main", "app.ts")).rejects.toThrow("file unavailable");
    const invalid = await port({ readFile: async () => new Blob([new Uint8Array([0xff])]) }).get("task-1");
    await expect(invalid.readFile("main", "app.ts")).rejects.toThrow();
  });

  it("preserves exact text bytes including BOM and surrounding whitespace", async () => {
    const content = "\ufeff \nsource\n ";
    const handle = await port({ readFile: async () => new Blob([content]) }).get("task-1");
    expect(await handle.readFile("main", "app.ts")).toBe(content);
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

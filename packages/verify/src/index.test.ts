import { afterEach, describe, expect, it, vi } from "vitest";
import {
  blocksMerge,
  HttpVerifier,
  MAX_OUTPUT_CHARS,
  StubVerifier,
  summarize,
  truncateOutput,
  verifyTimeoutMs,
  type VerifyRequest,
} from "./index.js";

const req: VerifyRequest = {
  repo: "t1--a",
  baseBranch: "main",
  files: ["app.ts"],
  headSha: "a".repeat(40),
};

function stubFetch(impl: (url: string, init: RequestInit) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => impl(url, init)),
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("blocksMerge", () => {
  it("never blocks on an unchecked verdict, even when enforcing", () => {
    // An outage, or no runner configured, is not a failed test.
    expect(blocksMerge({ checked: false, ok: true, runs: [] }, true)).toBe(false);
    expect(
      blocksMerge({ checked: false, ok: true, runs: [], error: "down" }, true),
    ).toBe(false);
  });

  it("blocks a failed check only when the caller enforces", () => {
    const failed = { checked: true, ok: false, runs: [] };
    expect(blocksMerge(failed, true)).toBe(true);
    // Advisory by default: a failure is reported, not fatal.
    expect(blocksMerge(failed, false)).toBe(false);
  });

  it("never blocks a passing verdict", () => {
    expect(blocksMerge({ checked: true, ok: true, runs: [] }, true)).toBe(false);
  });
});

describe("StubVerifier", () => {
  it("reports that nothing was checked, and does not block", async () => {
    const v = await new StubVerifier().run(req);
    expect(v).toEqual({ checked: false, ok: true, runs: [] });
    expect(blocksMerge(v, true)).toBe(false);
  });
});

describe("HttpVerifier", () => {
  it("passes when every check passes, and sends the tested revision", async () => {
    const seen: { url: string; body: unknown }[] = [];
    stubFetch((url, init) => {
      seen.push({ url, body: JSON.parse(String(init.body)) });
      return json({ runs: [{ name: "tsc", ok: true }] });
    });
    const v = await new HttpVerifier("https://verify.invalid").run(req);
    expect(v).toEqual({ checked: true, ok: true, runs: [{ name: "tsc", ok: true }] });
    expect(seen[0].url).toBe("https://verify.invalid/api/verify");
    expect(seen[0].body).toEqual(req);
  });

  it("fails when a check fails", async () => {
    stubFetch(() =>
      json({
        runs: [
          { name: "tsc", ok: true },
          { name: "vitest", ok: false, output: "2 failed" },
        ],
      }),
    );
    const v = await new HttpVerifier("https://verify.invalid").run(req);
    expect(v.checked).toBe(true);
    expect(v.ok).toBe(false);
    if (v.checked) expect(v.runs[1].output).toBe("2 failed");
  });

  it("treats a non-2xx response as an outage, not a failure", async () => {
    stubFetch(() => json({ error: "boom" }, 502));
    const v = await new HttpVerifier("https://verify.invalid").run(req);
    expect(v.checked).toBe(false);
    expect(v.ok).toBe(true);
    expect(v.error).toBe("verify 502");
    expect(blocksMerge(v, true)).toBe(false);
  });

  it("treats a transport failure as an outage", async () => {
    stubFetch(() => {
      throw new Error("connect ECONNREFUSED");
    });
    const v = await new HttpVerifier("https://verify.invalid").run(req);
    expect(v.checked).toBe(false);
    expect(v.ok).toBe(true);
  });

  it("does not read 'no checks ran' as 'everything passed'", async () => {
    stubFetch(() => json({ runs: [] }));
    const v = await new HttpVerifier("https://verify.invalid").run(req);
    expect(v.checked).toBe(false);
    expect(v.error).toBe("no checks ran");
    expect(summarize(v)).toContain("not checked");
  });

  it("bounds check output so one run cannot fill the ledger", async () => {
    stubFetch(() =>
      json({ runs: [{ name: "vitest", ok: false, output: "x".repeat(5000) }] }),
    );
    const v = await new HttpVerifier("https://verify.invalid").run(req);
    if (v.checked) {
      expect(v.runs[0].output?.length).toBe(MAX_OUTPUT_CHARS + 1);
    }
  });
});

describe("summarize", () => {
  it("names the checks that failed, without echoing output", () => {
    expect(
      summarize({
        checked: true,
        ok: false,
        runs: [
          { name: "tsc", ok: false, output: "secret-ish" },
          { name: "lint", ok: true },
        ],
      }),
    ).toBe("failed tsc");
  });

  it("says how many passed", () => {
    expect(
      summarize({ checked: true, ok: true, runs: [{ name: "tsc", ok: true }] }),
    ).toBe("passed 1 check(s)");
  });
});

describe("truncateOutput", () => {
  it("leaves short output alone", () => {
    expect(truncateOutput("ok")).toBe("ok");
  });
});

describe("verifyTimeoutMs", () => {
  it("keeps the 120 s default when unset or unparseable", () => {
    expect(verifyTimeoutMs(undefined)).toBe(120_000);
    expect(verifyTimeoutMs("")).toBe(120_000);
    expect(verifyTimeoutMs("soon")).toBe(120_000);
    expect(verifyTimeoutMs("-5")).toBe(120_000);
  });
  it("takes a build-sized wait", () => {
    expect(verifyTimeoutMs("600000")).toBe(600_000);
  });
  it("caps at the queue consumer's wall-time budget", () => {
    expect(verifyTimeoutMs("3600000")).toBe(840_000);
  });
});

describe("HttpVerifier fetcher", () => {
  it("sends through the given fetcher instead of the global fetch", async () => {
    const calls: string[] = [];
    const global = vi.fn();
    vi.stubGlobal("fetch", global);
    const v = new HttpVerifier("http://verify.internal/tok", {
      fetcher: async (url) => {
        calls.push(url);
        return new Response(JSON.stringify({ runs: [{ name: "t", ok: true }] }), { status: 200 });
      },
    });
    const out = await v.run(req);
    expect(calls).toEqual(["http://verify.internal/tok/api/verify"]);
    expect(global).not.toHaveBeenCalled();
    expect(out).toMatchObject({ checked: true, ok: true });
    vi.unstubAllGlobals();
  });
});

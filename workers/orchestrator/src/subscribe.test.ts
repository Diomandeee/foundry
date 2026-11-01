import { describe, expect, it } from "vitest";
import { subscribeConfig, subscribeForks, subscriptionName } from "./subscribe.js";

const cfg = {
  accountId: "acct",
  apiToken: "tok",
  queueId: "q1",
  queueName: "foundry-push-events-staging",
  namespace: "foundry-staging",
};

function fakeFetch(replies: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = replies.shift()!;
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("subscribeConfig", () => {
  it("is off unless all five settings are present", () => {
    expect(subscribeConfig({})).toBeNull();
    expect(subscribeConfig({ SUBSCRIBE_API_TOKEN: "t", SUBSCRIBE_ACCOUNT_ID: "a" })).toBeNull();
    expect(
      subscribeConfig({
        SUBSCRIBE_API_TOKEN: "t",
        SUBSCRIBE_ACCOUNT_ID: "a",
        SUBSCRIBE_QUEUE_ID: "q",
        SUBSCRIBE_QUEUE_NAME: "n",
        SUBSCRIBE_NAMESPACE: "ns",
      }),
    ).toEqual({ apiToken: "t", accountId: "a", queueId: "q", queueName: "n", namespace: "ns" });
  });
});

describe("subscribeForks", () => {
  it("posts one per-repo pushed subscription per fork, named like subscribe-repo.sh", async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { success: true, result: { id: "s1" } } },
      { status: 200, body: { success: true, result: { id: "s2" } } },
    ]);
    const out = await subscribeForks(cfg, ["t--a", "t--b"], impl);
    expect(out).toEqual([
      { forkRepo: "t--a", ok: true, id: "s1" },
      { forkRepo: "t--b", ok: true, id: "s2" },
    ]);
    expect(calls[0].url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/event_subscriptions/subscriptions");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toEqual({
      name: "foundry-push-events-staging t--a pushed",
      destination: { type: "queues.queue", queue_id: "q1" },
      source: { type: "artifacts.repo", namespace: "foundry-staging", repo_name: "t--a" },
      events: ["pushed"],
      enabled: true,
    });
    expect(subscriptionName(cfg, "t--a")).toBe(body.name);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("reports each failure without stopping the rest", async () => {
    const { impl } = fakeFetch([
      { status: 403, body: { success: false, errors: [{ message: "not authorized" }] } },
      { status: 200, body: { success: true, result: { id: "s2" } } },
    ]);
    const out = await subscribeForks(cfg, ["t--a", "t--b"], impl);
    expect(out[0]).toEqual({ forkRepo: "t--a", ok: false, error: "not authorized" });
    expect(out[1].ok).toBe(true);
  });

  it("turns a network error into a result, not a throw", async () => {
    const impl = (async () => {
      throw new Error("connect reset");
    }) as unknown as typeof fetch;
    expect(await subscribeForks(cfg, ["t--a"], impl)).toEqual([
      { forkRepo: "t--a", ok: false, error: "connect reset" },
    ]);
  });
});

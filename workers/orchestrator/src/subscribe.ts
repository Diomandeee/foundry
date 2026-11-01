// Auto-subscribe: the event-subscription API is per repo (a namespace-wide
// subscription is rejected), so every fork POST /tasks mints needs its own
// "pushed" subscription before its first push can reach the gate. Doing it
// here closes the gap where an agent pushed before an operator ran
// tools/subscribe-repo.sh and the push was never decided.
//
// Optional: it runs only when the account token and queue are configured.
// Without them the task response still carries subscribeCommands, exactly
// as before.

export interface SubscribeConfig {
  accountId: string;
  apiToken: string;
  queueId: string;
  /** Queue name; part of the subscription name subscribe-repo.sh uses. */
  queueName: string;
  namespace: string;
}

export interface SubscribeResult {
  forkRepo: string;
  ok: boolean;
  id?: string;
  error?: string;
}

const API = "https://api.cloudflare.com/client/v4";

export function subscribeConfig(env: {
  SUBSCRIBE_API_TOKEN?: string;
  SUBSCRIBE_ACCOUNT_ID?: string;
  SUBSCRIBE_QUEUE_ID?: string;
  SUBSCRIBE_QUEUE_NAME?: string;
  SUBSCRIBE_NAMESPACE?: string;
}): SubscribeConfig | null {
  const c = {
    apiToken: env.SUBSCRIBE_API_TOKEN ?? "",
    accountId: env.SUBSCRIBE_ACCOUNT_ID ?? "",
    queueId: env.SUBSCRIBE_QUEUE_ID ?? "",
    queueName: env.SUBSCRIBE_QUEUE_NAME ?? "",
    namespace: env.SUBSCRIBE_NAMESPACE ?? "",
  };
  return Object.values(c).every((v) => v.length > 0) ? c : null;
}

/** Same name subscribe-repo.sh gives it, so either path finds the other's. */
export function subscriptionName(cfg: SubscribeConfig, forkRepo: string): string {
  return `${cfg.queueName} ${forkRepo} pushed`;
}

export async function subscribeForks(
  cfg: SubscribeConfig,
  forks: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<SubscribeResult[]> {
  const out: SubscribeResult[] = [];
  for (const forkRepo of forks) {
    try {
      const res = await fetchImpl(
        `${API}/accounts/${cfg.accountId}/event_subscriptions/subscriptions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${cfg.apiToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: subscriptionName(cfg, forkRepo),
            destination: { type: "queues.queue", queue_id: cfg.queueId },
            source: { type: "artifacts.repo", namespace: cfg.namespace, repo_name: forkRepo },
            events: ["pushed"],
            enabled: true,
          }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        result?: { id?: string };
        errors?: { message?: string }[];
      };
      if (res.ok && body.success) {
        out.push({ forkRepo, ok: true, id: body.result?.id });
      } else {
        const msg = body.errors?.map((e) => e.message).filter(Boolean).join("; ");
        out.push({ forkRepo, ok: false, error: msg || `HTTP ${res.status}` });
      }
    } catch (e) {
      out.push({ forkRepo, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

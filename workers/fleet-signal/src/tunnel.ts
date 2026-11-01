// Bridge tunnel: lets the Fabric app reach a Mac's fabric-bridge when the phone is off the tailnet.
//
// The bridge (bridge/fabric_bridge.py in the Fabric repo) long-polls this hub for jobs and posts each
// result back; the phone's call waits here until its result arrives. Nothing here can act for anyone:
//  - every job carries the phone's own signature over the bridge path (x-fb-* headers), which the
//    bridge verifies exactly as it does on the tailnet, Face ID decision key included for an allow;
//  - every result carries the bridge's signature (x-fb-rsig), which the phone checks against the
//    bridge key it learned over the tailnet, so this relay cannot alter what the phone is shown.
// Queues and waiters live in the Durable Object's memory: a restart drops in-flight calls, which the
// phone retries, and nothing durable is lost.

export interface Job {
  id: string;
  method: string;
  path: string;                       // the bridge path with query, e.g. /v1/sessions
  headers: Record<string, string>;    // x-fs-key / x-fs-ts / x-fs-sig, as the bridge expects them
  body: string;
}

export interface JobResult { status: number; body: string; rsig: string }

const ONLINE_MS = 60_000;

export class Tunnel {
  private queues = new Map<string, Job[]>();
  private waiters = new Map<string, (jobs: Job[]) => void>();
  private pending = new Map<string, { machine: string; resolve: (r: JobResult) => void }>();
  private seen = new Map<string, number>();

  constructor(private nowMs: () => number = () => Date.now(), private newId: () => string = () => crypto.randomUUID()) {}

  /** A bridge has polled within the last minute (or is polling now). */
  online(machine: string): boolean {
    const seen = this.seen.get(machine);
    return this.waiters.has(machine) || (seen !== undefined && this.nowMs() - seen < ONLINE_MS);
  }

  lastSeen(machine: string): number | null { return this.seen.get(machine) ?? null; }

  /** The bridge's long poll: queued jobs now, or the next job within waitMs, or nothing. */
  poll(machine: string, waitMs: number): Promise<Job[]> {
    this.seen.set(machine, this.nowMs());
    const queued = this.queues.get(machine);
    if (queued?.length) {
      this.queues.delete(machine);
      return Promise.resolve(queued);
    }
    this.waiters.get(machine)?.([]);  // a newer poll replaces an older one (bridge restarted)
    return new Promise(resolve => {
      const done = (jobs: Job[]) => { clearTimeout(timer); resolve(jobs); };
      const timer = setTimeout(() => {
        if (this.waiters.get(machine) === done) this.waiters.delete(machine);
        this.seen.set(machine, this.nowMs());
        resolve([]);
      }, waitMs);
      this.waiters.set(machine, done);
    });
  }

  /** A phone call through the tunnel: resolves with the bridge's result, or 504 after timeoutMs. */
  request(machine: string, job: Omit<Job, 'id'>, timeoutMs: number): Promise<JobResult> {
    const full: Job = { ...job, id: this.newId() };
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(full.id);
        const q = this.queues.get(machine);
        if (q) this.queues.set(machine, q.filter(j => j.id !== full.id));
        resolve({ status: 504, body: JSON.stringify({ error: 'bridge-timeout' }), rsig: '' });
      }, timeoutMs);
      this.pending.set(full.id, { machine, resolve: r => { clearTimeout(timer); resolve(r); } });
      const waiter = this.waiters.get(machine);
      if (waiter) {
        this.waiters.delete(machine);
        waiter([full]);
      } else {
        this.queues.set(machine, [...(this.queues.get(machine) ?? []), full]);
      }
    });
  }

  /** The bridge's result for one job. Only the machine the job went to can answer it. */
  reply(machine: string, id: string, result: JobResult): boolean {
    const p = this.pending.get(id);
    if (!p || p.machine !== machine) return false;
    this.pending.delete(id);
    p.resolve(result);
    return true;
  }
}

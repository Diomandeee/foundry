import { performance } from 'node:perf_hooks';
import { approvalFor, check } from './plans.js';
import { HostJournal } from './host.js';
import type { Exit, LeasePort, Running, RuntimeAdapter, RuntimePlan, StopProof, SupervisorResult, ExecutionScope } from './types.js';

const unknown = (identity:string): StopProof => ({stopped:false,basis:'unknown',identity});
async function deadline<T>(work: Promise<T>, ms:number, expired:() => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work,new Promise<never>((_,reject) => {
    timer = setTimeout(() => { expired(); reject(new Error('deadline')); },ms);
  })]); } finally { if (timer) clearTimeout(timer); }
}
/** No authority/authentication implementation here. DI renewals are fenced by parent.
 * A successful request grants at most 60s from REQUEST START, never response arrival. */
export class LongJobSupervisor {
  constructor(private readonly journal:HostJournal, private readonly lease:LeasePort, private readonly adapter:RuntimeAdapter) {}
  async run(plan:RuntimePlan, cancel?:AbortSignal, hooks?: {
    /** Monotonic deadline anchored before claim, includes transfer/report time. */
    deadlineAt?:number;
    prepare?:(scope:ExecutionScope)=>Promise<void>;
    afterStop?:(result:SupervisorResult,scope:{signal:AbortSignal;assertLease:()=>void})=>Promise<void>;
  }): Promise<SupervisorResult> {
    approvalFor(plan);
    check(!cancel?.aborted,'cancelled-before-reservation');
    const reservation = await this.journal.reserve(plan); // fsynced BEFORE any run-capable port
    let running: Running | undefined, exit: Exit | undefined;
    let expiry = 0, reason: 'cancelled'|'lease-lost'|'timeout'|undefined;
    let renewing = false, done = false;
    const pendingRenewals = new Set<AbortController>();
    const operation = new AbortController();
    const halt = (why:typeof reason) => { if (!done && !reason) { reason = why; operation.abort(); } };
    const onCancel = () => halt('cancelled');
    cancel?.addEventListener('abort',onCancel,{once:true});
    const renewal = async () => {
      if (done || reason || renewing) return;
      renewing = true;
      const abort = new AbortController(); pendingRenewals.add(abort);
      const sent = performance.now();
      try {
        const grant = await deadline(this.lease.renew(plan,60000,abort.signal),10000,() => abort.abort());
        if (done || reason) return;
        if (!grant.valid || grant.cancel) { halt(grant.cancel ? 'cancelled' : 'lease-lost'); return; }
        expiry = sent + 60000;
      } catch { halt('lease-lost'); }
      finally { renewing = false; pendingRenewals.delete(abort); }
    };
    let interval: ReturnType<typeof setInterval> | undefined;
    let watchdog: ReturnType<typeof setInterval> | undefined;
    const deadlineAt = Math.min(performance.now()+plan.timeoutMs,hooks?.deadlineAt ?? Infinity);
    let stopSignalResolve!: () => void;
    const stopSignal = new Promise<void>(resolve => { stopSignalResolve = resolve; });
    const fence = () => {
      if (cancel?.aborted) halt('cancelled');
      if (performance.now() >= deadlineAt) halt('timeout');
      if (performance.now() >= expiry) halt('lease-lost');
      check(!done && !reason,'activation-fence-closed');
    };
    let proof = unknown(plan.attemptId);
    let outcome: SupervisorResult['outcome'] = 'quarantined';
    const scope:ExecutionScope=Object.freeze({signal:operation.signal,assertLease:fence,
      remainingMs:()=>{fence();return Math.max(0,Math.min(expiry,deadlineAt)-performance.now());},reservation});
    try {
      await renewal(); fence();
      interval = setInterval(() => { void renewal(); },15000);
      watchdog = setInterval(() => {
        if (cancel?.aborted) halt('cancelled');
        if (performance.now() >= deadlineAt) halt('timeout');
        if (performance.now() >= expiry) halt('lease-lost');
        if (reason) stopSignalResolve();
      },100);
      if (hooks?.prepare) await deadline(hooks.prepare(scope),Math.max(1,deadlineAt-performance.now()),() => halt('timeout'));
      fence();
      await deadline(this.adapter.prepare(plan),Math.max(1,deadlineAt-performance.now()),()=>halt('timeout')); fence();
      const starting=this.adapter.start(plan,id => reservation.recordIdentity(id),fence,scope);
      // A late adapter cannot reopen admission. Retain the reservation on timeout,
      // and request stop if a non-cooperative asynchronous start eventually returns.
      void starting.then(late=>{if(operation.signal.aborted)void late.stop().catch(()=>undefined);},()=>{});
      running = await deadline(starting,Math.max(1,deadlineAt-performance.now()),()=>halt('timeout'));
      // Stop immediately even when cancellation happened during async identity persistence.
      if (reason || cancel?.aborted) stopSignalResolve();
      const result = await Promise.race([running.completion.then(value => ({exit:value})),stopSignal.then(() => ({exit:undefined}))]);
      exit = result.exit;
      if (reason || !exit || exit.limited) {
        if (!reason && exit?.limited) halt('timeout');
        proof = await deadline(running.stop(),10000,() => {});
      } else {
        proof = await deadline(running.inspectStopped(),10000,() => {});
        if (!proof.stopped) proof = await deadline(running.stop(),10000,() => {});
      }
      if (proof.stopped) outcome = reason ?? (exit?.code === 0 && !exit.limited ? 'completed' : 'failed');
      if (reason === 'lease-lost') outcome = 'quarantined';
      if (hooks?.afterStop) await deadline(hooks.afterStop({outcome,stop:proof,...(exit && outcome === 'completed' ? {exit} : {})},{signal:operation.signal,assertLease:fence}),Math.max(10000,deadlineAt-performance.now()),() => halt('timeout'));
    } catch {
      if (running) {
        try { proof = await deadline(running.stop(),10000,() => {}); } catch { proof = unknown(running.identity); }
      }
      outcome = 'quarantined';
    } finally {
      done = true;
      operation.abort();
      if (interval) clearInterval(interval); if (watchdog) clearInterval(watchdog);
      for (const a of pendingRenewals) a.abort();
      cancel?.removeEventListener('abort',onCancel);
    }
    // Never release on ambiguous activation/control/renewal even with partial stop evidence.
    if (!proof.stopped || reason === 'lease-lost' || (reason && outcome === 'completed')) outcome = 'quarantined';
    try { await reservation.finish(proof,outcome); }
    catch { return {outcome:'quarantined',stop:unknown(running?.identity ?? plan.attemptId)}; }
    return {outcome,stop:proof,...(exit && outcome === 'completed' ? {exit} : {})};
  }
}

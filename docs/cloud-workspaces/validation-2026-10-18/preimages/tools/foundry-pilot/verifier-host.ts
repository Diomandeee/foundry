/** Standalone source CLI, using the existing installed tsx loader from source/:
 * ./node_modules/.bin/tsx tools/foundry-pilot/verifier-host.ts --config /absolute/private/verifier.json
 * Importing this module does not launch it. No provisioning or owner mutations are performed.
 */
import {join, resolve} from 'node:path';
import {lstat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {canonical, identity, sha256} from '../../packages/library-jobs/src/data';
import type {VerificationRequest} from '../../packages/compute-authority/src/durable/contracts';
import type {OperatorWorkload, OperatorLease, OperatorReceipt} from '../../workers/compute/src/operator-feed';
import {credential, digest, exact, id, need, PilotError, uint, withPrivateState} from './private-state';
import {AuthorityTransport} from './transport';
import {loadVerifierConfig, parseVerifierConfig, type VerifierConfig} from './verifier-config';

const codes = ['verifier-disabled','verifier-complete','verifier-interrupted','verifier-runtime-limit',
  'verifier-state-rejected','verifier-authority-blocked','verifier-credential-blocked','verifier-feed-blocked',
  'verifier-rejected','verifier-receipt-blocked','verifier-retry-exhausted','verifier-capacity'] as const;
type Code = typeof codes[number];
type Body = {expectedEpoch:number; request:VerificationRequest};
interface Entry {
  workloadId:string;
  body:Body;
  attempts:number;
  state:'pending'|'accepted'|'blocked';
  acceptance:{receiptDigest:string; verifiedAt:number}|null;
}
interface Journal {
  version:1;
  binding:{configDigest:string; ownerCredentialDigest:string; verifierCredentialDigest:string};
  blocked:Code|null;
  entries:Entry[];
}
export interface VerifierSummary {version:1; code:Code; steps:number; accepted:number; pending:number}
const empty = (code:Code):VerifierSummary => ({version:1, code, steps:0, accepted:0, pending:0});
const fail = (code:Code):never => {throw new PilotError(code);};
const member = (v:unknown):v is Code => typeof v === 'string' && codes.includes(v as Code);

function credentials(c:VerifierConfig):Journal['binding'] {
  const owner = credential(c.ownerCredentialReference), verifier = credential(c.verifierCredentialReference);
  need(owner !== verifier, 'verifier-credential-blocked');
  // Private fingerprints detect same-reference token rebinding. Neither token is journaled or printed.
  return {configDigest:identity('foundry-pilot-verifier-config-v1', c),
    ownerCredentialDigest:sha256(owner), verifierCredentialDigest:sha256(verifier)};
}
function bodyFor(c:VerifierConfig, workloadId:string, fence:Omit<VerificationRequest,'key'>):Body {
  const key = identity('foundry-pilot-verifier-request-v1', {
    origin:c.origin, environment:c.environment, authorityId:c.authorityId,
    verifierPrincipal:c.verifierPrincipal, workloadId, expectedEpoch:c.expectedEpoch, ...fence,
  });
  return {expectedEpoch:c.expectedEpoch, request:{key, ...fence}};
}

/** Reject, never repair a corrupt, differently bound, or already blocked journal. */
function journal(raw:unknown, c:VerifierConfig, binding:Journal['binding']):Journal {
  exact(raw, ['version','binding','blocked','entries']);
  need(raw.version === 1, 'verifier-state-rejected');
  exact(raw.binding, ['configDigest','ownerCredentialDigest','verifierCredentialDigest']);
  for (const value of Object.values(raw.binding)) digest(value);
  need(canonical(raw.binding) === canonical(binding), 'verifier-state-rejected');
  need(raw.blocked === null || member(raw.blocked), 'verifier-state-rejected');
  need(Array.isArray(raw.entries) && raw.entries.length <= 128, 'verifier-state-rejected');
  const keys = new Set<string>();
  let pending = 0;
  for (const e of raw.entries) {
    exact(e, ['workloadId','body','attempts','state','acceptance']);
    id(e.workloadId); need(c.allowedWorkloadIds.includes(e.workloadId), 'verifier-state-rejected');
    exact(e.body, ['expectedEpoch','request']);
    exact(e.body.request, ['key','leaseId','epoch','generation','incarnation']);
    const r = e.body.request;
    digest(r.key); id(r.leaseId); uint(r.epoch, 1); uint(r.generation); uint(r.incarnation);
    need(r.epoch === c.expectedEpoch && e.body.expectedEpoch === c.expectedEpoch &&
      canonical(e.body) === canonical(bodyFor(c, e.workloadId, {
        leaseId:r.leaseId, epoch:r.epoch, generation:r.generation, incarnation:r.incarnation,
      })) && !keys.has(r.key), 'verifier-state-rejected');
    keys.add(r.key); uint(e.attempts, 0, c.limits.maxRetries + 1);
    need(['pending','accepted','blocked'].includes(e.state), 'verifier-state-rejected');
    if (e.state === 'accepted') {
      exact(e.acceptance, ['receiptDigest','verifiedAt']);
      digest(e.acceptance.receiptDigest); uint(e.acceptance.verifiedAt);
      need(e.attempts > 0, 'verifier-state-rejected');
    } else {
      need(e.acceptance === null, 'verifier-state-rejected');
      if (e.state === 'pending') pending++;
      if (e.state === 'blocked') need(raw.blocked !== null, 'verifier-state-rejected');
    }
  }
  need(pending <= 1, 'verifier-state-rejected');
  return raw as unknown as Journal;
}

interface WorkloadObservation {
  version:1; ok:true; environment:string; authorityId:string; observedAt:number;
  workload:OperatorWorkload|null; lease:OperatorLease|null; receipt:OperatorReceipt|null;
}

/** One configured ID, with the same safe projections as OperatorView; no global windows. */
function observation(raw:unknown, c:VerifierConfig, workloadId:string):WorkloadObservation {
  exact(raw, ['version','ok','environment','authorityId','observedAt','workload','lease','receipt']);
  need(raw.version === 1 && raw.ok === true && raw.environment === c.environment &&
    raw.authorityId === c.authorityId && c.allowedWorkloadIds.includes(workloadId), 'verifier-feed-blocked');
  uint(raw.observedAt);
  const w = raw.workload, l = raw.lease, r = raw.receipt;
  if (w !== null) {
    exact(w, ['id','principal','status','generation','attemptsUsed','maxAttempts','winner','resources','maxBytes','exitCode','pure','reconstructible']);
    id(w.id); id(w.principal); uint(w.generation); uint(w.maxBytes, 1, 4194304);
    need(w.id === workloadId && ['QUEUED','RUNNING','VERIFYING','SUCCEEDED','FAILED','CANCELLED'].includes(w.status), 'verifier-feed-blocked');
    uint(w.attemptsUsed); uint(w.maxAttempts, 1);
    if (w.winner !== null) id(w.winner);
    exact(w.resources, ['cpu','ramMib','gpuKind','gpuVram']);
    uint(w.resources.cpu); uint(w.resources.ramMib);
    need([null,'cuda','metal'].includes(w.resources.gpuKind), 'verifier-feed-blocked');
    if (w.resources.gpuVram !== null) uint(w.resources.gpuVram);
    need(Number.isSafeInteger(w.exitCode) && typeof w.pure === 'boolean' &&
      typeof w.reconstructible === 'boolean', 'verifier-feed-blocked');
  }
  if (l !== null) {
    exact(l, ['id','workloadId','workerId','epoch','generation','incarnation','issuedAt','expiresAt','capAt','sequence','state','verificationDeadline']);
    id(l.id); id(l.workloadId); id(l.workerId);
    uint(l.epoch, 1); uint(l.generation); uint(l.incarnation); uint(l.sequence);
    uint(l.issuedAt); uint(l.expiresAt); uint(l.capAt);
    if (l.verificationDeadline !== null) uint(l.verificationDeadline);
    need(w !== null && l.workloadId === workloadId &&
      ['RUNNING','VERIFYING','SUCCEEDED','REVOKED'].includes(l.state), 'verifier-feed-blocked');
  }
  if (r !== null) {
    exact(r, ['workloadId','leaseId','bytes','epoch','generation','incarnation','verifier','verifiedAt']);
    id(r.workloadId); id(r.leaseId); id(r.verifier);
    uint(r.bytes, 0, 4194304); uint(r.epoch, 1); uint(r.generation); uint(r.incarnation); uint(r.verifiedAt);
    need(w !== null && l !== null && w.status === 'SUCCEEDED' && w.winner === r.leaseId &&
      r.workloadId === workloadId && r.leaseId === l.id && l.state === 'SUCCEEDED' &&
      r.epoch === l.epoch && r.generation === l.generation && r.generation === w.generation &&
      r.incarnation === l.incarnation, 'verifier-feed-blocked');
  }
  return raw as unknown as WorkloadObservation;
}

/** Actual durable SQL row, NOT OperatorReceipt's camelCase safe projection. */
function acceptance(raw:unknown, entry:Entry, c:VerifierConfig):NonNullable<Entry['acceptance']> {
  exact(raw, ['ok','receipt']); need(raw.ok === true, 'verifier-receipt-blocked');
  const r = raw.receipt, f = entry.body.request;
  exact(r, ['workload_id','lease_id','reference','sha256','bytes','policy_hash','epoch','generation','incarnation','verifier','verified_ms']);
  id(r.workload_id); id(r.lease_id); id(r.verifier);
  digest(r.reference); digest(r.sha256); digest(r.policy_hash);
  uint(r.bytes, 0, 4194304); uint(r.epoch, 1); uint(r.generation); uint(r.incarnation); uint(r.verified_ms);
  need(r.workload_id === entry.workloadId && c.allowedWorkloadIds.includes(r.workload_id) &&
    r.lease_id === f.leaseId && r.epoch === f.epoch && r.epoch === entry.body.expectedEpoch &&
    r.generation === f.generation && r.incarnation === f.incarnation &&
    r.verifier === c.verifierPrincipal, 'verifier-receipt-blocked');
  need(r.reference === sha256(JSON.stringify(['compute-artifact-v1',f.leaseId,r.sha256])), 'verifier-receipt-blocked');
  // Retain a commitment and timestamp privately; no raw seal/receipt is logged or returned.
  return {receiptDigest:identity('foundry-pilot-verifier-receipt-v1', r), verifiedAt:r.verified_ms};
}

function transient(error:unknown):boolean {
  return error instanceof PilotError && (
    ['pilot-upstream-unavailable','pilot-transport-timeout','pilot-transport-busy','pilot-upstream-429'].includes(error.code) ||
    (error.code === 'pilot-upstream-failed' && error.status >= 500));
}
function pause(ms:number, signal:AbortSignal):Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) {resolve(); return;}
    const done = () => {clearTimeout(timer); signal.removeEventListener('abort',done); resolve();};
    const timer = setTimeout(done, ms); signal.addEventListener('abort',done,{once:true});
  });
}

/** Bounded driver. Only owner status/operator reads and separate verifier verify requests. */
export async function runVerifier(input:VerifierConfig, outer?:AbortSignal):Promise<VerifierSummary> {
  const c = parseVerifierConfig(input);
  if (!c.enabled) return empty('verifier-disabled');
  const stop = new AbortController(), start = performance.now();
  const interrupt = () => stop.abort();
  outer?.addEventListener('abort',interrupt,{once:true});
  if (outer?.aborted) stop.abort();
  const timer = setTimeout(interrupt, c.limits.maxRuntimeMs);
  const stopped = ():Code => outer?.aborted ? 'verifier-interrupted' : 'verifier-runtime-limit';
  const guard = () => {
    if (stop.signal.aborted || performance.now() - start >= c.limits.maxRuntimeMs) fail(stopped());
  };
  const transport = new AuthorityTransport(c, c.httpDeadlineMs);
  let steps = 0, state:Journal|undefined, accepted = 0, pending = 0;
  const durableCounts = () => {
    accepted = state!.entries.filter(e => e.state === 'accepted').length;
    pending = state!.entries.filter(e => e.state === 'pending').length;
  };
  const summary = (code:Code):VerifierSummary => ({version:1, code, steps,
    accepted, pending});
  try {
    guard();
    return await withPrivateState<unknown,VerifierSummary>(c.journalRoot, 'verifier', async session => {
      guard();
      let binding:Journal['binding'];
      try {binding = credentials(c);} catch {return summary('verifier-credential-blocked');}
      const raw = await session.load(); guard();
      if (raw === null) {
        // Shared load() uses null for ENOENT; an existing JSON null is corrupt, not a fresh journal.
        let absent = false;
        try {await lstat(join(c.journalRoot,'verifier.json'));}
        catch (e) {if ((e as NodeJS.ErrnoException).code === 'ENOENT') absent = true; else throw e;}
        guard(); need(absent, 'verifier-state-rejected');
      }
      state = raw === null ? {version:1, binding, blocked:null, entries:[]} : journal(raw, c, binding);
      durableCounts();
      if (state.blocked) return summary(state.blocked);
      const save = async () => {guard(); await session.save(state!); durableCounts(); guard();};
      if (raw === null) await save();
      const block = async (code:Code, entry?:Entry) => {
        guard(); state!.blocked = code;
        if (entry) entry.state = 'blocked';
        await save(); return summary(code);
      };
      const checkCredentials = () => {
        try {need(canonical(credentials(c)) === canonical(state!.binding), 'verifier-credential-blocked');}
        catch {fail('verifier-credential-blocked');}
      };
      const backoff = (attempt:number) => pause(Math.min(c.limits.maxBackoffMs,
        c.limits.minBackoffMs * 2 ** Math.min(attempt,32)), stop.signal);
      // Read retry budgets are per observation; total work/time is also bounded by maxSteps/runtime.
      const read = async (operation:()=>Promise<unknown>) => {
        for (let retry = 0;;retry++) {
          guard(); checkCredentials();
          try {const value = await operation(); guard(); return value;}
          catch (e) {guard(); if (!transient(e)) throw e;
            if (retry >= c.limits.maxRetries) fail('verifier-retry-exhausted');
            await backoff(retry);
          }
        }
      };
      for (;steps < c.limits.maxSteps;) {
        guard(); steps++;
        // Resolve saved intent before any discovery. Status is a pinned identity/epoch check,
        // not a fleet feed; an unrelated retained workload can never prevent exact replay.
        let entry = state.entries.find(e => e.state === 'pending');
        try {
          const status = await read(() => transport.status(c.ownerCredentialReference,stop.signal)) as {epoch:number};
          if (status.epoch !== c.expectedEpoch) fail('verifier-authority-blocked');
        } catch (e) {
          guard();
          const code = e instanceof PilotError && member(e.code) ? e.code : 'verifier-authority-blocked';
          if (code === 'verifier-retry-exhausted') return summary(code);
          return await block(code);
        }
        let newIntentDeadline:number|undefined;
        if (!entry) {
          // Rotate through the canonical configured allowlist, one exact-ID lookup per step.
          // No global history, event counts, pagination or completeness requirement is involved.
          const workloadId = c.allowedWorkloadIds[(steps - 1) % c.allowedWorkloadIds.length]!;
          let view!:WorkloadObservation;
          try {
            const rawView = await read(() => transport.request(c.ownerCredentialReference, '/v1/operator/workload',
              {expectedEpoch:c.expectedEpoch, workloadId},65536,false,stop.signal));
            try {view = observation(rawView,c,workloadId);} catch {fail('verifier-feed-blocked');}
          } catch (e) {
            guard();
            const code = e instanceof PilotError && member(e.code) ? e.code : 'verifier-authority-blocked';
            if (code === 'verifier-retry-exhausted') return summary(code);
            return await block(code);
          }
          const observedMono = performance.now();
          const now = Math.max(Date.now(),view.observedAt);
          const l = view.lease, w = view.workload;
          // VERIFYING has its own core lifetime. Execution expiresAt/capAt no longer gate it.
          if (!(l !== null && w !== null && view.receipt === null && l.state === 'VERIFYING' &&
              l.epoch === c.expectedEpoch && l.verificationDeadline !== null && l.verificationDeadline > now &&
              w.status === 'VERIFYING' && w.winner === null && w.generation === l.generation &&
              !state.entries.some(e => e.body.request.leaseId === l.id))) {
            await pause(c.limits.minBackoffMs,stop.signal); continue;
          }
          if (state.entries.length >= 128) return await block('verifier-capacity');
          newIntentDeadline = observedMono + l.verificationDeadline! - now;
          entry = {workloadId:l.workloadId, body:bodyFor(c,l.workloadId,{
            leaseId:l.id, epoch:l.epoch, generation:l.generation, incarnation:l.incarnation,
          }), attempts:0, state:'pending', acceptance:null};
          state.entries.push(entry);
          await save(); // Full exact /v1/verify body is durable BEFORE the first POST.
        }
        // Pending intents are replayed without discovery, including after acceptance or expiry:
        // only the core's idempotent reply can resolve a lost response. Never adopt a new fence/key.
        for (;;) {
          guard();
          // Do not initiate a newly discovered lease after its remaining runway elapsed during fsync.
          // Preserve its full pending intent if this happens; no replacement key or another lease.
          if (newIntentDeadline !== undefined && performance.now() >= newIntentDeadline)
            return await block('verifier-authority-blocked');
          if (entry.attempts >= c.limits.maxRetries + 1) return summary('verifier-retry-exhausted');
          try {checkCredentials();} catch {return await block('verifier-credential-blocked');}
          entry.attempts++; await save(); // Persist attempt budget too, so restarts cannot reset it.
          if (newIntentDeadline !== undefined && performance.now() >= newIntentDeadline)
            return await block('verifier-authority-blocked');
          let reply:unknown;
          try {
            guard(); checkCredentials();
            newIntentDeadline = undefined; // Subsequent attempts replay exactly, including after expiry.
            reply = await transport.request(c.verifierCredentialReference,'/v1/verify',entry.body,65536,false,stop.signal);
            guard();
          } catch (e) {
            guard();
            if (!transient(e)) return await block(e instanceof PilotError && e.code === 'verifier-credential-blocked' ?
              'verifier-credential-blocked' : 'verifier-rejected',entry);
            if (entry.attempts >= c.limits.maxRetries + 1) return summary('verifier-retry-exhausted');
            await backoff(entry.attempts - 1); continue;
          }
          if (reply && typeof reply === 'object' && (reply as {ok?:unknown}).ok === false) {
            // This is the sole retryable noncommitted core verification failure. Never print code/text.
            const r = reply as Record<string,unknown>;
            if (Object.keys(r).sort().join(',') === 'code,ok' && r.code === 'artifact-unavailable') {
              if (entry.attempts >= c.limits.maxRetries + 1) return summary('verifier-retry-exhausted');
              await backoff(entry.attempts - 1); continue;
            }
            return await block('verifier-rejected',entry);
          }
          try {entry.acceptance = acceptance(reply,entry,c);} catch {return await block('verifier-receipt-blocked',entry);}
          guard(); entry.state = 'accepted'; await save(); break;
        }
      }
      guard(); return summary('verifier-complete');
    });
  } catch (e) {
    if (stop.signal.aborted || performance.now() - start >= c.limits.maxRuntimeMs) return summary(stopped());
    return summary(e instanceof PilotError && member(e.code) ? e.code : 'verifier-state-rejected');
  } finally {
    clearTimeout(timer); stop.abort(); outer?.removeEventListener('abort',interrupt);
  }
}

export async function main(argv = process.argv.slice(2)):Promise<number> {
  const stop = new AbortController(), interrupt = () => stop.abort();
  process.on('SIGINT',interrupt); process.on('SIGTERM',interrupt);
  let result:VerifierSummary;
  try {
    need(argv.length === 2 && argv[0] === '--config', 'verifier-cli');
    result = await runVerifier(await loadVerifierConfig(argv[1]!),stop.signal);
  } catch {result = empty('verifier-state-rejected');}
  finally {process.removeListener('SIGINT',interrupt); process.removeListener('SIGTERM',interrupt);}
  process.stdout.write(JSON.stringify(result)+'\n'); // Fixed enum/counters only.
  return result.code === 'verifier-disabled' || result.code === 'verifier-complete' ? 0 :
    result.code === 'verifier-interrupted' ? 130 : 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().then(code => {process.exitCode = code;}, () => {process.exitCode = 2;});
}

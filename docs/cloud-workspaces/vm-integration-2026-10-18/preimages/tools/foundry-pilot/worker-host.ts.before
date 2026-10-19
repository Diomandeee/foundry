/** Standalone source CLI using the repository's existing tsx loader (no install/build):
 * from source/: ./node_modules/.bin/tsx tools/foundry-pilot/worker-host.ts --config /absolute/private/config.json
 * Documentation only: this entry point has not been executed under R1 authorization.
 */
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {boundedStep, type HostFetch, type HostJournal, type JournalState, type Summary} from '../../packages/worker-client/src/index';
import {NodeHostJournal} from '../../packages/worker-client/src/node';
import {WorkerRuntime, identityKey, pilotRunwayBudget, profileDigest} from '../../packages/worker-runtime/src/index';
import {NodeCliAdapter, NodeStagingPort} from '../../packages/worker-runtime/src/node';
import {canonical} from '../../packages/library-jobs/src/data';
import {credential, digest, exact, need, PilotError, privateDirectory, uint, withPrivateState} from './private-state';
import {AuthorityTransport} from './transport';
import {loadWorkerConfig, parseWorkerConfig, workerIdentity, type WorkerConfig} from './worker-config';

type Code = 'worker-disabled' | 'worker-complete' | 'worker-interrupted' | 'worker-blocked' |
  'worker-retry-limit' | 'worker-runtime-limit' | 'worker-state-rejected';
export interface WorkerSummary {code: Code; steps: number; retries: number; heartbeats: number; staged: number}
interface HeartbeatBody {
  expectedEpoch: number;
  request: {key: string; sequence: number; observedIdentity: WorkerConfig['identity']};
}
interface State {
  version: 1; binding: string; step: number; stepKey: string;
  phase: 'pending' | 'terminal' | 'blocked'; code: Code;
  attempts: number; steps: number; retries: number; heartbeats: number; staged: number;
  startedAt: number; deadlineAt: number; lastClock: number; notBefore: number;
  /** First observed server identity; null until the pre-admission /v1/status check succeeds. */
  authority: {environment: string; authorityId: string; epoch: number} | null;
  edge: {sequence: number; lastSeen: number | null; pending: HeartbeatBody | null};
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const stepKey = (binding: string, step: number) => hash(['worker-step/v1',binding,step]);
const heartbeatKey = (binding: string, step: string, sequence: number) => hash(['edge-heartbeat/v1',binding,step,sequence]);
const result = (s: State, code: Code = s.code): WorkerSummary =>
  ({code, steps:s.steps, retries:s.retries, heartbeats:s.heartbeats, staged:s.staged});
const empty = (code: Code): WorkerSummary => ({code,steps:0,retries:0,heartbeats:0,staged:0});
const codes = new Set<Code>(['worker-disabled','worker-complete','worker-interrupted','worker-blocked',
  'worker-retry-limit','worker-runtime-limit','worker-state-rejected']);

// Process-local admission survives logical client timeouts and supervisor retries,
// including another invocation in this process. Never infer cleanup from abort.
let outstandingHttp = 0;
const retainedFetch: HostFetch = async (url, init) => {
  need(outstandingHttp < 4, 'worker-http-busy',429);
  need(!init.signal.aborted, 'worker-http-aborted',408);
  outstandingHttp++;
  let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cleanup: Promise<unknown> | undefined;
  const stop = () => {
    if (!cleanup && reader) cleanup = reader.cancel();
    return cleanup;
  };
  const cancel = () => {void stop()?.catch(() => {});};
  init.signal.addEventListener('abort',cancel,{once:true});
  try {
    response = await fetch(url,init as unknown as RequestInit);
    need(!response.redirected && !init.signal.aborted,'worker-http-rejected');
    reader = response.body?.getReader();
    need(reader,'worker-http-body');
    const chunks: Uint8Array[] = []; let size = 0;
    for (let count = 0;;count++) {
      need(!init.signal.aborted && count < 4096,'worker-http-aborted');
      const part = await reader!.read();
      need(!init.signal.aborted,'worker-http-aborted');
      if (part.done) break;
      size += part.value.byteLength; need(size <= 65536,'worker-http-size'); chunks.push(part.value);
    }
    // Client receives bounded buffered bytes only AFTER original stream cleanup.
    return new Response(Buffer.concat(chunks),{status:response.status,statusText:response.statusText,headers:response.headers});
  } finally {
    try {
      if (reader) {try {await stop();} finally {reader.releaseLock();}}
      else await response?.body?.cancel();
    } finally {
      init.signal.removeEventListener('abort',cancel);
      outstandingHttp--;
    }
  }
};

function stateFrom(value: unknown, c: WorkerConfig, binding: string): State {
  exact(value, ['version','binding','step','stepKey','phase','code','attempts','steps','retries','heartbeats',
    'staged','startedAt','deadlineAt','lastClock','notBefore','authority','edge']);
  need(value.version === 1 && value.binding === binding, 'worker-supervisor-rebind');
  if (value.authority !== null) {
    exact(value.authority, ['environment','authorityId','epoch']);
    need(typeof value.authority.environment === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value.authority.environment) &&
      typeof value.authority.authorityId === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value.authority.authorityId) &&
      uint(value.authority.epoch), 'worker-ambiguous-authority');
  }
  digest(value.stepKey); uint(value.step, 1, c.limits.maxSteps);
  need(value.stepKey === stepKey(binding, value.step), 'worker-ambiguous-step');
  need(['pending','terminal','blocked'].includes(value.phase) && codes.has(value.code), 'worker-invalid-state');
  uint(value.attempts, 0, c.limits.maxRetries + 1); uint(value.steps, 0, c.limits.maxSteps);
  uint(value.retries, 0, c.limits.maxSteps * c.limits.maxRetries);
  uint(value.heartbeats, 0, value.steps); uint(value.staged, 0, value.steps);
  need(value.heartbeats + value.staged <= value.steps &&
    (value.phase === 'terminal' ? value.steps === value.step : value.phase === 'pending' ?
      value.steps === value.step - 1 : value.steps === value.step - 1 || value.steps === value.step), 'worker-ambiguous-counters');
  uint(value.startedAt, 1); uint(value.deadlineAt, value.startedAt + 1); uint(value.lastClock, value.startedAt);
  uint(value.notBefore);
  need(value.deadlineAt === value.startedAt + c.limits.maxRuntimeMs, 'worker-ambiguous-deadline');
  exact(value.edge, ['sequence','lastSeen','pending']); uint(value.edge.sequence);
  need(value.edge.lastSeen === null || Number.isSafeInteger(value.edge.lastSeen) && value.edge.lastSeen >= 0, 'worker-ambiguous-heartbeat');
  if (value.edge.pending !== null) {
    const b = value.edge.pending;
    exact(b, ['expectedEpoch','request']); exact(b.request, ['key','sequence','observedIdentity']);
    need(c.identity.workerClass === 'edge' && value.phase !== 'terminal' && b.expectedEpoch === c.expectedEpoch &&
      b.request.sequence === value.edge.sequence && b.request.sequence > 0 &&
      b.request.key === heartbeatKey(binding,value.stepKey,b.request.sequence) &&
      canonical(workerIdentity(b.request.observedIdentity)) === canonical(c.identity), 'worker-ambiguous-heartbeat-intent');
  }
  if (c.identity.workerClass === 'general') need(value.edge.sequence === 0 && value.edge.lastSeen === null &&
    value.edge.pending === null, 'worker-edge-state-on-general');
  return value as State;
}

/** Abortable bounded delay; no listener survives the delay. */
async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return;
  await new Promise<void>(done => {
    const finish = () => {clearTimeout(timer); signal.removeEventListener('abort',finish); done();};
    const timer = setTimeout(finish, Math.min(ms, 300000));
    signal.addEventListener('abort', finish, {once:true});
    if (signal.aborted) finish();
  });
}

/** Edge has no runtime port, profile, poll or artifact route. Replayed lastSeen is historical. */
async function edgeStep(c: WorkerConfig, s: State, save: () => Promise<void>, transport: AuthorityTransport,
  signal: AbortSignal): Promise<Summary> {
  if (!s.edge.pending) {
    need(s.edge.sequence < Number.MAX_SAFE_INTEGER, 'worker-sequence-capacity');
    s.edge.sequence++;
    s.edge.pending = {expectedEpoch:c.expectedEpoch, request:{key:heartbeatKey(s.binding,s.stepKey,s.edge.sequence),
      sequence:s.edge.sequence, observedIdentity:c.identity}};
    await save();
  }
  const reply = await transport.request(c.credentialReference,'/v1/enrollment/heartbeat',s.edge.pending,65536,false,signal);
  exact(reply, ['ok','status']); need(reply.ok === true, 'worker-heartbeat-rejected');
  const st = reply.status, now = Date.now();
  exact(st, ['role','workerId','principal','revision','incarnation','identity','expiresAt','revokedAt','lastSeen','sequence','freshness']);
  uint(st.lastSeen); uint(st.expiresAt, 1);
  need(st.role === 'executor' && st.workerId === c.identity.workerId && st.principal === c.identity.principal &&
    st.revision === c.revision && st.incarnation === c.incarnation && st.sequence === s.edge.sequence &&
    st.freshness === 'fresh' && st.revokedAt === null && st.expiresAt > now && st.lastSeen <= now &&
    (s.edge.lastSeen === null || st.lastSeen >= s.edge.lastSeen) &&
    canonical(workerIdentity(st.identity)) === canonical(c.identity), 'worker-heartbeat-binding');
  // Acknowledge the exact sequence before scheduling a fresh request. A crash here only replays.
  s.edge.lastSeen = st.lastSeen; s.edge.pending = null;
  s.notBefore = Math.max(s.notBefore, now + c.heartbeat.minIntervalMs);
  await save();
  return now - st.lastSeen < c.heartbeat.refreshMs && now - st.lastSeen < c.heartbeat.freshnessMs ?
    {kind:'heartbeat'} : {kind:'retry'};
}

/** Entire supervisor lifetime is bounded, including across restarts. No root/key rotation on failure. */
export async function runWorker(input: WorkerConfig, outer?: AbortSignal): Promise<WorkerSummary> {
  const c = parseWorkerConfig(input);
  if (!c.enabled) return empty('worker-disabled');
  // A general worker must not even heartbeat/poll under an execution-disabled runtime.
  if (c.identity.workerClass === 'general' && c.general?.cli.allowActivation !== true) return empty('worker-blocked');
  await privateDirectory(c.journalRoot); await privateDirectory(c.supervisorRoot);
  if (c.general) await privateDirectory(c.general.stagingRoot);
  const {enabled: _enabled, ...boundConfig} = c;
  const binding = hash(['worker-supervisor/v1',boundConfig]);
  const journal = new NodeHostJournal(c.journalRoot);
  // Separate durable root binding protects even edge (which has no client state.json).
  return withPrivateState<{version:1;binding:string},WorkerSummary>(c.journalRoot,'worker-binding', async rootSession => {
    const rootBinding = await rootSession.load();
    if (rootBinding !== null) {
      exact(rootBinding,['version','binding']);
      need(rootBinding.version === 1 && rootBinding.binding === binding,'worker-journal-root-rebind');
    }
    return withPrivateState<State,WorkerSummary>(c.supervisorRoot,'worker-supervisor', async session => {
    const loaded = await session.load();
    need((rootBinding === null) === (loaded === null),'worker-missing-bound-state');
    let s: State;
    if (loaded === null) {
      // An orphaned client journal is evidence, never permission to create a new supervisor.
      await journal.exclusive(async j => need(await j.load() === null, 'worker-orphaned-journal'));
      const now = Date.now();
      s = {version:1,binding,step:1,stepKey:stepKey(binding,1),phase:'pending',code:'worker-interrupted',
        attempts:0,steps:0,retries:0,heartbeats:0,staged:0,startedAt:now,deadlineAt:now+c.limits.maxRuntimeMs,
        lastClock:now,notBefore:0,authority:null,edge:{sequence:0,lastSeen:null,pending:null}};
      await rootSession.save({version:1,binding});
      await session.save(s); // Durable binding and first step before credentials or network/runtime I/O.
    } else s = stateFrom(loaded,c,binding);
    if (s.phase === 'blocked') return result(s);
    const save = () => session.save(s);
    const block = async (code: Code): Promise<WorkerSummary> => {
      s.phase = 'blocked'; s.code = code; await save(); return result(s);
    };
    const abort = new AbortController(), cancel = () => abort.abort();
    outer?.addEventListener('abort',cancel,{once:true}); if (outer?.aborted) cancel();
    const remaining = Math.max(0,s.deadlineAt-Date.now());
    const monotonicEnd = performance.now() + remaining;
    const timer = setTimeout(cancel,remaining);
    try {
      const runtime = c.general ? new WorkerRuntime(c.general.profile, new NodeCliAdapter(c.general.cli),
        new NodeStagingPort(c.general.stagingRoot)) : undefined;
      const transport = new AuthorityTransport(c,c.httpDeadlineMs);
      const hostFetch: HostFetch = async (url, init) => {
        need([c.origin+'/v1/enrollment/heartbeat', c.origin+'/v1/worker/poll', c.origin+'/v1/artifacts'].includes(url), 'worker-route-forbidden');
        return retainedFetch(url,init);
      };
      for (;;) {
        const now = Date.now();
        need(now >= s.lastClock, 'worker-clock-regressed'); s.lastClock = now;
        if (s.phase === 'terminal' && s.steps === c.limits.maxSteps) return result(s,'worker-complete');
        if (now >= s.deadlineAt || performance.now() >= monotonicEnd) return await block('worker-runtime-limit');
        if (outer?.aborted) {s.code='worker-interrupted'; await save(); return result(s);}
        if (s.phase === 'terminal') {
          s.step++; s.stepKey=stepKey(binding,s.step); s.phase='pending'; s.attempts=0; s.code='worker-interrupted';
          await save();
        }
        if (s.attempts >= c.limits.maxRetries + 1) return await block('worker-retry-limit');
        if (s.notBefore > now) {await delay(Math.min(s.notBefore-now,s.deadlineAt-now),abort.signal); continue;}
        if (abort.signal.aborted) return await block('worker-runtime-limit');
        const attemptsBefore = s.attempts;
        let clientState: JournalState | null = null;
        // Validate inside the SAME exclusive journal session that boundedStep will use.
        const guardedJournal: HostJournal = {exclusive: run => journal.exclusive(async j => {
          const previous = await j.load();
          if (previous === null) need(s.step === 1 && attemptsBefore === 0, 'worker-missing-journal');
          else need(previous.version === 1 && (previous.stepKey === s.stepKey ||
            attemptsBefore === 0 && s.step > 1 && previous.stepKey === stepKey(binding,s.step-1) && previous.phase === 'done'), 'worker-journal-step-mismatch');
          clientState = previous;
          return run({load:async () => clientState,save:async state => {
            await j.save(state); clientState = state;
          }});
        })};
        if (s.attempts > 0) s.retries++;
        s.attempts++;
        // Persist attempt budget and retry barrier BEFORE an operation can reach a remote peer.
        const backoff = Math.min(c.limits.maxBackoffMs,c.limits.minBackoffMs * 2 ** (s.attempts-1));
        s.notBefore = now + Math.max(c.heartbeat.minIntervalMs,backoff);
        await save();
        let summary: Summary;
        try {
          // Server-derived identity gate: the configured environment/authority pins must
          // match the live authority BEFORE any heartbeat, poll, claim or physical start.
          if (c.general) {
            const observed = await transport.status(c.credentialReference, abort.signal);
            need(observed.epoch === c.expectedEpoch, 'worker-authority-epoch');
            if (s.authority === null) { s.authority = observed; await save(); }
            else need(s.authority.environment === observed.environment &&
              s.authority.authorityId === observed.authorityId &&
              s.authority.epoch === observed.epoch, 'worker-authority-rebind');
          }
          summary = runtime && c.general ? await boundedStep({origin:c.origin, credentialReference:c.credentialReference,
            environment:c.environment, authorityId:c.authorityId,
            identity:c.identity, expectedEpoch:c.expectedEpoch, revision:c.revision, incarnation:c.incarnation,
            stepKey:s.stepKey, heartbeatRefreshMs:c.heartbeat.refreshMs, profile:c.general.profile,
            ttlMs:c.general.ttlMs, httpDeadlineMs:c.httpDeadlineMs},
          {fetch:hostFetch,journal:guardedJournal,credential:async reference => credential(reference),runtime:{
            runBoundedJob:async (plan,signal) => {
              const g = c.general!;
              const budget = pilotRunwayBudget(g.profile,c.httpDeadlineMs);
              const work = clientState?.work;
              need(work && clientState?.phase === 'running','worker-start-state');
              const frozenWork = canonical(work);
              const observedAt = Date.now(), observedMono = performance.now();
              const leaseEnd = observedMono + Math.max(0,work.lease.expires_ms - observedAt);
              const assertRunway = (required: number) => {
                const current = clientState, l = current?.work?.lease;
                need(!signal?.aborted && current?.phase === 'running' && current.stepKey === s.stepKey &&
                  current.work && canonical(current.work) === frozenWork && l &&
                  l.state === 'RUNNING' && l.worker_id === c.identity.workerId && l.workload_id === work.workload.id &&
                  l.epoch === c.expectedEpoch && l.incarnation === c.incarnation &&
                  identityKey({leaseId:l.id,epoch:l.epoch,generation:l.generation,incarnation:l.incarnation}) === identityKey(plan.identity) &&
                  current.work.profileHash === profileDigest(g.profile) && plan.specification === work.workload.specification &&
                  plan.expectedHash === work.workload.expectedHash,'worker-start-fence');
                const now = Date.now(), mono = performance.now();
                need(now >= observedAt && now >= s.lastClock &&
                  Math.min(l.expires_ms-now,s.deadlineAt-now,leaseEnd-mono,monotonicEnd-mono) > required,
                  'worker-insufficient-start-runway');
              };
              // Full budget after durable client running marker; checked again after
              // preflight/create/inspect AND after Node adapter async path checks.
              assertRunway(budget.totalMs);
              return runtime.runBoundedJob(plan,signal,{assertStart:() => assertRunway(budget.startMs)});
            }
          }},abort.signal) :
            await edgeStep(c,s,save,transport,abort.signal);
        } catch (error) {
          // Shared transport intentionally omits domain bodies. Unknown 409 is conservatively permanent.
          summary = error instanceof PilotError && [408,425,429,503,504].includes(error.status) ?
            {kind:'retry'} : {kind:'blocked'};
        }
        s.notBefore = Math.max(s.notBefore,Date.now() + c.heartbeat.minIntervalMs);
        if (summary.kind === 'blocked') return await block('worker-blocked');
        if (summary.kind !== 'retry') {
          s.steps++; if (summary.kind === 'heartbeat') s.heartbeats++;
          if (summary.kind === 'uploaded') s.staged++; // Staging only; never verification/acceptance.
          s.phase='terminal'; s.code='worker-complete';
          s.notBefore=Math.max(s.notBefore,Date.now()+c.heartbeat.refreshMs);
        }
        await save();
      }
    } catch {return await block('worker-blocked');}
    finally {clearTimeout(timer); outer?.removeEventListener('abort',cancel); abort.abort();}
    });
  });
}

/** Import-safe. Signal handlers are scoped to the CLI, never installed by library import. */
export async function main(argv = process.argv.slice(2)): Promise<number> {
  const stop = new AbortController();
  const interrupt = () => stop.abort();
  process.on('SIGINT',interrupt); process.on('SIGTERM',interrupt);
  let summary: WorkerSummary;
  try {
    need(argv.length === 2 && argv[0] === '--config', 'worker-cli-arguments');
    summary = await runWorker(await loadWorkerConfig(argv[1]!),stop.signal);
  } catch {summary = empty('worker-state-rejected');}
  finally {process.removeListener('SIGINT',interrupt); process.removeListener('SIGTERM',interrupt);}
  // Only a closed code enum and counters; no errors/config/identity/capabilities/runtime output.
  process.stdout.write(JSON.stringify(summary)+'\n');
  return summary.code === 'worker-disabled' || summary.code === 'worker-complete' ? 0 :
    summary.code === 'worker-interrupted' ? 130 : 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().then(code => {process.exitCode=code;}, () => {process.exitCode=2;});
}

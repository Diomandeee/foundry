import { createHash } from 'node:crypto';
import { executeEventSummaryForWorkload } from '../../epoch-jobs/src/index';

export interface ProfileConfig {
  image: string; cpu: number; ramMib: number; pids: number; tmpMib: number;
  maxOutputBytes: number; timeoutMs: number;
}
export type ExecutionProfile = Readonly<ProfileConfig>;
export interface JobIdentity { leaseId: string; epoch: number; generation: number; incarnation: number }
export interface Job extends JobIdentity {
  workerClass: 'general' | 'edge'; workloadId: string; specification: string;
}
export interface ExecutionPlan {
  readonly identity: Readonly<JobIdentity>; readonly name: string;
  readonly createArgv: readonly string[]; readonly specification: string; readonly expectedHash: string;
}
export interface CliResult { code: number | null; stdout: Uint8Array; stderr: Uint8Array; truncated: boolean; interrupted: boolean }
export interface ExecuteOptions {
  stdin: string; maxBytes: number; timeoutMs: number; signal?: AbortSignal;
  /** Synchronous admission check after adapter preparation, immediately before spawn. */
  beforeSpawn?: () => void;
}
export interface StartAdmission { assertStart(): void }
const controlDeadlineMs = 5000;
/** Pilot admission reserves, not physical duration guarantees. Four pre-start controls,
 * one completion inspect plus worst-case inspect/kill/inspect, poll + up to two
 * heartbeat requests + upload, and explicit slack for local durable/OS work.
 * Filesystem, scheduling, daemon and cancellation latency remain unbounded. */
export function pilotRunwayBudget(profile: ExecutionProfile, httpDeadlineMs: number): {totalMs: number; startMs: number} {
  integer(httpDeadlineMs,100,10000);
  const startMs = profile.timeoutMs + 4 * controlDeadlineMs + 3 * httpDeadlineMs + 8000;
  return {totalMs:4 * controlDeadlineMs + httpDeadlineMs + startMs,startMs};
}
/** Trusted host-injected port; exceptions and stderr are never surfaced as logs.
 * When provided, beforeSpawn must run synchronously after async preparation and
 * immediately before physical command admission; a throw must prevent spawn. */
export interface RuntimePort { execute(argv: readonly string[], options: ExecuteOptions): Promise<CliResult> }
export interface StagingPort { reserve(identityKey: string): Promise<void> }
export type StopEvidence = Readonly<{ identity: Readonly<JobIdentity>; containerId: string | null; stopped: boolean; reason: 'inspect-stopped' | 'unknown'; }>;
export interface RunResult { outcome: 'completed' | 'rejected' | 'interrupted' | 'failed'; output: Uint8Array; stop: StopEvidence }
const profiles = new WeakSet<object>();
const plans = new WeakMap<object, ExecutionProfile>();
const createArguments = new WeakSet<object>();
/** Internal adapter guard: only branded create arrays and fixed control grammar. */
export function allowedArgv(argv: readonly string[]): boolean {
  if (createArguments.has(argv)) return true;
  const id = (v: string | undefined) => !!v && /^[0-9a-f]{64}$/.test(v);
  if (argv.length === 3 && argv[0] === "info" && argv[1] === "--format" && argv[2] === "{{json .}}") return true;
  if (argv.length === 3 && argv[0] === "image" && argv[1] === "inspect" && /^[a-z0-9][a-z0-9./_-]{0,200}@sha256:[0-9a-f]{64}$/.test(argv[2] ?? "")) return true;
  if (argv.length === 2 && argv[0] === "inspect" && (id(argv[1]) || /^foundry-[0-9a-f]{64}$/.test(argv[1] ?? ""))) return true;
  if (argv.length === 3 && argv[0] === "kill" && argv[1] === "--signal=KILL" && id(argv[2])) return true;
  return argv.length === 4 && argv[0] === "start" && argv[1] === "--attach" && argv[2] === "--interactive" && id(argv[3]);
}
const digest = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
function check(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  check(value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype, 'invalid-object');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  check(Reflect.ownKeys(value).length === keys.length && keys.every(k => descriptors[k] && 'value' in descriptors[k]!), 'invalid-fields');
}
function integer(n: unknown, min: number, max: number): asserts n is number {
  check(typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max && !Object.is(n, -0), 'invalid-limit');
}
export function validateProfile(config: ProfileConfig, imageAllowlist: readonly string[]): ExecutionProfile {
  exact(config, ['image','cpu','ramMib','pids','tmpMib','maxOutputBytes','timeoutMs']);
  check(typeof config.image === 'string' && /^[a-z0-9][a-z0-9./_-]{0,200}@sha256:[0-9a-f]{64}$/.test(config.image) && imageAllowlist.includes(config.image), 'image-not-allowlisted');
  check(typeof config.cpu === 'number' && Number.isFinite(config.cpu) && config.cpu >= .1 && config.cpu <= 2 && Number.isInteger(config.cpu * 1000), 'invalid-cpu');
  integer(config.ramMib,64,512); integer(config.pids,8,64); integer(config.tmpMib,1,16);
  integer(config.maxOutputBytes,1,4096); integer(config.timeoutMs,1,30000);
  const profile = Object.freeze({...config}); profiles.add(profile); return profile;
}
/** Stable manifest digest; caller ordering cannot change approved profile identity. */
export function profileDigest(p:ExecutionProfile):string {
 return digest(JSON.stringify({image:p.image,cpu:p.cpu,ramMib:p.ramMib,pids:p.pids,tmpMib:p.tmpMib,maxOutputBytes:p.maxOutputBytes,timeoutMs:p.timeoutMs}));
}
function identity(input: JobIdentity): Readonly<JobIdentity> {
  check(typeof input.leaseId === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(input.leaseId), 'invalid-lease');
  integer(input.epoch,0,Number.MAX_SAFE_INTEGER); integer(input.generation,0,Number.MAX_SAFE_INTEGER); integer(input.incarnation,0,Number.MAX_SAFE_INTEGER);
  return Object.freeze({leaseId:input.leaseId,epoch:input.epoch,generation:input.generation,incarnation:input.incarnation});
}
export function identityKey(i: JobIdentity): string { return digest(JSON.stringify(identity(i))); }
export function buildPlan(profile: ExecutionProfile, job: Job): ExecutionPlan {
  check(profiles.has(profile), 'untrusted-profile');
  exact(job, ['workerClass','leaseId','epoch','generation','incarnation','workloadId','specification']);
  check(job.workerClass === 'general', 'edge-heartbeat-only');
  const fence = identity(job);
  check(typeof job.specification === 'string' && Buffer.byteLength(job.specification) <= 16384, 'invalid-specification');
  let expected: Uint8Array;
  try { expected = executeEventSummaryForWorkload(job.specification, job.workloadId); } catch (error) {
    throw new Error(error instanceof Error && error.message === 'workload-mismatch' ? 'workload-mismatch' : 'invalid-specification');
  }
  check(expected.length <= profile.maxOutputBytes, 'output-limit');
  const key = identityKey(fence), name = `foundry-${key}`;
  const createArgv = Object.freeze(['create','--name',name,'--label',`foundry.identity=${key}`,
    '--pull=never','--runtime=runc','--network=none','--read-only','--user=65532:65532',
    '--privileged=false','--cgroupns=private','--cap-drop=ALL','--security-opt=no-new-privileges=true','--ipc=private',
    '--cpus',String(profile.cpu),'--memory',`${profile.ramMib}m`,'--memory-swap',`${profile.ramMib}m`,
    '--pids-limit',String(profile.pids),'--ulimit','nofile=64:64','--ulimit','core=0:0',
    '--tmpfs',`/tmp:rw,noexec,nosuid,nodev,size=${profile.tmpMib}m,mode=1777`,
    '--shm-size',`${profile.tmpMib}m`,'--log-driver=none',
    '--env','NVIDIA_VISIBLE_DEVICES=void','--env','HOME=/tmp','--workdir=/tmp',
    '--entrypoint=/usr/local/bin/node','--interactive',profile.image,'/opt/foundry/event-summary.cjs']);
  const plan = Object.freeze({identity:fence,name,createArgv,specification:job.specification,expectedHash:digest(expected)});
  createArguments.add(createArgv); plans.set(plan,profile); return plan;
}
interface Inspection { Id: string; State: {Running: boolean; Status: string; ExitCode: number}; Config: {Labels: Record<string,string>} }
/** Bounded JSON, exact ID and label matching. Missing/ambiguous data never proves stop. */
function inspectResult(result: CliResult, key: string, expectedId?: string): Inspection {
  check(result.code === 0 && !result.truncated && !result.interrupted, 'inspect-unavailable');
  const rows: unknown = JSON.parse(Buffer.from(result.stdout).toString('utf8'));
  check(Array.isArray(rows) && rows.length === 1, 'inspect-invalid');
  const row = rows[0] as Inspection;
  check(/^[0-9a-f]{64}$/.test(row.Id) && (!expectedId || row.Id === expectedId) && row.Config?.Labels?.['foundry.identity'] === key, 'identity-mismatch');
  check(typeof row.State?.Running === 'boolean' && Number.isInteger(row.State.ExitCode), 'inspect-invalid');
  return row;
}
export class WorkerRuntime {
  private records = new Map<string,{identity: Readonly<JobIdentity>; id: string | null; name: string; attempted: boolean; startAttempted: boolean}>();
  private inFlight = new Set<string>();
  constructor(private readonly profile: ExecutionProfile, private readonly port: RuntimePort, private readonly staging: StagingPort) {
    check(profiles.has(profile),'untrusted-profile');
  }
  private async control(argv: readonly string[]): Promise<CliResult> {
    return this.port.execute(argv,{stdin:'',maxBytes:65536,timeoutMs:controlDeadlineMs});
  }
  private async preflight(): Promise<void> {
    const info = await this.control(['info','--format','{{json .}}']);
    check(info.code === 0 && !info.truncated && !info.interrupted, 'docker-unavailable');
    const data = JSON.parse(Buffer.from(info.stdout).toString('utf8')) as Record<string,unknown>;
    check(data.OSType === 'linux' && data.CgroupVersion === '2' && Array.isArray(data.SecurityOptions) && data.SecurityOptions.every(s => typeof s === 'string') && data.SecurityOptions.some(s => typeof s === 'string' && s === 'name=seccomp,profile=builtin') && (data.Warnings === null || (Array.isArray(data.Warnings) && data.Warnings.length === 0)) && data.CpuCfsQuota === true && data.MemoryLimit === true && data.PidsLimit === true, 'daemon-security-unsupported');
    const image = await this.control(['image','inspect',this.profile.image]);
    check(image.code === 0 && !image.truncated && !image.interrupted, 'image-unavailable');
    const rows = JSON.parse(Buffer.from(image.stdout).toString('utf8')) as Array<{RepoDigests?: string[]; Config?: {Volumes?: object | null}}>;
    check(rows.length === 1 && rows[0]?.RepoDigests?.includes(this.profile.image) && rows[0].Config && (!rows[0].Config.Volumes || Object.keys(rows[0].Config.Volumes).length === 0), 'image-security-unsupported');
  }
  async stopEvidence(fence: JobIdentity): Promise<StopEvidence> {
    const key = identityKey(fence), record = this.records.get(key);
    const unknown = (): StopEvidence => Object.freeze({identity:identity(fence),containerId:record?.id ?? null,stopped:false,reason:'unknown'});
    if (!record || !record.attempted || this.inFlight.has(key)) return unknown();
    try {
      let state = inspectResult(await this.control(['inspect',record.id ?? record.name]),key,record.id ?? undefined);
      record.id = state.Id;
      if (state.State.Running || !['exited','dead','created'].includes(state.State.Status)) {
        await this.control(['kill','--signal=KILL',state.Id]);
        state = inspectResult(await this.control(['inspect',state.Id]),key,state.Id);
      }
      // A created-but-never-started container is physically idle only after activation has settled.
      if (state.State.Running || !['exited','dead','created'].includes(state.State.Status) || (record.startAttempted && state.State.Status === 'created')) return unknown();
      return Object.freeze({identity:record.identity,containerId:state.Id,stopped:true,reason:'inspect-stopped'});
    } catch { return unknown(); }
  }
  async runBoundedJob(plan: ExecutionPlan, signal?: AbortSignal, admission?: StartAdmission): Promise<RunResult> {
    check(plans.get(plan) === this.profile,'untrusted-plan');
    const key = identityKey(plan.identity);
    check(!this.records.has(key),'identity-already-used');
    check(this.records.size < 1024,'runtime-history-full');
    this.records.set(key,{identity:plan.identity,id:null,name:plan.name,attempted:false,startAttempted:false});
    let output = new Uint8Array(0), outcome: RunResult['outcome'] = 'rejected';
    try {
      check(!signal?.aborted,'cancelled');
      await this.staging.reserve(key);
      await this.preflight();
      check(!signal?.aborted,'cancelled');
      this.inFlight.add(key);
      this.records.get(key)!.attempted = true;
      const created = await this.control(plan.createArgv);
      check(created.code === 0 && !created.truncated && !created.interrupted && created.stderr.length === 0,'create-failed');
      const id = Buffer.from(created.stdout).toString('utf8').trim();
      check(/^[0-9a-f]{64}$/.test(id),'create-ambiguous');
      this.records.get(key)!.id = id;
      inspectResult(await this.control(['inspect',id]),key,id);
      check(!signal?.aborted,'cancelled');
      admission?.assertStart();
      if (!admission) this.records.get(key)!.startAttempted = true;
      const result = await this.port.execute(['start','--attach','--interactive',id],{
        stdin:plan.specification,maxBytes:this.profile.maxOutputBytes,timeoutMs:this.profile.timeoutMs,
        ...(signal ? {signal} : {}), ...(admission ? {beforeSpawn:() => {
          check(!signal?.aborted,'cancelled'); admission.assertStart();
          this.records.get(key)!.startAttempted = true;
        }} : {})});
      outcome = result.interrupted ? 'interrupted' : 'failed';
      if (!result.interrupted && !result.truncated && result.code === 0 && result.stdout.length <= this.profile.maxOutputBytes && digest(result.stdout) === plan.expectedHash) {
        const state = inspectResult(await this.control(['inspect',id]),key,id);
        if (!state.State.Running && state.State.Status === 'exited' && state.State.ExitCode === 0) { output = Uint8Array.from(result.stdout); outcome = 'completed'; }
      }
    } catch { outcome = signal?.aborted ? 'interrupted' : 'rejected'; }
    finally { this.inFlight.delete(key); }
    const stop = await this.stopEvidence(plan.identity);
    if (!stop.stopped || outcome !== 'completed') output = new Uint8Array(0);
    if (!stop.stopped && outcome === 'completed') outcome = 'failed';
    return {outcome,output,stop};
  }
}

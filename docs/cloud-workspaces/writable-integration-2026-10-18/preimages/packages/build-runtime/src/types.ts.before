export interface RuntimePlan {
  attemptId: string; jobId: string; kind: 'linux-build-v1' | 'xcode-build-v1';
  profileHash: string; inputRoot: string; workRoot: string; timeoutMs: number;
  cpu: number; ramMib: number; argv: readonly string[];
  env: Readonly<Record<string, string>>; image?: string; outputPaths: readonly string[];
}
export interface Limits {
  cpu: number; ramMib: number; pids: number; timeoutMs: number;
  maxOutputBytes: number; tmpMib: number; minFreeBytes: number;
}
export interface HostPolicy {
  /** All paths/accounts are provisioned by the owner, never by this package. */
  uid: number; gid: number; dedicatedBuildUser: true; allowActivation: boolean;
  inputBase: string; workBase: string; journalRoot: string;
  /** Owner-vetted canonical absolute executables INSIDE the pinned image. */
  imageExecutables?: Readonly<Partial<Record<'npm'|'cargo'|'cmake',string>>>;
}
export interface LinuxRecipe {
  kind: 'linux-build-v1'; image: string; architecture: 'x64' | 'arm64';
  /** Fixed executable INSIDE an owner-vetted image; no shell or remote argv. */
  tool: 'npm'|'cargo'|'cmake'; args: readonly string[];
  network: 'none'|'approved-dependencies'; outputPaths: readonly string[];
  /** Owner-only configure arguments, separate from the approved build arguments. */
  configureArgs?: readonly string[];
}
export interface XcodeRecipe {
  kind: 'xcode-build-v1'; developerDir: string; project: string; scheme: string;
  sdk: string; destination: string; configuration: 'Debug' | 'Release';
  trustedNativeProject: true; dependencyPolicy: 'preloaded-offline';
  xcodeBuild: string; macos: string;
  outputPaths: readonly string[];
}
export type Recipe = LinuxRecipe | XcodeRecipe;
export interface Approval { recipe: Recipe; limits: Limits; host: HostPolicy }
export interface Attempt { attemptId: string; jobId: string; inputRoot: string; workRoot: string }
export interface Exit { code: number | null; signal: string | null; output: Uint8Array; limited: boolean }
export interface StopProof {
  stopped: boolean; basis: 'container-inspect' | 'host-containment-inspect' | 'unknown';
  /** Contains identifiers only, never command output, environment or secrets. */
  identity: string;
}
export interface Running {
  identity: string; completion: Promise<Exit>;
  stop(): Promise<StopProof>;
  inspectStopped(): Promise<StopProof>;
}
export interface RuntimeAdapter {
  prepare(plan: RuntimePlan): Promise<void>;
  /** Persist identity before physical activation. beforeStart is a synchronous fence. */
  start(plan: RuntimePlan, recordIdentity: (identity: string) => Promise<void>, beforeStart: () => void, scope?:ExecutionScope): Promise<Running>;
}
/** The supervisor is the sole slot owner. Runway is request-start anchored. */
export interface ExecutionScope {
  signal:AbortSignal; assertLease:()=>void; remainingMs:()=>number;
  reservation:import('./host.js').JournalReservation;
}
export interface LeasePort {
  /** Parent supplies authenticated/fenced authority; ttl MUST be honored or reject. */
  renew(plan: RuntimePlan, ttlMs: 60000, signal: AbortSignal): Promise<{ valid: boolean; cancel: boolean }>;
}
export interface SupervisorResult {
  outcome: 'completed' | 'failed' | 'cancelled' | 'lease-lost' | 'timeout' | 'quarantined';
  stop: StopProof; exit?: Exit;
}

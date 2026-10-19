import {isAbsolute, normalize, parse} from 'node:path';
import type {ApprovedIdentity} from '../../packages/worker-enrollment/src/contracts';
import {validateProfile, pilotRunwayBudget, type ExecutionProfile, type ProfileConfig} from '../../packages/worker-runtime/src/index';
import type {NodeCliConfig} from '../../packages/worker-runtime/src/node';
import {exact, id, need, readJsonFile, uint} from './private-state';

export interface WorkerConfig {
  version: 1;
  /** Omission in JSON means false. Source preparation is never activation consent. */
  enabled: boolean;
  origin: string; environment: string; authorityId: string;
  identity: ApprovedIdentity; revision: number; incarnation: number; expectedEpoch: number;
  credentialReference: string; journalRoot: string; supervisorRoot: string;
  heartbeat: {refreshMs: number; minIntervalMs: number; freshnessMs: number};
  limits: {maxSteps: number; maxRetries: number; maxRuntimeMs: number; minBackoffMs: number; maxBackoffMs: number};
  httpDeadlineMs: number;
  /** Required for general; forbidden (including null) for edge. */
  general?: {profile: ExecutionProfile; imageAllowlist: string[]; cli: NodeCliConfig; stagingRoot: string; ttlMs: number};
}

function path(value: unknown): asserts value is string {
  need(typeof value === 'string' && isAbsolute(value) && normalize(value) === value &&
    value !== parse(value).root && !value.includes('\0') && !value.endsWith('/'), 'worker-invalid-path');
}

/** Mirrors enrollment geometry, using the shared, deliberately narrower pilot ID policy. */
export function workerIdentity(value: unknown): ApprovedIdentity {
  exact(value, ['workerId','principal','workerClass','cpu','ramMib','devices']);
  id(value.workerId); id(value.principal);
  need(value.workerClass === 'general' || value.workerClass === 'edge', 'worker-invalid-class');
  uint(value.cpu, 0, 65536); uint(value.ramMib, 0, 1073741824);
  need(Array.isArray(value.devices) && value.devices.length <= 64, 'worker-invalid-devices');
  const devices = (value.devices as unknown[]).map(d => {
    exact(d, ['id','kind','vramMib']); id(d.id); uint(d.vramMib, 1, 1073741824);
    need(d.kind === 'cuda' || d.kind === 'metal', 'worker-invalid-device-kind');
    return {id: d.id, kind: d.kind as 'cuda' | 'metal', vramMib: d.vramMib};
  }).sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  need(new Set(devices.map(d => d.id)).size === devices.length, 'worker-duplicate-device');
  need(value.workerClass === 'edge' ? value.cpu === 0 && value.ramMib === 0 && devices.length === 0 :
    value.cpu > 0 && value.ramMib > 0, 'worker-invalid-geometry');
  return {workerId:value.workerId, principal:value.principal, workerClass:value.workerClass,
    cpu:value.cpu, ramMib:value.ramMib, devices};
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Pure configuration parsing: no credentials, filesystem provisioning or host probes. */
export function parseWorkerConfig(input: unknown): WorkerConfig {
  need(input !== null && typeof input === 'object' && !Array.isArray(input), 'worker-invalid-config');
  const raw = input as Record<string, unknown>;
  const identity = workerIdentity(raw.identity);
  const names = ['version','origin','environment','authorityId','identity','revision','incarnation',
    'expectedEpoch','credentialReference','journalRoot','supervisorRoot','heartbeat','limits','httpDeadlineMs'];
  if (Object.hasOwn(raw, 'enabled')) names.push('enabled');
  if (identity.workerClass === 'general') names.push('general');
  exact(raw, names);
  need(raw.version === 1 && (raw.enabled === undefined || typeof raw.enabled === 'boolean'), 'worker-invalid-version-or-gate');
  need(typeof raw.origin === 'string', 'worker-invalid-origin');
  const url = new URL(raw.origin);
  need(url.protocol === 'https:' && url.origin === raw.origin && !url.username && !url.password, 'worker-invalid-origin');
  id(raw.environment); id(raw.authorityId); uint(raw.expectedEpoch, 1); uint(raw.revision, 1); uint(raw.incarnation);
  need(typeof raw.credentialReference === 'string' && /^[A-Z][A-Z0-9_]{0,95}(?![\s\S])/.test(raw.credentialReference), 'worker-invalid-credential-reference');
  path(raw.journalRoot); path(raw.supervisorRoot);
  need(raw.journalRoot !== raw.supervisorRoot && !raw.journalRoot.startsWith(raw.supervisorRoot + '/') &&
    !raw.supervisorRoot.startsWith(raw.journalRoot + '/'), 'worker-state-roots-overlap');
  exact(raw.heartbeat, ['refreshMs','minIntervalMs','freshnessMs']);
  const h = raw.heartbeat;
  uint(h.minIntervalMs, 1, 300000); uint(h.freshnessMs, 2, 300000); uint(h.refreshMs, h.minIntervalMs, h.freshnessMs - 1);
  exact(raw.limits, ['maxSteps','maxRetries','maxRuntimeMs','minBackoffMs','maxBackoffMs']);
  const l = raw.limits;
  uint(l.maxSteps, 1, 1024); uint(l.maxRetries, 0, 32); uint(l.maxRuntimeMs, 1000, 86400000);
  uint(l.minBackoffMs, h.minIntervalMs, 300000); uint(l.maxBackoffMs, l.minBackoffMs, 300000);
  uint(raw.httpDeadlineMs, 100, 10000);
  let general: WorkerConfig['general'];
  if (identity.workerClass === 'general') {
    exact(raw.general, ['profile','imageAllowlist','cli','stagingRoot','ttlMs']);
    const g = raw.general;
    need(Array.isArray(g.imageAllowlist) && g.imageAllowlist.length > 0 && g.imageAllowlist.length <= 128 &&
      g.imageAllowlist.every((image: unknown) => typeof image === 'string' && /^[a-z0-9][a-z0-9./_-]{0,200}@sha256:[a-f0-9]{64}(?![\s\S])/.test(image)) &&
      new Set(g.imageAllowlist).size === g.imageAllowlist.length, 'worker-invalid-image-allowlist');
    const profile = validateProfile(g.profile as ProfileConfig, g.imageAllowlist);
    need(profile.cpu === 1 && (profile.ramMib === 64 || profile.ramMib === 128) &&
      profile.cpu <= identity.cpu && profile.ramMib <= identity.ramMib, 'worker-pilot-profile-geometry');
    const runway = pilotRunwayBudget(profile, raw.httpDeadlineMs as number);
    uint(g.ttlMs, 1000, 60000); need(g.ttlMs > runway.totalMs && l.maxRuntimeMs > runway.totalMs, 'worker-insufficient-lease-runway');
    exact(g.cli, ['executable','socketPath','privateConfigPath','allowActivation']);
    path(g.cli.executable); path(g.cli.socketPath); path(g.cli.privateConfigPath); path(g.stagingRoot);
    need(typeof g.cli.allowActivation === 'boolean', 'worker-invalid-runtime-gate');
    const roots = [raw.journalRoot, raw.supervisorRoot, g.stagingRoot, g.cli.privateConfigPath];
    need(roots.every((a,i) => roots.every((b,j) => i === j || (a !== b && !a.startsWith(b + '/')))), 'worker-private-roots-overlap');
    general = {profile, imageAllowlist:[...g.imageAllowlist], cli:{...g.cli} as NodeCliConfig,
      stagingRoot:g.stagingRoot, ttlMs:g.ttlMs};
  }
  return freeze({version:1, enabled:raw.enabled === true, origin:raw.origin, environment:raw.environment,
    authorityId:raw.authorityId, identity, revision:raw.revision, incarnation:raw.incarnation,
    expectedEpoch:raw.expectedEpoch, credentialReference:raw.credentialReference,
    journalRoot:raw.journalRoot, supervisorRoot:raw.supervisorRoot,
    heartbeat:{...h}, limits:{...l}, httpDeadlineMs:raw.httpDeadlineMs, ...(general ? {general} : {})} as WorkerConfig);
}

/** Existing private JSON only; even disabled config must be structurally honest. */
export async function loadWorkerConfig(file: string): Promise<WorkerConfig> {
  return parseWorkerConfig(await readJsonFile(file));
}

import {isAbsolute, normalize, parse} from 'node:path';
import {freeze, canonical} from '../../packages/library-jobs/src/data';
import {exact, id, need, readJsonFile, uint} from './private-state';

export interface VerifierConfig {
  version: 1;
  enabled: boolean;
  origin: string;
  environment: string;
  authorityId: string;
  expectedEpoch: number;
  verifierPrincipal: string;
  ownerCredentialReference: string;
  verifierCredentialReference: string;
  journalRoot: string;
  /** Exact-ID discovery scope; one ID per observation step in canonical order.
   * Pending journal replay precedes discovery. maxSteps may cover only part of this set.
   */
  allowedWorkloadIds: string[];
  httpDeadlineMs: number;
  limits: {maxSteps:number; maxRetries:number; minBackoffMs:number; maxBackoffMs:number; maxRuntimeMs:number};
}

/** Pure parser; references name environment variables, never token values or secret files. */
export function parseVerifierConfig(input: unknown): VerifierConfig {
  need(input !== null && typeof input === 'object' && !Array.isArray(input), 'verifier-config');
  const raw = input as Record<string, unknown>;
  const names = ['version','origin','environment','authorityId','expectedEpoch','verifierPrincipal',
    'ownerCredentialReference','verifierCredentialReference','journalRoot','allowedWorkloadIds','httpDeadlineMs','limits'];
  if (Object.hasOwn(raw, 'enabled')) names.push('enabled');
  exact(raw, names);
  need(raw.version === 1 && (raw.enabled === undefined || typeof raw.enabled === 'boolean'), 'verifier-config');
  need(typeof raw.origin === 'string', 'verifier-origin');
  const url = new URL(raw.origin);
  need(url.protocol === 'https:' && url.origin === raw.origin && !url.username && !url.password, 'verifier-origin');
  id(raw.environment); id(raw.authorityId); id(raw.verifierPrincipal); uint(raw.expectedEpoch, 1);
  for (const ref of [raw.ownerCredentialReference, raw.verifierCredentialReference]) {
    need(typeof ref === 'string' && /^[A-Z][A-Z0-9_]{0,95}(?![\s\S])/.test(ref), 'verifier-credential-reference');
  }
  need(raw.ownerCredentialReference !== raw.verifierCredentialReference, 'verifier-distinct-credentials');
  need(typeof raw.journalRoot === 'string' && isAbsolute(raw.journalRoot) &&
    normalize(raw.journalRoot) === raw.journalRoot && raw.journalRoot !== parse(raw.journalRoot).root &&
    !raw.journalRoot.includes('\0') && !raw.journalRoot.endsWith('/'), 'verifier-journal-root');
  need(Array.isArray(raw.allowedWorkloadIds) && raw.allowedWorkloadIds.length >= 1 &&
    raw.allowedWorkloadIds.length <= 32, 'verifier-workload-scope');
  for (const workload of raw.allowedWorkloadIds) id(workload);
  need(new Set(raw.allowedWorkloadIds).size === raw.allowedWorkloadIds.length, 'verifier-workload-scope');
  uint(raw.httpDeadlineMs, 100, 10000);
  exact(raw.limits, ['maxSteps','maxRetries','minBackoffMs','maxBackoffMs','maxRuntimeMs']);
  const l = raw.limits;
  uint(l.maxSteps, 1, 1024); uint(l.maxRetries, 0, 32);
  uint(l.minBackoffMs, 100, 300000); uint(l.maxBackoffMs, l.minBackoffMs, 300000);
  uint(l.maxRuntimeMs, 1000, 86400000);
  // Copy before freezing, including programmatic callers. Order of the exact allowlist is immaterial.
  return freeze(JSON.parse(canonical({...raw, enabled:raw.enabled === true,
    allowedWorkloadIds:[...raw.allowedWorkloadIds].sort()})) as VerifierConfig);
}

/** Private existing file only; no environment loading, directory creation or credential provisioning. */
export async function loadVerifierConfig(file: string): Promise<VerifierConfig> {
  return parseVerifierConfig(await readJsonFile(file));
}

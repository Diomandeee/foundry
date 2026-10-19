import { createHash } from 'node:crypto';
import type { InboxEvent } from '../../epoch-inbox/src/index';
import type { Command } from '../../compute-authority/src/durable/contracts';
import { canonical } from './canonical';

export const EVENT_SUMMARY_TEMPLATE = 'epoch-event-summary-v1' as const;
export const EVENT_PROFILE = 'hiro-nakamoto-contract-log/v1' as const;
export interface EventScope { environment: string; authorityId: string; sourceId: string; network: 'stacks-mainnet' | 'stacks-testnet' }
export interface JobScope extends EventScope { /** Exact trusted chain intent ID; no local ID derivation. */ workloadId: string }
export interface EventJobPolicy extends EventScope {
  profile: typeof EVENT_PROFILE;
  allowedContracts: string[];
  ramMib: 64 | 128;
  maxOutputBytes: number;
}
export type ComputeSubmitBody = Extract<Command, { operation: 'submit' }>['body'];
export interface PreparedEventSummary { policyHash: string; expectedOutputHash: string; expectedOutputBytes: Uint8Array }
export interface EventJobPlan extends PreparedEventSummary { submitBody: ComputeSubmitBody }
type Obj = Record<string, any>;
const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s).length;
const hash = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function fields(v: unknown, names: string[]): asserts v is Obj {
  check(v !== null && typeof v === 'object' && !Array.isArray(v), 'expected object');
  check(Object.keys(v).length === names.length && names.every(n => Object.hasOwn(v, n)), 'unknown or missing fields');
}
function id(v: unknown) { check(typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/.test(v), 'invalid scope identifier'); }
function sha(v: unknown) { check(typeof v === 'string' && /^[0-9a-f]{64}$/.test(v), 'invalid hash'); }
function uint(v: unknown, max = Number.MAX_SAFE_INTEGER) { check(typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && !Object.is(v, -0) && v <= max, 'invalid integer'); }
function contract(v: unknown, network: string) {
  check(typeof v === 'string' && /^S[PMTN][0-9A-HJKMNP-TV-Z]{26,39}\.[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(v), 'invalid contract');
  check(network === 'stacks-mainnet' ? /^S[PM]/.test(v) : /^S[TN]/.test(v), 'contract network mismatch');
}
function scopeCheck(s: unknown, job = false): asserts s is Obj {
  fields(s, ['environment', 'authorityId', 'sourceId', 'network', ...(job ? ['workloadId'] : [])]);
  for (const k of ['environment', 'authorityId', 'sourceId']) id(s[k]);
  check(s.network === 'stacks-mainnet' || s.network === 'stacks-testnet', 'unsupported network');
  if (job) check(typeof s.workloadId === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(s.workloadId), 'invalid workloadId');
}
function policyCheck(p: unknown, s: Obj): asserts p is Obj {
  fields(p, ['environment', 'authorityId', 'sourceId', 'network', 'profile', 'allowedContracts', 'ramMib', 'maxOutputBytes']);
  for (const k of ['environment', 'authorityId', 'sourceId', 'network']) check(p[k] === s[k], 'policy scope mismatch');
  check(p.profile === EVENT_PROFILE, 'unsupported profile');
  check(p.ramMib === 64 || p.ramMib === 128, 'invalid memory');
  uint(p.maxOutputBytes, 4096); check(p.maxOutputBytes > 0, 'invalid output limit');
  check(Array.isArray(p.allowedContracts) && p.allowedContracts.length > 0 && p.allowedContracts.length <= 128, 'invalid contract allowlist');
  p.allowedContracts.forEach((c: unknown) => contract(c, s.network));
  check(new Set(p.allowedContracts).size === p.allowedContracts.length, 'duplicate contracts');
}
function eventCheck(e: unknown, s: Obj, eventId: unknown, p: Obj): asserts e is Obj {
  fields(e, ['network', 'blockHeight', 'blockHash', 'parentHash', 'transactionId', 'eventIndex', 'payload']);
  check(e.network === s.network, 'event network mismatch'); uint(e.blockHeight); uint(e.eventIndex, 127);
  for (const k of ['blockHash', 'parentHash', 'transactionId']) sha(e[k]);
  check(typeof eventId === 'string' && bytes(eventId) <= 1024 && eventId === canonical([s.sourceId, e.network, e.blockHash, e.transactionId, e.eventIndex]), 'event identity mismatch');
  const q = e.payload; fields(q, ['schema', 'contractId', 'topic', 'value', 'block']);
  check(bytes(canonical(q)) <= 16384, 'payload byte limit');
  check(q.schema === p.profile && q.topic === 'print', 'payload profile mismatch');
  contract(q.contractId, s.network); check(p.allowedContracts.includes(q.contractId), 'contract not allowlisted');
  fields(q.value, ['hex', 'repr']);
  check(typeof q.value.hex === 'string' && q.value.hex.length <= 8194 && /^0x(?:[0-9a-f]{2})+$/.test(q.value.hex), 'invalid normalized Clarity hex');
  check(typeof q.value.repr === 'string' && bytes(q.value.repr) <= 4096, 'invalid Clarity repr');
  fields(q.block, ['id', 'hash', 'parentId', 'parentHash', 'height', 'burnHash', 'burnHeight', 'tenureHeight']);
  for (const k of ['id', 'hash', 'parentId', 'parentHash', 'burnHash']) sha(q.block[k]);
  for (const k of ['height', 'burnHeight', 'tenureHeight']) uint(q.block[k]);
  check(q.block.id === e.blockHash && q.block.parentId === e.parentHash && q.block.height === e.blockHeight, 'payload block mismatch');
}
function frozenInput(scope: EventScope, eventId: string, event: InboxEvent, policy: EventJobPolicy): Obj {
  // Snapshot bounded descriptor-validated data before reading fields; no references retained.
  const s = JSON.parse(canonical(scope)), p = JSON.parse(canonical(policy)), e = JSON.parse(canonical(event));
  scopeCheck(s); policyCheck(p, s); p.allowedContracts.sort(); eventCheck(e, s, eventId, p);
  return { scope: s, eventId, policy: p, event: {
    network: e.network, blockHeight: e.blockHeight, blockHash: e.blockHash, parentHash: e.parentHash,
    transactionId: e.transactionId, eventIndex: e.eventIndex, contractId: e.payload.contractId,
    eventHash: hash(canonical(e)), payloadHash: hash(canonical(e.payload)),
    hexHash: hash(e.payload.value.hex), reprHash: hash(e.payload.value.repr),
    hexBytes: (e.payload.value.hex.length - 2) / 2, reprBytes: bytes(e.payload.value.repr),
  } };
}
function validateFrozen(i: unknown): asserts i is Obj {
  fields(i, ['scope', 'eventId', 'policy', 'event']); scopeCheck(i.scope); policyCheck(i.policy, i.scope);
  check(canonical(i.policy.allowedContracts) === canonical([...i.policy.allowedContracts].sort()), 'noncanonical allowlist');
  const e = i.event;
  fields(e, ['network', 'blockHeight', 'blockHash', 'parentHash', 'transactionId', 'eventIndex', 'contractId', 'eventHash', 'payloadHash', 'hexHash', 'reprHash', 'hexBytes', 'reprBytes']);
  check(e.network === i.scope.network, 'frozen network mismatch');
  uint(e.blockHeight); uint(e.eventIndex, 127); uint(e.hexBytes, 4096); check(e.hexBytes > 0, 'empty value'); uint(e.reprBytes, 4096);
  for (const k of ['blockHash', 'parentHash', 'transactionId', 'eventHash', 'payloadHash', 'hexHash', 'reprHash']) sha(e[k]);
  contract(e.contractId, e.network); check(i.policy.allowedContracts.includes(e.contractId), 'contract not allowlisted');
  check(typeof i.eventId === 'string' && bytes(i.eventId) <= 1024 && i.eventId === canonical([i.scope.sourceId, e.network, e.blockHash, e.transactionId, e.eventIndex]), 'frozen identity mismatch');
}
function render(i: Obj): Uint8Array {
  validateFrozen(i);
  // Only hashes and byte counts are public output; no identifiers or raw Clarity content.
  const output = encoder.encode(canonical({ template: EVENT_SUMMARY_TEMPLATE, eventHash: i.event.eventHash,
    payloadHash: i.event.payloadHash, hexHash: i.event.hexHash, reprHash: i.event.reprHash,
    hexBytes: i.event.hexBytes, reprBytes: i.event.reprBytes, policyHash: hash(canonical(i.policy)) }));
  check(output.length <= i.policy.maxOutputBytes, 'summary exceeds policy'); return output;
}
export function prepareEventSummary(scope: EventScope, eventId: string, event: InboxEvent, policy: EventJobPolicy): PreparedEventSummary {
  const input = frozenInput(scope, eventId, event, policy), expectedOutputBytes = render(input);
  return { policyHash: hash(canonical(input.policy)), expectedOutputHash: hash(expectedOutputBytes), expectedOutputBytes };
}
export function planEventJob(scope: JobScope, eventId: string, event: InboxEvent, eligibilityGeneration: number, policy: EventJobPolicy): EventJobPlan {
  const s = JSON.parse(canonical(scope)); scopeCheck(s, true); uint(eligibilityGeneration); check(eligibilityGeneration > 0, 'generation must be positive');
  const { workloadId, ...base } = s;
  const input = frozenInput(base as EventScope, eventId, event, policy), expectedOutputBytes = render(input);
  const frozen = { template: EVENT_SUMMARY_TEMPLATE, workloadId, eligibilityGeneration, input, inputHash: hash(canonical(input)) };
  const specification = canonical({ ...frozen, specificationHash: hash(canonical(frozen)) });
  check(bytes(specification) <= 16384, 'specification byte limit');
  const expectedOutputHash = hash(expectedOutputBytes);
  return { policyHash: hash(canonical(input.policy)), expectedOutputHash, expectedOutputBytes, submitBody: {
    workloadId, specification, resources: { cpu: 1, ramMib: input.policy.ramMib },
    policy: { sha256: expectedOutputHash, maxBytes: input.policy.maxOutputBytes, exitCode: 0 },
    pure: true, reconstructible: true, maxAttempts: 3,
  } };
}
/** Fixed in-process handler only; no executor, sandbox, dispatch or authenticity claim. */
export function executeEventSummary(specification: string): Uint8Array {
  check(typeof specification === 'string' && bytes(specification) <= 16384, 'specification byte limit');
  const spec = JSON.parse(specification); check(canonical(spec) === specification, 'noncanonical specification');
  fields(spec, ['template', 'workloadId', 'eligibilityGeneration', 'input', 'inputHash', 'specificationHash']);
  const { specificationHash, ...frozen } = spec;
  sha(specificationHash); check(hash(canonical(frozen)) === specificationHash, 'specification hash mismatch');
  check(spec.template === EVENT_SUMMARY_TEMPLATE, 'unknown template');
  check(typeof spec.workloadId === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(spec.workloadId), 'invalid workloadId');
  uint(spec.eligibilityGeneration); check(spec.eligibilityGeneration > 0, 'invalid generation');
  sha(spec.inputHash); check(hash(canonical(spec.input)) === spec.inputHash, 'input hash mismatch');
  return render(spec.input);
}

/** Shared admission predicate: the frozen specification must belong to the surrounding workload. */
export function executeEventSummaryForWorkload(specification: string, workloadId: string): Uint8Array {
  const output = executeEventSummary(specification);
  const spec = JSON.parse(specification) as { workloadId?: unknown };
  check(spec.workloadId === workloadId, 'workload-mismatch');
  return output;
}

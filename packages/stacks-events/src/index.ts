import type { InboxEvent } from '../../epoch-inbox/src/index';

export interface DecodedNakamotoBlock {
  id: string; hash: string; parentId: string; parentHash: string; height: number;
  burnHash: string; burnHeight: number; tenureHeight: number; providerCanonical: boolean;
}
export interface ContractLogPolicy {
  network: 'stacks-mainnet' | 'stacks-testnet'; allowedContracts: string[];
}
export class StacksDecodeError extends Error {
  readonly code = 'invalid_stacks_observation';
  constructor(message: string) { super(message); this.name = 'StacksDecodeError'; }
}
function check(value: unknown, message: string): asserts value {
  if (!value) throw new StacksDecodeError(message);
}
const utf8 = new TextEncoder();
const bytes = (s: string) => utf8.encode(s).byteLength;
type Obj = Record<string, unknown>;

// Snapshot own data descriptors before any schema reads or JSON serialization.
// Reject active values; never call input toJSON, iterator, or accessors.
function snapshot(raw: unknown): unknown {
  let nodes = 0;
  let budget = 65536;
  const ancestors = new Set<object>();
  const debit = (n: number) => { budget -= n; check(budget >= 0, 'raw input exceeds 64KiB'); };
  function visit(value: unknown, depth: number): unknown {
    check(++nodes <= 8192 && depth <= 32, 'raw input complexity');
    if (value === null || typeof value === 'boolean') { debit(value === null ? 4 : value ? 4 : 5); return value; }
    if (typeof value === 'number') {
      check(Number.isFinite(value), 'nonfinite input'); debit(String(value).length); return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value === 'string') {
      check(value.length <= 65536, 'raw string too large'); debit(bytes(JSON.stringify(value))); return value;
    }
    check(typeof value === 'object' && value !== null, 'non-JSON input');
    check(!ancestors.has(value), 'cyclic input');
    const array = Array.isArray(value);
    const proto = Object.getPrototypeOf(value);
    check(array ? proto === Array.prototype : proto === Object.prototype || proto === null, 'exotic prototype');
    const keys = Reflect.ownKeys(value);
    check(keys.length <= 8193, 'too many properties');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of keys) {
      check(typeof key === 'string' && !['__proto__', 'constructor', 'prototype'].includes(key), 'unsafe property');
      const descriptor = descriptors[key];
      check(descriptor && 'value' in descriptor && (descriptor.enumerable || array && key === 'length'), 'accessor or hidden input');
    }
    ancestors.add(value);
    debit(2);
    let out: unknown;
    if (array) {
      const length = descriptors.length.value as number;
      check(length <= 8192 && keys.length === length + 1, 'sparse or decorated array');
      const list: unknown[] = [];
      for (let i = 0; i < length; i++) {
        check(Object.hasOwn(descriptors, String(i)), 'sparse array');
        if (i) debit(1);
        list.push(visit(descriptors[String(i)].value, depth + 1));
      }
      out = list;
    } else {
      const obj: Obj = Object.create(null);
      let count = 0;
      for (const key of (keys as string[]).sort()) {
        check(key.length <= 65536, 'key too large');
        debit(bytes(JSON.stringify(key)) + 1 + (count++ ? 1 : 0));
        obj[key] = visit(descriptors[key].value, depth + 1);
      }
      out = obj;
    }
    ancestors.delete(value);
    return out;
  }
  return visit(raw, 0);
}
function object(v: unknown): Obj {
  check(v !== null && typeof v === 'object' && !Array.isArray(v), 'expected object'); return v as Obj;
}
function integer(v: unknown, max = Number.MAX_SAFE_INTEGER): number {
  check(typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max, 'invalid integer'); return v;
}
function boolean(v: unknown): boolean { check(typeof v === 'boolean', 'expected boolean'); return v; }
function hash(v: unknown): string {
  check(typeof v === 'string' && /^0x(?:[0-9a-f]{64}|[0-9A-F]{64})$/.test(v), 'invalid external hash');
  return v.slice(2).toLowerCase();
}
function header(raw: unknown): DecodedNakamotoBlock {
  const b = object(raw);
  return { id: hash(b.index_block_hash), hash: hash(b.hash), parentId: hash(b.parent_index_block_hash),
    parentHash: hash(b.parent_block_hash), height: integer(b.height), burnHash: hash(b.burn_block_hash),
    burnHeight: integer(b.burn_block_height), tenureHeight: integer(b.tenure_height), providerCanonical: boolean(b.canonical) };
}
export function decodeNakamotoBlock(raw: unknown): DecodedNakamotoBlock { return header(snapshot(raw)); }

const types = new Set(['smart_contract_log', 'stx_lock', 'stx_asset', 'fungible_token_asset', 'non_fungible_token_asset']);
function contract(v: unknown, network: ContractLogPolicy['network']): string {
  check(typeof v === 'string' && /^S[PMTN][0-9A-HJKMNP-TV-Z]{26,39}\.[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(v), 'invalid contract format');
  check(network === 'stacks-mainnet' ? /^S[PM]/.test(v) : /^S[TN]/.test(v), 'contract network mismatch');
  return v;
}
export function decodeContractLog(raw: { block: unknown; transaction: unknown; eventIndex: number }, policy: ContractLogPolicy): InboxEvent {
  const input = object(snapshot(raw));
  const p = object(snapshot(policy));
  check(p.network === 'stacks-mainnet' || p.network === 'stacks-testnet', 'unsupported network');
  const network = p.network;
  check(Array.isArray(p.allowedContracts) && p.allowedContracts.length <= 128, 'invalid allowlist');
  const allowed = p.allowedContracts.map(v => contract(v, network));
  const b = header(input.block);
  const tx = object(input.transaction);
  check(tx.tx_status === 'success' && tx.is_unanchored === false && tx.microblock_hash === '', 'unsupported transaction profile');
  check(hash(tx.block_hash) === b.hash && hash(tx.parent_block_hash) === b.parentHash && integer(tx.block_height) === b.height, 'transaction block join mismatch');
  const txId = hash(tx.tx_id);
  boolean(tx.canonical);
  boolean(tx.microblock_canonical);
  const count = integer(tx.event_count, 128);
  check(Array.isArray(tx.events) && tx.events.length === count, 'incomplete event list');
  const selectedIndex = integer(input.eventIndex, 127);
  const seen = new Set<number>();
  let selected: Obj | undefined;
  for (const rawEvent of tx.events) {
    const event = object(rawEvent);
    const index = integer(event.event_index, count - 1);
    check(!seen.has(index), 'duplicate event index'); seen.add(index);
    check(hash(event.tx_id) === txId, 'event transaction mismatch');
    check(typeof event.event_type === 'string' && types.has(event.event_type), 'unknown event type');
    if (index === selectedIndex) selected = event;
  }
  check(selected && selected.event_type === 'smart_contract_log', 'selected event is not a contract log');
  const log = object(selected.contract_log);
  const contractId = contract(log.contract_id, network);
  check(allowed.includes(contractId), 'contract not allowlisted');
  check(log.topic === 'print', 'unsupported topic');
  const value = object(log.value);
  check(typeof value.hex === 'string' && value.hex.length <= 8194 && /^0x(?:[0-9a-fA-F]{2})+$/.test(value.hex), 'invalid Clarity hex');
  check(typeof value.repr === 'string' && bytes(value.repr) <= 4096, 'invalid Clarity repr');
  const { providerCanonical: _advisoryFlag, ...immutableBlock } = b;
  const payload = {
    schema: 'hiro-nakamoto-contract-log/v1', contractId, topic: 'print',
    value: { hex: value.hex.toLowerCase(), repr: value.repr },
    block: immutableBlock,
  };
  check(bytes(JSON.stringify(payload)) <= 16384, 'payload exceeds 16KiB');
  return { network, blockHeight: b.height, blockHash: b.id, parentHash: b.parentId,
    transactionId: txId, eventIndex: selectedIndex, payload };
}

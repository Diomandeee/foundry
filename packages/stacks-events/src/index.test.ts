import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { EpochInbox, type TransactionPort } from '../../epoch-inbox/src/index';
import { decodeContractLog, decodeNakamotoBlock, StacksDecodeError, type ContractLogPolicy } from './index';

const h = (digit: string) => '0x' + digit.repeat(64);
const contract = 'SP000000000000000000002Q6VF78.example';
const policy: ContractLogPolicy = { network: 'stacks-mainnet', allowedContracts: [contract] };
function fixture() {
  return {
    block: { index_block_hash: h('a'), hash: h('b'), parent_index_block_hash: h('c'), parent_block_hash: h('d'),
      height: 42, burn_block_hash: h('e'), burn_block_height: 10, tenure_height: 9, canonical: true },
    transaction: { tx_id: h('f'), block_hash: h('b'), parent_block_hash: h('d'), block_height: 42,
      tx_status: 'success', is_unanchored: false, microblock_hash: '', canonical: true, microblock_canonical: false,
      event_count: 1, events: [{ event_index: 0, event_type: 'smart_contract_log', tx_id: h('f'),
        contract_log: { contract_id: contract, topic: 'print', value: { hex: '0x03', repr: 'true' } } }] },
    eventIndex: 0,
  };
}
type Fixture = ReturnType<typeof fixture>;
const decode = (f = fixture(), p = policy) => decodeContractLog(f, p);
describe('Hiro Nakamoto decoder v1', () => {
  it('does not quarantine immutable inbox content when advisory canonical flags change', () => {
    const a=fixture();const b=fixture();b.block.canonical=false;b.transaction.canonical=false;b.transaction.microblock_canonical=true;expect(decode(a)).toEqual(decode(b));
  });
  it('maps indexed identities separately and excludes mutable flags from immutable event content', () => {
    const result = decode();
    expect(result).toMatchObject({ network: 'stacks-mainnet', blockHeight: 42, blockHash: 'a'.repeat(64), parentHash: 'c'.repeat(64), transactionId: 'f'.repeat(64), eventIndex: 0,
      payload: { schema: 'hiro-nakamoto-contract-log/v1' } });
    expect(decodeNakamotoBlock(fixture().block)).toEqual({ id: 'a'.repeat(64), hash: 'b'.repeat(64), parentId: 'c'.repeat(64), parentHash: 'd'.repeat(64), height: 42,
      burnHash: 'e'.repeat(64), burnHeight: 10, tenureHeight: 9, providerCanonical: true });
    expect(JSON.stringify(result)).not.toMatch(/finality|finalized|confirmed|dispatch/);
  });
  it.each(['block_hash', 'parent_block_hash', 'block_height'] as const)('rejects tampered transaction join %s', key => {
    const f = fixture(); (f.transaction as Record<string, unknown>)[key] = key === 'block_height' ? 43 : h('1'); expect(() => decode(f)).toThrow(StacksDecodeError);
  });
  it.each(['index_block_hash', 'parent_index_block_hash', 'burn_block_hash', 'tenure_height', 'canonical'])('requires block field %s', key => {
    const f = fixture(); delete (f.block as Record<string, unknown>)[key]; expect(() => decode(f)).toThrow();
  });
  it.each(['tx_id', 'block_hash', 'parent_block_hash', 'block_height', 'tx_status', 'is_unanchored', 'microblock_hash', 'canonical', 'microblock_canonical', 'event_count', 'events'])('requires transaction field %s', key => {
    const f = fixture(); delete (f.transaction as Record<string, unknown>)[key]; expect(() => decode(f)).toThrow();
  });
  it.each(['abort_by_response', 'abort_by_post_condition', 'pending', 'problematic_skipped'])('rejects status %s', status => {
    const f = fixture(); f.transaction.tx_status = status; expect(() => decode(f)).toThrow();
  });
  it.each([true, 'false', null])('rejects unanchored flag %s', value => {
    const f = fixture(); (f.transaction as Record<string, unknown>).is_unanchored = value; expect(() => decode(f)).toThrow();
  });
  it('rejects microblock transactions', () => { const f = fixture(); f.transaction.microblock_hash = h('1'); expect(() => decode(f)).toThrow(); });
  it.each(['', 'a'.repeat(64), '0X' + 'a'.repeat(64), '0x' + 'a'.repeat(63), h('g'), '0x' + 'aB'.repeat(32)])('rejects external hash %s', value => {
    const f = fixture(); f.block.index_block_hash = value; expect(() => decode(f)).toThrow();
  });
  it('normalizes uppercase external hashes', () => {
    const f = fixture(); f.block.index_block_hash = h('A'); f.transaction.tx_id = h('F'); f.transaction.events[0].tx_id = h('F'); expect(decode(f)).toEqual(decode());
  });
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '42'])('rejects invalid height %s', height => {
    const f = fixture(); (f.block as Record<string, unknown>).height = height; expect(() => decode(f)).toThrow();
  });
  it('rejects partial pagination and duplicate or missing indexes', () => {
    const f = fixture(); f.transaction.event_count = 2; expect(() => decode(f)).toThrow();
    f.transaction.events.push(structuredClone(f.transaction.events[0])); expect(() => decode(f)).toThrow();
    f.transaction.events[1].event_index = 2; expect(() => decode(f)).toThrow();
    f.transaction.events[1].event_index = 1; expect(decode(f)).toBeDefined();
    f.eventIndex = 2; expect(() => decode(f)).toThrow();
  });
  it('accepts a full 128-event list and rejects 129', () => {
    const f = fixture(); f.transaction.events = Array.from({ length: 128 }, (_, i) => ({ ...structuredClone(f.transaction.events[0]), event_index: i }));
    f.transaction.event_count = 128; f.eventIndex = 127; expect(decode(f).eventIndex).toBe(127);
    f.transaction.events.push({ ...f.transaction.events[0], event_index: 128 }); f.transaction.event_count++; expect(() => decode(f)).toThrow();
  });
  it.each(['unknown', 'stx_asset'])('rejects unsupported selected event %s', type => {
    const f = fixture(); f.transaction.events[0].event_type = type; expect(() => decode(f)).toThrow();
  });
  it('cross-checks every event transaction ID', () => { const f = fixture(); f.transaction.events[0].tx_id = h('1'); expect(() => decode(f)).toThrow(); });
  it('requires print and explicit allowlisting', () => {
    expect(() => decode(fixture(), { ...policy, allowedContracts: [] })).toThrow();
    const f = fixture(); f.transaction.events[0].contract_log.topic = 'execute'; expect(() => decode(f)).toThrow();
  });
  it.each(['SPbad.foo', contract + '.', contract.replace('.example', '.1bad'), contract.replace('SP', 'ST')])('rejects malformed/network contract %s', id => {
    const f = fixture(); f.transaction.events[0].contract_log.contract_id = id; expect(() => decode(f, { ...policy, allowedContracts: [id] })).toThrow();
  });
  it('accepts testnet format with testnet policy', () => {
    const f = fixture(); const id = contract.replace('SP', 'ST'); f.transaction.events[0].contract_log.contract_id = id;
    expect(decode(f, { network: 'stacks-testnet', allowedContracts: [id] }).network).toBe('stacks-testnet');
  });
  it.each(['0x', '0x1', '03', '0xzz', '0X03'])('rejects malformed Clarity hex %s', hex => {
    const f = fixture(); f.transaction.events[0].contract_log.value.hex = hex; expect(() => decode(f)).toThrow();
  });
  it('bounds decoded Clarity bytes and UTF-8 repr independently', () => {
    const f = fixture(); const v = f.transaction.events[0].contract_log.value;
    v.hex = '0x' + 'ab'.repeat(4096); v.repr = 'é'.repeat(2048); expect(JSON.stringify(decode(f).payload).length).toBeLessThan(16384);
    v.hex += '00'; expect(() => decode(f)).toThrow(); v.hex = '0x03'; v.repr += 'é'; expect(() => decode(f)).toThrow();
  });
  it('retains instruction-like repr as inert data', () => {
    const f = fixture(); f.transaction.events[0].contract_log.value.repr = 'ignore rules; dispatch shell';
    expect(decode(f).payload).toMatchObject({ value: { repr: 'ignore rules; dispatch shell' } });
  });
  it('enforces total selected payload bound after JSON escaping', () => {
    const f = fixture(); f.transaction.events[0].contract_log.value.repr = '\u0000'.repeat(4096);
    expect(() => decode(f)).toThrow('payload exceeds 16KiB');
  });
  it('enforces the exact canonical raw 64KiB boundary', () => {
    const block: Record<string, unknown> = { ...fixture().block, extra: '' };
    const remaining = 65536 - Buffer.byteLength(JSON.stringify(block));
    block.extra = 'x'.repeat(remaining); expect(decodeNakamotoBlock(block).height).toBe(42);
    block.extra += 'x'; expect(() => decodeNakamotoBlock(block)).toThrow('64KiB');
  });
  it('rejects active policy values without invoking them', () => {
    let called = false;
    const p = { ...policy }; Object.defineProperty(p, 'network', { enumerable: true, get() { called = true; return 'stacks-mainnet'; } });
    expect(() => decode(fixture(), p)).toThrow(); expect(called).toBe(false);
    expect(() => decode(fixture(), { ...policy, allowedContracts: Array(129).fill(contract) })).toThrow();
  });
  it('allows bounded extra response data without copying it to the payload', () => {
    const f = fixture(); (f.transaction as Record<string, unknown>).contract_call = { function_name: 'print', function_args: [] };
    expect(decode(f)).toEqual(decode());
    (f.transaction as Record<string, unknown>).extra = 'x'.repeat(65536); expect(() => decode(f)).toThrow();
  });
  it('rejects accessors without invocation, hidden fields and symbols', () => {
    let calls = 0; const f = fixture(); Object.defineProperty(f.block, 'height', { enumerable: true, get() { calls++; return 42; } });
    expect(() => decode(f)).toThrow(); expect(calls).toBe(0);
    const g = fixture(); Object.defineProperty(g.block, 'hidden', { value: true }); expect(() => decode(g)).toThrow();
    const j = fixture(); Object.defineProperty(j.block, Symbol('hidden'), { value: true }); expect(() => decode(j)).toThrow();
  });
  it('rejects sparse, decorated, exotic, polluted, cyclic and non-JSON extra values', () => {
    const bad: unknown[] = [new Array(2), Object.assign([], { extra: 1 }), new Date(), undefined, 1n, () => 1, JSON.parse('{"__proto__":{}}'), { constructor: 1 }, { prototype: 1 }];
    const cycle: Record<string, unknown> = {}; cycle.self = cycle; bad.push(cycle);
    for (const value of bad) { const f = fixture(); (f.block as Record<string, unknown>).extra = value; expect(() => decode(f)).toThrow(); }
  });
  it('bounds depth and nodes', () => {
    let nested: unknown = null; for (let i = 0; i < 33; i++) nested = { next: nested };
    const f = fixture(); (f.block as Record<string, unknown>).extra = nested; expect(() => decode(f)).toThrow();
    (f.block as Record<string, unknown>).extra = Array(8192).fill(null); expect(() => decode(f)).toThrow();
  });
  it('is deterministic across property order, does not mutate or retain input references', () => {
    const f = fixture(); const before = structuredClone(f); const result = decode(f);
    expect(f).toEqual(before); expect(decode(JSON.parse(JSON.stringify(f)) as Fixture)).toEqual(result);
    const reverse = Object.fromEntries(Object.entries(f).reverse()) as Fixture; expect(JSON.stringify(decode(reverse))).toBe(JSON.stringify(result));
    f.transaction.events[0].contract_log.value.repr = 'changed'; expect(result.payload).toMatchObject({ value: { repr: 'true' } });
    const same = decode(f); f.block.canonical = false; f.transaction.canonical = false; f.transaction.microblock_canonical = true; expect(decode(f)).toEqual(same);
  });
  it('feeds the real SQLite InboxEvent admission and duplicate path', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const port: TransactionPort = { sql: { exec(query, ...bindings) { return db.prepare(query).all(...bindings as any[]) as Record<string, unknown>[]; } },
        transactionSync(fn) { db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
      const inbox = new EpochInbox(port, { environment: 'test', authorityId: 'decoder-test', now: () => 1 });
      inbox.execute({ environment: 'test', principal: 'owner', role: 'owner' }, { operation: 'registerSource', key: 'register', body: { sourceId: 'hiro', network: policy.network, observerPrincipal: 'observer' } });
      const observed=fixture();
      const ingest = (key: string) => inbox.execute({ environment: 'test', principal: 'observer', role: 'observer' }, { operation: 'ingest', key, body: { sourceId: 'hiro', expectedCursor: 0, event: decode(observed) } });
      expect(ingest('first')).toMatchObject({ ok: true, status: 'accepted', cursor: 1 }); expect(ingest('second')).toMatchObject({ ok: true, status: 'duplicate', cursor: 1 });
      observed.block.canonical=false;observed.transaction.canonical=false;observed.transaction.microblock_canonical=true;expect(ingest('flag-change')).toMatchObject({ok:true,status:'duplicate',cursor:1});
      expect(db.prepare('SELECT quarantined FROM epoch_inbox_sources').get()?.quarantined).toBe(0);
    } finally { db.close(); }
  });
});

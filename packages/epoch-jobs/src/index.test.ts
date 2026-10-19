import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect } from 'vitest';
import { DurableAuthority, type CommandEnvelope, type TransactionPort } from '../../compute-authority/src/durable/authority';
import type { InboxEvent } from '../../epoch-inbox/src/index';
import { decodeContractLog } from '../../stacks-events/src/index';
import { canonical } from './canonical';
import { planEventJob, prepareEventSummary, executeEventSummary, EVENT_PROFILE, type EventScope, type EventJobPolicy } from './index';

const h = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const contract = 'ST000000000000000000002AMW42H.epoch';
function fixture() {
  const scope: EventScope = { environment: 'local', authorityId: 'chain', sourceId: 'hiro', network: 'stacks-testnet' };
  const policy: EventJobPolicy = { ...scope, profile: EVENT_PROFILE, allowedContracts: [contract], ramMib: 64, maxOutputBytes: 4096 };
  const block = { index_block_hash: '0x'+'a'.repeat(64), hash: '0x'+'b'.repeat(64), parent_index_block_hash: '0x'+'c'.repeat(64), parent_block_hash: '0x'+'d'.repeat(64), height: 12, burn_block_hash: '0x'+'e'.repeat(64), burn_block_height: 5, tenure_height: 3, canonical: true };
  const transaction = { tx_id: '0x'+'f'.repeat(64), block_hash: block.hash, parent_block_hash: block.parent_block_hash, block_height: 12,
    tx_status: 'success', is_unanchored: false, microblock_hash: '', canonical: true, microblock_canonical: true, event_count: 1,
    events: [{ event_index: 0, tx_id: '0x'+'f'.repeat(64), event_type: 'smart_contract_log', contract_log: { contract_id: contract, topic: 'print', value: { hex: '0x0102', repr: 'private content never in output' } } }] };
  const event = decodeContractLog({ block, transaction, eventIndex: 0 }, { network: scope.network, allowedContracts: [contract] });
  const eventId = canonical([scope.sourceId, event.network, event.blockHash, event.transactionId, event.eventIndex]);
  const job = { ...scope, workloadId: 'chain-intent-generation-1' };
  const plan = () => planEventJob(job, eventId, event, 1, policy);
  return { scope, policy, event, eventId, job, plan, block, transaction };
}
function reseal(s: any): string {
  s.inputHash = h(canonical(s.input));
  const { specificationHash: _, ...body } = s;
  s.specificationHash = h(canonical(body)); return canonical(s);
}

describe('fixed epoch summary planner and handler', () => {
  it('decodes real API profile, deterministically replays and preserves caller input', () => {
    const f = fixture(), before = canonical(f.event), a = f.plan(), b = f.plan();
    expect(a).toEqual(b); expect(canonical(f.event)).toBe(before);
    expect(a.submitBody.workloadId).toBe(f.job.workloadId);
    expect(Object.keys(a.submitBody).sort()).toEqual(['maxAttempts','policy','pure','reconstructible','resources','specification','workloadId']);
    expect(a.submitBody).toMatchObject({ resources: { cpu: 1, ramMib: 64 }, pure: true, reconstructible: true, maxAttempts: 3 });
    const out = executeEventSummary(a.submitBody.specification);
    expect(out).toEqual(a.expectedOutputBytes); expect(h(out)).toBe(a.submitBody.policy.sha256);
    expect(out.length).toBeLessThanOrEqual(a.submitBody.policy.maxBytes);
    expect(Buffer.byteLength(a.submitBody.specification)).toBeLessThanOrEqual(16384);
    expect(a.submitBody.specification).not.toContain('private content');
    expect(Buffer.from(out).toString()).not.toContain(contract);
  });
  it('freezes output before eligibility and reuses it across new generations/IDs', () => {
    const f = fixture(), early = prepareEventSummary(f.scope, f.eventId, f.event, f.policy), a = f.plan();
    const b = planEventJob({ ...f.scope, workloadId: 'chain-intent-generation-2' }, f.eventId, f.event, 2, f.policy);
    expect(a.expectedOutputHash).toBe(early.expectedOutputHash); expect(b.expectedOutputBytes).toEqual(early.expectedOutputBytes);
    expect(a.submitBody.specification).not.toBe(b.submitBody.specification);
    expect(executeEventSummary(b.submitBody.specification)).toEqual(early.expectedOutputBytes);
    expect(b.submitBody.workloadId).not.toBe(a.submitBody.workloadId);
  });
  it('snapshots caller data and never returns planner expected bytes from a cache', () => {
    const f = fixture(), p = f.plan(); p.expectedOutputBytes.fill(0);
    (f.event.payload as any).value.repr = 'changed'; f.policy.allowedContracts.length = 0;
    const actual = executeEventSummary(p.submitBody.specification);
    expect(h(actual)).toBe(p.expectedOutputHash); expect(actual).not.toEqual(p.expectedOutputBytes);
    actual.fill(1); expect(h(executeEventSummary(p.submitBody.specification))).toBe(p.expectedOutputHash);
  });
  it('normalizes allowlist order and object insertion order', () => {
    const f = fixture(); f.policy.allowedContracts.push(contract+'2'); const a = f.plan();
    f.policy.allowedContracts.reverse();
    expect(f.plan()).toEqual(a);
    const event = Object.fromEntries(Object.entries(f.event).reverse()) as unknown as InboxEvent;
    expect(planEventJob(f.job, f.eventId, event, 1, f.policy)).toEqual(a);
  });
  it('changes the frozen result for changed immutable content or approved policy', () => {
    const f = fixture(), a = f.plan();
    (f.event.payload as any).value.repr = 'different content'; const b = f.plan();
    expect(b.expectedOutputHash).not.toBe(a.expectedOutputHash);
    expect(b.policyHash).toBe(a.policyHash);
    f.policy.ramMib = 128; const c = f.plan();
    expect(c.policyHash).not.toBe(b.policyHash); expect(c.expectedOutputHash).not.toBe(b.expectedOutputHash);
  });
  it('keeps decoder event identity, content digest and exact job unchanged across advisory flag changes', () => {
    const f = fixture(), before = f.plan();
    f.block.canonical = false; f.transaction.canonical = false; f.transaction.microblock_canonical = false;
    const changed = decodeContractLog({ block:f.block, transaction:f.transaction, eventIndex:0 }, { network:f.scope.network, allowedContracts:[contract] });
    expect(changed).toEqual(f.event);
    expect(planEventJob(f.job, f.eventId, changed, 1, f.policy)).toEqual(before);
    const payload = changed.payload as any;
    expect(payload).not.toHaveProperty('provider'); expect(payload.block).not.toHaveProperty('providerCanonical');
  });
  it('supports the bounded maximum value without carrying its raw bytes into spec', () => {
    const f = fixture(); (f.event.payload as any).value = { hex: '0x'+'ab'.repeat(4096), repr: 'é'.repeat(2048) };
    f.policy.ramMib = 128; const p = f.plan();
    expect(p.submitBody.resources.ramMib).toBe(128); expect(Buffer.byteLength(p.submitBody.specification)).toBeLessThan(16384);
    const out = JSON.parse(Buffer.from(executeEventSummary(p.submitBody.specification)).toString());
    expect(out.hexBytes).toBe(4096); expect(out.reprBytes).toBe(4096);
  });
  const invalid: [string, (f: ReturnType<typeof fixture>) => void][] = [
    ['wrong environment', f => { f.policy.environment = 'other'; }],
    ['wrong authority', f => { f.policy.authorityId = 'other'; }],
    ['wrong source', f => { f.policy.sourceId = 'other'; }],
    ['wrong network', f => { f.event.network = 'stacks-mainnet'; }],
    ['wrong policy network', f => { f.policy.network = 'stacks-mainnet'; }],
    ['unknown network', f => { (f.job as any).network = 'devnet'; }],
    ['unallowlisted contract', f => { f.policy.allowedContracts = [contract+'2']; }],
    ['cross-network contract', f => { (f.event.payload as any).contractId = contract.replace('ST', 'SP'); }],
    ['profile', f => { (f.event.payload as any).schema = 'custom-script'; }],
    ['host profile', f => { (f.policy as any).profile = 'custom'; }],
    ['event unknown field', f => { (f.event as any).finalized = true; }],
    ['payload unknown field', f => { (f.event.payload as any).url = 'https://example.invalid'; }],
    ['scope unknown field', f => { (f.job as any).secret = 'x'; }],
    ['policy unknown field', f => { (f.policy as any).egress = true; }],
    ['nested unknown field', f => { (f.event.payload as any).value.extra = true; }],
    ['negative height', f => { f.event.blockHeight = -1; }],
    ['fraction', f => { f.event.eventIndex = 0.5; }],
    ['NaN', f => { f.event.blockHeight = NaN; }],
    ['infinity', f => { f.event.blockHeight = Infinity; }],
    ['unsafe integer', f => { f.event.blockHeight = Number.MAX_SAFE_INTEGER + 1; }],
    ['negative zero', f => { f.event.eventIndex = -0; }],
    ['invalid hash', f => { f.event.blockHash = 'a'; }],
    ['wrong block join', f => { (f.event.payload as any).block.height++; }],
    ['wrong indexed parent', f => { (f.event.payload as any).block.parentId = '1'.repeat(64); }],
    ['legacy provider flags', f => { (f.event.payload as any).provider = { canonical:true, microblockCanonical:true }; }],
    ['legacy block provider flag', f => { (f.event.payload as any).block.providerCanonical = true; }],
    ['repr too large', f => { (f.event.payload as any).value.repr = 'é'.repeat(2049); }],
    ['hex too large', f => { (f.event.payload as any).value.hex = '0x'+'aa'.repeat(4097); }],
    ['odd hex', f => { (f.event.payload as any).value.hex = '0xa'; }],
    ['allowlist empty', f => { f.policy.allowedContracts = []; }],
    ['allowlist duplicate', f => { f.policy.allowedContracts.push(contract); }],
    ['ram', f => { (f.policy as any).ramMib = 1024; }],
    ['output too large', f => { f.policy.maxOutputBytes = 4097; }],
    ['output too small', f => { f.policy.maxOutputBytes = 1; }],
    ['output zero', f => { f.policy.maxOutputBytes = 0; }],
    ['workload long', f => { f.job.workloadId = 'a'.repeat(65); }],
    ['workload invalid compute grammar', f => { f.job.workloadId = 'a/b'; }],
    ['workload non ASCII', f => { f.job.workloadId = 'é'; }],
  ];
  it.each(invalid)('rejects %s', (_, mutate) => { const f = fixture(); mutate(f); expect(f.plan).toThrow(); });
  it('rejects a host event ID that differs from immutable inbox identity', () => {
    const f = fixture(); expect(() => planEventJob(f.job, f.eventId+' ', f.event, 1, f.policy)).toThrow();
  });
  it.each([0, -1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER+1])('rejects generation %s', generation => {
    const f = fixture(); expect(() => planEventJob(f.job, f.eventId, f.event, generation, f.policy)).toThrow();
  });
  it('rejects active, hidden, symbolic, exotic, cyclic and overcomplex inputs without invoking getters', () => {
    const f = fixture(); let invoked = false;
    Object.defineProperty(f.event, 'payload', { get() { invoked = true; throw new Error('getter'); } });
    expect(f.plan).toThrow(); expect(invoked).toBe(false);
    for (const bad of [new Date(), { a: undefined }, { a: BigInt(1) }, new Array(2), Object.assign([], { x: 1 }), Object.defineProperty({}, 'x', { value: 1 }), { [Symbol('x')]: 1 }]) expect(() => canonical(bad)).toThrow();
    const cycle: any = {}; cycle.x = cycle; expect(() => canonical(cycle)).toThrow();
    let deep: any = {}; for (let i = 0; i < 34; i++) deep = { deep }; expect(() => canonical(deep)).toThrow();
    expect(() => canonical(Array(8193).fill(0))).toThrow(); expect(() => canonical('x'.repeat(65537))).toThrow();
    expect(() => canonical(JSON.parse('{"__proto__":1}'))).toThrow();
  });
  it.each(['template','workloadId','eligibilityGeneration','input','inputHash','specificationHash','unknown'])('rejects mutated specification %s', key => {
    const s = JSON.parse(fixture().plan().submitBody.specification);
    if (key === 'input') s.input.event.reprBytes++;
    else s[key] = key === 'eligibilityGeneration' ? 2 : 'mutated';
    expect(() => executeEventSummary(canonical(s))).toThrow();
  });
  it('validates frozen fields even after checksums are recomputed', () => {
    const base = fixture().plan().submitBody.specification;
    const mutations = [(s:any) => { s.input.event.reprBytes = -1; }, (s:any) => { s.input.policy.network = 'stacks-mainnet'; },
      (s:any) => { s.input.event.contractId += '2'; }, (s:any) => { s.input.event.extra = 1; }, (s:any) => { s.input.scope.sourceId = 'other'; },
      (s:any) => { s.input.policy.profile = 'script'; }, (s:any) => { s.input.policy.maxOutputBytes = 4097; }];
    for (const mutate of mutations) { const s = JSON.parse(base); mutate(s); expect(() => executeEventSummary(reseal(s))).toThrow(); }
  });
  it('rejects malformed, duplicate-key, noncanonical and overlimit specs', () => {
    const s = fixture().plan().submitBody.specification;
    for (const bad of ['', '{}', ' '+s, s.replace('{', '{"template":"evil",'), 'x'.repeat(16385)]) expect(() => executeEventSummary(bad)).toThrow();
  });
});

describe('actual compute submit and byte policy journey (Node SQLite only)', () => {
  it.each(['valid', 'corrupt-bytes', 'wrong-policy-hash'])('submits plan, independently verifies actual bytes: %s', async mode => {
    const f = fixture(), p = f.plan(); let artifact = executeEventSummary(p.submitBody.specification);
    const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
    const port: TransactionPort = { sql: { exec(query, ...args) { return db.prepare(query).all(...args as any[]) as Record<string,unknown>[]; } },
      transactionSync(fn) { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
    try {
      const core = new DurableAuthority(port, { environment: 'local', authorityId: 'compute', issuerId: 'test', issuerKey: 'local-test-only-000000000000000000000', now: () => 1000, readArtifact: async () => artifact });
      const owner = { principal: 'owner', role: 'owner' as const, expectedEpoch: 1 };
      let key = 0; const run = (operation:string, body:unknown, role:'owner'|'executor' = 'owner') => core.execute({ ...owner, role }, { operation, body, key: 'k'+(++key) } as CommandEnvelope) as any;
      expect(run('setQuota', { principal:'owner', maxActive:2, allowedClass:'general' }).ok).toBe(true);
      expect(run('registerWorker', { workerId:'w', principal:'owner', workerClass:'general', cpu:1, ramMib:128, devices:[] }).ok).toBe(true);
      const submitBody = mode === 'wrong-policy-hash' ? { ...p.submitBody, policy: { ...p.submitBody.policy, sha256:'0'.repeat(64) } } : p.submitBody;
      expect(run('submit', submitBody).ok).toBe(true);
      const lease = run('claim', { workloadId:p.submitBody.workloadId, workerId:'w', expectedGeneration:0, incarnation:0, ttlMs:100 }, 'executor').lease;
      if (mode === 'corrupt-bytes') { artifact = artifact.slice(); artifact[0] ^= 1; }
      expect(run('stageResult', { leaseId:lease.id, epoch:lease.epoch, generation:lease.generation, incarnation:lease.incarnation, capability:lease.capability, artifactRef:'local-test-artifact', sha256:submitBody.policy.sha256, bytes:artifact.length, exitCode:0 }, 'executor').ok).toBe(true);
      const result = await core.verifyAndFinalize({ ...owner, role:'verifier' }, { key:'verify', leaseId:lease.id, epoch:lease.epoch, generation:lease.generation, incarnation:lease.incarnation });
      expect(result.ok).toBe(mode === 'valid');
      expect(db.prepare('SELECT * FROM receipts').all()).toHaveLength(mode === 'valid' ? 1 : 0);
    } finally { db.close(); }
  });
});

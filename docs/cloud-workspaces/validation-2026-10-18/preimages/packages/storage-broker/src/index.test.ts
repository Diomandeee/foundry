import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { canonical } from '../../library-jobs/src/data';
import { createStorageBroker, grantRevocationBinding, HARD_LIMITS, validateGrant } from './index';
import type { BrokerPorts, Limits, ReadGrant, RevokeGrantCommand } from './types';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const bytes = new TextEncoder().encode('bounded immutable content');
function grant(id = 'grant-1'): ReadGrant {
  return { version: 1, grantId: id, principalRef: 'worker-principal', projectId: 'project-1', policyVersion: 'policy-1', policyHash: 'a'.repeat(64),
    intentId: 'intent-1', authorizationGeneration: 1, operation: 'GET',
    compute: { authorityId: 'compute-1', workloadId: 'work-1', leaseId: 'lease-1', attemptId: 'attempt-1', epoch: 1, generation: 0, incarnation: 0, workerId: 'worker-1', capabilityDigest: 'b'.repeat(64) },
    object: { projectId: 'project-1', objectKey: `projects/project-1/objects/${digest(bytes)}`, generation: '123', sha256: digest(bytes), sizeBytes: bytes.length },
    byteBudget: bytes.length * 4, expiresAt: 100_000 };
}
function command(g = grant(), key = 'revoke-1'): RevokeGrantCommand {
  return { key, grantId: g.grantId, expectedBinding: grantRevocationBinding(g), evidenceId: 'evidence-1', reason: 'lease-revoked' };
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture(limits: Partial<Limits> = {}, filename = ':memory:') {
  const db = new DatabaseSync(filename); cleanup.push(() => { try { db.close(); } catch {} });
  let time = 1_000, reads = 0, observations = 0;
  let observe: (g: ReadGrant) => unknown = g => ({ grant: g, status: 'authorized', revoked: false, observedAt: time, expiresAt: g.expiresAt });
  let read: BrokerPorts['readObject'] = async ref => ({ ref, bytes });
  const ports: BrokerPorts = { db, binding: { environment: 'test', authorityId: 'broker-1' }, limits,
    now: () => time, observeCurrent: g => { observations++; return observe(g); },
    readObject: (...args) => { reads++; return read(...args); } };
  const broker = createStorageBroker(ports);
  return { db, ports, broker, issue: (g = grant()) => broker.admin.issue(g),
    request: (requestId = 'request-1', grantId = 'grant-1') => broker.reader.read('worker-principal',{ grantId,requestId }),
    setTime: (v: number) => { time = v; }, setObserve: (fn: typeof observe) => { observe = fn; }, setRead: (fn: typeof read) => { read = fn; },
    get reads() { return reads; }, get observations() { return observations; } };
}
function file() {
  const root = fileURLToPath(new NodeURL('../.test-state/',import.meta.url)); mkdirSync(root,{ recursive: true });
  const path = mkdtempSync(root + 'case-'); cleanup.push(() => rmSync(path,{ recursive: true })); return path + '/broker.sqlite';
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((a,b) => { resolve = a; reject = b; }); return { promise,resolve,reject }; }
const req = { grantId: 'grant-1',requestId: 'request-1' };

describe('authenticated immutable GET broker using real node:sqlite',() => {
  it('accepts zero compute generation/incarnation, while local authorization generation and epoch start at one',() => {
    expect(validateGrant(grant()).compute.generation).toBe(0);
    for (const change of [{ authorizationGeneration: 0 },{ compute: { ...grant().compute, epoch: 0 } },{ compute: { ...grant().compute, incarnation: -1 } }]) expect(() => validateGrant({ ...grant(),...change })).toThrow();
  });
  it('verifies bytes, seals, and exactly replays lost replies without new execution/consumption',async () => {
    const f = fixture(); f.issue(); const first = await f.request(); first[0] = 0;
    expect(await f.request()).toEqual(bytes); expect(f.reads).toBe(1);
    expect(f.db.prepare('SELECT sum(size) AS n FROM reads').get()!.n).toBe(bytes.length);
    expect(f.observations).toBeGreaterThanOrEqual(6);
  });
  it('persists completed sealed bytes through close/reopen',async () => {
    const path = file(), f = fixture({},path); f.issue(); await f.request(); f.db.close();
    const again = fixture({},path); expect(await again.request()).toEqual(bytes); expect(again.reads).toBe(0);
  });
  it('persists revocation and exact receipts through restart/lost responses',async () => {
    const path = file(), f = fixture({},path); f.issue(); await f.request();
    const receipt = f.broker.admin.revokeGrant(command()); f.db.close();
    const again = fixture({},path); expect(again.broker.admin.revokeGrant(command())).toEqual(receipt);
    await expect(again.request()).rejects.toThrow(/revoked/); expect(again.reads).toBe(0);
  });
  it('twenty concurrent same-key callers share one provider read and one debit',async () => {
    const f = fixture(), wait = deferred<{ ref: ReadGrant['object']; bytes: Uint8Array }>(); f.issue(); f.setRead(() => wait.promise);
    const calls = Array.from({ length: 20 },() => f.request()); expect(f.reads).toBe(1);
    wait.resolve({ ref: grant().object,bytes }); expect(await Promise.all(calls)).toHaveLength(20);
    expect(f.db.prepare('SELECT count(*) AS n FROM reads').get()!.n).toBe(1);
  });
  it('atomically consumes aggregate byte budget before async and never refunds failures',async () => {
    const f = fixture(); f.issue({ ...grant(),byteBudget: bytes.length }); const wait = deferred<any>(); f.setRead(() => wait.promise);
    const first = f.request(); await expect(f.request('other')).rejects.toThrow(/byte budget/);
    wait.reject(new Error('ambiguous transport')); await expect(first).rejects.toThrow(/ambiguous/);
    await expect(f.request()).rejects.toThrow(/unknown/); await expect(f.request('third')).rejects.toThrow(/byte budget/); expect(f.reads).toBe(1);
  });
  it('rechecks revocation during provider read, refuses sealing/replies and preserves debit',async () => {
    const f = fixture(), wait = deferred<any>(); f.issue(); f.setRead(() => wait.promise);
    const calls = Array.from({ length: 20 },() => f.request()); f.broker.admin.revokeGrant(command()); wait.resolve({ ref: grant().object,bytes });
    const outcomes = await Promise.allSettled(calls); expect(outcomes.every(x => x.status === 'rejected')).toBe(true);
    expect(f.db.prepare('SELECT state,bytes FROM reads').get()).toMatchObject({ state: 'unknown',bytes: null });
    await expect(f.request()).rejects.toThrow(/revoked/);
  });
  it('independently fences each waiter immediately before reply',async () => {
    const f = fixture(); f.issue(); let n = 0;
    f.setObserve(g => { n++; return { grant: g,status: 'authorized',revoked: n >= 6,observedAt: 1000,expiresAt: g.expiresAt }; });
    const results = await Promise.allSettled([f.request(),f.request()]); expect(results.map(x => x.status)).toEqual(['fulfilled','rejected']); expect(f.reads).toBe(1);
  });
  it('blocks provider execution after a real process crash with a durable reservation',async () => {
    const path = file(), f = fixture({},path); f.issue(); f.db.close();
    const code = `const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1]); db.exec('PRAGMA foreign_keys=ON'); db.prepare("INSERT INTO reads VALUES(?,?,?,'reserved',NULL)").run('grant-1','request-1',${bytes.length}); process.kill(process.pid,'SIGKILL');`;
    const result = spawnSync(process.execPath,['-e',code,path]); expect(result.signal).toBe('SIGKILL');
    const again = fixture({},path); await expect(again.request()).rejects.toThrow(/unknown/); expect(again.reads).toBe(0);
    expect(again.db.prepare('SELECT state FROM reads').get()!.state).toBe('unknown');
  });
  it('another instance cannot execute an existing reservation, and fences the original completion',async () => {
    const path = file(), first = fixture({},path), wait = deferred<any>(); first.issue(); first.setRead(() => wait.promise);
    const call = first.request(); const second = fixture({},path); await expect(second.request()).rejects.toThrow(/unknown/);
    wait.resolve({ ref: grant().object,bytes }); await expect(call).rejects.toThrow(/unknown/); expect(first.reads + second.reads).toBe(1);
  });
  it('does not expose admin issuance to worker-reader handle',async () => {
    const f = fixture(); expect(Object.keys(f.broker.reader)).toEqual(['read']); f.issue();
    await expect(f.broker.reader.read('forged-principal',req)).rejects.toThrow(/principal/); expect(f.reads).toBe(0);
  });
  it('only allows exact grant identity replay, without new issuer side effects',() => {
    const f = fixture(); f.issue(); const observations = f.observations; expect(f.issue()).toEqual(grant()); expect(f.observations).toBe(observations);
    expect(() => f.issue({ ...grant(),policyVersion: 'new' })).toThrow(/identity conflict/);
  });
  it('preemptive revocation prevents delayed grant issuance',() => {
    const f = fixture(); expect(f.broker.admin.revokeGrant(command()).status).toBe('revoked'); expect(() => f.issue()).toThrow(/revoked/);
  });
  it('exact revocation binding supersedes changed targets and detects command-key reuse',async () => {
    const f = fixture(); f.issue(); const stale = { ...grant(),authorizationGeneration: 2 };
    const cmd = command(stale); expect(f.broker.admin.revokeGrant(cmd).status).toBe('superseded');
    expect(f.broker.admin.revokeGrant(cmd).status).toBe('superseded'); expect(await f.request()).toEqual(bytes);
    expect(() => f.broker.admin.revokeGrant(command())).toThrow(/key conflict/);
    expect(f.broker.admin.revokeGrant(command(grant(),'current')).status).toBe('revoked');
    expect(f.broker.admin.revokeGrant(command(grant(),'again')).status).toBe('already-revoked');
  });
  it('revocation remains available with normal grants/reads and normal revocation history full',async () => {
    const f = fixture({ maxGrants: 2,maxReads: 1,maxRevocationCommands: 1 }); f.issue(); f.issue(grant('grant-2')); await f.request();
    expect(() => f.issue(grant('grant-3'))).toThrow(/capacity/); await expect(f.request('new')).rejects.toThrow(/capacity/);
    f.broker.admin.revokeGrant(command({ ...grant(),authorizationGeneration: 2 },'stale'));
    expect(f.broker.admin.revokeGrant(command()).status).toBe('revoked');
    expect(f.broker.admin.revokeGrant(command(grant('grant-2'),'second')).status).toBe('revoked');
    expect(f.broker.admin.revokeGrant(command()).status).toBe('revoked');
    expect(() => f.broker.admin.revokeGrant(command(grant(),'overflow'))).toThrow(/history full/);
  });
  it('bounds preemptive tombstones without consuming reserved revocation for issued grants',() => {
    const f = fixture({ maxPreemptiveRevocations: 1 }); f.issue();
    f.broker.admin.revokeGrant(command(grant('future'),'future'));
    expect(() => f.broker.admin.revokeGrant(command(grant('another'),'another'))).toThrow(/capacity/);
    expect(f.broker.admin.revokeGrant(command()).status).toBe('revoked');
  });
  it('bounds admissions and unresolved provider resources without allocating duplicate results',async () => {
    const f = fixture({ maxActiveReads: 1,maxAdmittedCalls: 2 }), wait = deferred<any>(); f.issue(); f.setRead(() => wait.promise);
    const a = f.request(), b = f.request(); await expect(f.request()).rejects.toThrow(/admission/);
    wait.resolve({ ref: grant().object,bytes }); await Promise.all([a,b]);
    const f2 = fixture({ maxActiveReads: 1 }), hold = deferred<any>(); f2.issue(); f2.setRead(() => hold.promise);
    const first = f2.request(); await expect(f2.request('other')).rejects.toThrow(/capacity/); hold.resolve({ ref: grant().object,bytes }); await first;
  });
  it('bounds cumulative sealed/reserved bytes even with separate grants',async () => {
    const f = fixture({ maxStoredBytes: bytes.length }); f.issue({ ...grant(),byteBudget: bytes.length }); await f.request();
    f.issue({ ...grant('grant-2'),byteBudget: bytes.length }); await expect(f.request('other','grant-2')).rejects.toThrow(/capacity/);
    expect(f.reads).toBe(1); expect(f.db.prepare('SELECT sum(size) AS n FROM reads').get()!.n).toBe(bytes.length);
  });
  it('seals the full 8 MiB payload cap in 1 MiB reads and refuses a ninth provider allocation',async () => {
    const f = fixture(), block = new Uint8Array(1024 * 1024); block.fill(17);
    const sha256 = digest(block);
    f.setRead(async (ref,max) => { expect(max).toBe(block.length); return { ref,bytes: block }; });
    for (let i = 0; i < 9; i++) {
      const g = { ...grant(`large-${i}`),object: { ...grant().object,objectKey: `projects/project-1/objects/${sha256}`,sha256,sizeBytes: block.length },byteBudget: block.length };
      f.issue(g);
      if (i < 8) expect((await f.request('read',g.grantId)).length).toBe(block.length);
      else await expect(f.request('read',g.grantId)).rejects.toThrow(/storage capacity/);
    }
    expect(f.reads).toBe(8);
    expect(f.db.prepare('SELECT sum(length(bytes)) AS n FROM reads').get()!.n).toBe(HARD_LIMITS.maxStoredBytes);
  });
  it('lifetime read histories remain bounded even for zero-byte objects',async () => {
    const f = fixture({ maxReads: 3 }), empty = new Uint8Array(0), sha256 = digest(empty);
    const g = { ...grant(),object: { ...grant().object,objectKey: `projects/project-1/objects/${sha256}`,sha256,sizeBytes: 0 },byteBudget: 0 };
    f.issue(g); f.setRead(async ref => ({ ref,bytes: empty }));
    for (let i = 0; i < 3; i++) await f.request(`read-${i}`);
    await expect(f.request('overflow')).rejects.toThrow(/read capacity/);
    expect(f.reads).toBe(3); expect(await f.request('read-0')).toEqual(empty);
  });
  it('enforces cross-instance unresolved capacity in SQLite',async () => {
    const path = file(), f = fixture({ maxActiveReads: 1 },path), hold = deferred<any>(); f.issue(); f.setRead(() => hold.promise);
    const first = f.request(); const second = fixture({ maxActiveReads: 1 },path); await expect(second.request('other')).rejects.toThrow(/capacity/);
    hold.resolve({ ref: grant().object,bytes }); await first; expect(second.reads).toBe(0);
  });
  it('times out, aborts, retains unknown charge/resource cap, and ignores late completion',async () => {
    const f = fixture({ timeoutMs: 10,maxActiveReads: 1 }), hold = deferred<any>(); f.issue(); let signal!: AbortSignal;
    f.setRead((_ref,_max,s) => { signal = s; return hold.promise; });
    await expect(f.request()).rejects.toThrow(/timeout/); expect(signal.aborted).toBe(true);
    await expect(f.request('other')).rejects.toThrow(/capacity/); await expect(f.request()).rejects.toThrow(/unknown/);
    hold.resolve({ ref: grant().object,bytes }); await Promise.resolve();
    expect(f.db.prepare('SELECT state,bytes FROM reads').get()).toMatchObject({ state: 'unknown',bytes: null });
  });
  it('fails closed on elapsed trusted clock deadline even before event-loop timeout fires',async () => {
    const f = fixture({ timeoutMs: 20 }); f.issue(); f.setRead(async ref => { f.setTime(1020); return { ref,bytes }; });
    await expect(f.request()).rejects.toThrow(/deadline/);
  });
  for (const field of ['policyVersion','policyHash','intentId','authorizationGeneration','principalRef','projectId','grantId','byteBudget','expiresAt']) {
    it(`rejects current ${field} fence mismatch before provider`,async () => {
      const f = fixture(); f.issue(); f.setObserve(g => ({ grant: { ...g,[field]: typeof g[field as keyof ReadGrant] === 'number' ? 2 : 'changed' },status: 'authorized',revoked: false,observedAt: 1000,expiresAt: 100000 }));
      await expect(f.request()).rejects.toThrow(); expect(f.reads).toBe(0);
    });
  }
  for (const field of Object.keys(grant().compute)) {
    it(`rejects current compute ${field} mismatch after provider`,async () => {
      const f = fixture(); f.issue(); f.setRead(async ref => {
        f.setObserve(g => ({ grant: { ...g,compute: { ...g.compute,[field]: typeof g.compute[field as keyof ReadGrant['compute']] === 'number' ? 7 : 'changed' } },status: 'authorized',revoked: false,observedAt: 1000,expiresAt: 100000 }));
        return { ref,bytes };
      });
      await expect(f.request()).rejects.toThrow(); expect(f.db.prepare('SELECT state FROM reads').get()!.state).toBe('unknown');
    });
  }
  for (const patch of [{ revoked: true },{ status: 'cancelled' },{ observedAt: 999 },{ observedAt: 1001 },{ expiresAt: 1000 }]) {
    it(`rejects stale/revoked authority observation ${canonical(patch)}`,async () => {
      const f = fixture(); f.issue(); await f.request(); f.setObserve(g => ({ grant: g,status: 'authorized',revoked: false,observedAt: 1000,expiresAt: 100000,...patch }));
      await expect(f.request()).rejects.toThrow(); expect(f.reads).toBe(1);
    });
  }
  it('fails closed when current authority is unavailable; worker cannot supply acceptance',async () => {
    const f = fixture(); f.issue(); f.setObserve(() => { throw new Error('authority unavailable'); });
    await expect(f.request()).rejects.toThrow(/unavailable/);
    await expect(f.broker.reader.read('worker-principal',{ ...req,acceptance: {} })).rejects.toThrow(); expect(f.reads).toBe(0);
  });
  it('fences expiry on in-flight and completed replay, and persists clock highwater',async () => {
    const f = fixture(); f.issue(); await f.request(); f.setTime(100000); await expect(f.request()).rejects.toThrow(/expired/);
    f.setTime(999); await expect(f.request()).rejects.toThrow(/clock regression/);
    const f2 = fixture(); f2.issue(); f2.setRead(async ref => { f2.setTime(100000); return { ref,bytes }; }); await expect(f2.request()).rejects.toThrow(/expired|deadline/);
  });
  for (const patch of [{ objectKey: '../secrets' },{ objectKey: 'https://example.com' },{ objectKey: `projects/other/objects/${digest(bytes)}` },{ objectKey: `projects/project-1/objects/${digest(bytes)}%2f` },{ generation: '01' },{ generation: '1\n' },{ generation: '1'.repeat(33) },{ generation: '0' },{ generation: 1 },{ sizeBytes: 1048577 },{ projectId: 'other' }]) {
    it(`rejects path/reference abuse ${canonical(patch)}`,() => { expect(() => validateGrant({ ...grant(),object: { ...grant().object,...patch } })).toThrow(); });
  }
  it('accepts positive generations of exactly 32 digits and exact manifests path',() => {
    expect(validateGrant({ ...grant(),object: { ...grant().object,generation: '9'.repeat(32),objectKey: `projects/project-1/manifests/${digest(bytes)}` } }).object.generation.length).toBe(32);
  });
  it('rejects accessors, proxies, extra body context, symbols, prototypes and complexity without invoking traps',async () => {
    const f = fixture(); f.issue(); let invoked = 0;
    const getter = Object.defineProperty({},'grantId',{ enumerable: true,get() { invoked++; return 'grant-1'; } });
    const proxy = new Proxy(req,{ ownKeys() { invoked++; return []; } });
    for (const input of [getter,proxy,{ ...req,context: grant() },{ ...req,[Symbol('extra')]: 1 },Object.assign(Object.create({}),req),{ ...req,requestId: 'x'.repeat(300000) }]) await expect(f.broker.reader.read('worker-principal',input)).rejects.toThrow();
    expect(invoked).toBe(0); expect(f.reads).toBe(0);
  });
  for (const kind of ['digest','size','generation','key','getter','shared']) {
    it(`never seals invalid provider ${kind}`,async () => {
      const f = fixture(); f.issue(); let invoked = false;
      f.setRead(async ref => {
        if (kind === 'getter') return Object.defineProperty({ ref },'bytes',{ enumerable: true,get() { invoked = true; return bytes; } }) as any;
        if (kind === 'shared') return { ref,bytes: new Uint8Array(new SharedArrayBuffer(bytes.length)) };
        if (kind === 'digest') return { ref,bytes: new Uint8Array(bytes.length) };
        if (kind === 'size') return { ref,bytes: new Uint8Array(bytes.length + 1) };
        return { ref: { ...ref,...(kind === 'generation' ? { generation: '124' } : { objectKey: 'arbitrary' }) },bytes };
      });
      await expect(f.request()).rejects.toThrow(); expect(invoked).toBe(false);
      expect(f.db.prepare('SELECT state,bytes FROM reads').get()).toMatchObject({ state: 'unknown',bytes: null });
    });
  }
  it('constructor binding and schema mismatch preserve original file evidence',() => {
    const path = file(), f = fixture({},path); f.issue(); f.db.close(); const before = readFileSync(path);
    const db = new DatabaseSync(path); cleanup.push(() => db.close());
    expect(() => createStorageBroker({ ...f.ports,db,binding: { environment: 'wrong',authorityId: 'broker-1' } })).toThrow(/binding/);
    expect(() => createStorageBroker({ ...f.ports,db,limits: { maxGrants: 1 } })).toThrow(/binding/); expect(readFileSync(path)).toEqual(before);
    db.exec('DROP TRIGGER grants_delete'); const altered = readFileSync(path);
    expect(() => createStorageBroker({ ...f.ports,db })).toThrow(/schema mismatch/); expect(readFileSync(path)).toEqual(altered);
  });
  it('rejects partial foreign schema without adding broker tables',() => {
    const db = new DatabaseSync(':memory:'); cleanup.push(() => db.close()); db.exec('CREATE TABLE evidence (id TEXT)');
    const f = fixture(); expect(() => createStorageBroker({ ...f.ports,db })).toThrow(/schema mismatch/);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()).toEqual([{ name: 'evidence' }]);
  });
  it('SQL rejects immutable updates, replacement, deletion and sealed result rewrites',async () => {
    const f = fixture(); f.issue(); await f.request(); f.broker.admin.revokeGrant(command());
    for (const table of ['binding','grants','reads','revoked','revocation_commands','clock']) expect(() => f.db.exec(`DELETE FROM ${table}`)).toThrow(/deletion/);
    for (const statement of ["UPDATE grants SET body='{}'", "UPDATE binding SET value='{}'", "UPDATE revoked SET binding='{}'", "UPDATE revocation_commands SET reply='{}'", "UPDATE reads SET state='unknown',bytes=NULL", "UPDATE clock SET value=0", "INSERT OR REPLACE INTO grants SELECT * FROM grants", "INSERT OR REPLACE INTO reads SELECT * FROM reads", "INSERT OR REPLACE INTO revoked SELECT * FROM revoked", "INSERT OR REPLACE INTO binding SELECT * FROM binding", "INSERT OR REPLACE INTO clock SELECT * FROM clock", "INSERT OR REPLACE INTO revocation_commands SELECT * FROM revocation_commands"]) expect(() => f.db.exec(statement)).toThrow();
    expect(() => f.db.prepare('INSERT INTO grants VALUES(?,?,?)').run('other',canonical(grant()),grant().byteBudget)).toThrow();
    expect(() => f.db.prepare('INSERT INTO grants VALUES(?,?,?)').run('missing','{}',0)).toThrow();
    expect(() => f.db.prepare('INSERT INTO grants VALUES(?,?,?)').run('other',canonical({ ...grant('other'),byteBudget: 10 }),11)).toThrow();
  });
  it('reserves first-revocation journal capacity through the SQL hard maximum',() => {
    const f = fixture({ maxGrants: 1,maxPreemptiveRevocations: 1,maxRevocationCommands: 1 }); f.issue();
    const stale = command({ ...grant(),authorizationGeneration: 2 },'stale');
    expect(f.broker.admin.revokeGrant(stale).status).toBe('superseded');
    expect(f.broker.admin.revokeGrant(command()).status).toBe('revoked');
    expect(f.broker.admin.revokeGrant(command(grant('future'),'future')).status).toBe('revoked');
    expect(f.db.prepare('SELECT count(*) AS n FROM revocation_commands').get()!.n).toBe(3);
    expect(f.broker.admin.revokeGrant(stale).status).toBe('superseded');
    expect(() => f.broker.admin.revokeGrant(command(grant('third'),'third'))).toThrow();
    expect(f.db.prepare('SELECT count(*) AS n FROM revoked').get()!.n).toBe(2);
  });
  it('rejects post-provider catalog authorization generation changes and provider synchronous exceptions',async () => {
    const f = fixture(); f.issue(); f.setRead(async ref => {
      f.setObserve(g => ({ grant: { ...g,authorizationGeneration: 2 },status: 'authorized',revoked: false,observedAt: 1000,expiresAt: 100000 }));
      return { ref,bytes };
    }); await expect(f.request()).rejects.toThrow(/fence/);
    const other = fixture(); other.issue(); other.setRead(() => { throw new Error('synchronous failure'); });
    await expect(other.request()).rejects.toThrow(/synchronous/); await expect(other.request()).rejects.toThrow(/unknown/); expect(other.reads).toBe(1);
  });
  it('rejects enlarged limits/unknown config and hard per-read/lifetime budgets',() => {
    const f = fixture(); expect(() => createStorageBroker({ ...f.ports,limits: { maxReadBytes: HARD_LIMITS.maxReadBytes + 1 } })).toThrow();
    expect(() => createStorageBroker({ ...f.ports,limits: { extra: 1 } as any })).toThrow();
    expect(() => f.issue({ ...grant(),expiresAt: 4_000_000 })).toThrow(/lifetime/);
  });
});

import { describe, expect, it } from 'vitest';
import { checkpointStore, validateScope } from './index';
import { command, H, OTHER, owner, scope, sqlite } from './test-support';

describe('independent owner checkpoint ledger', () => {
  it('starts unapproved and exposes a reader without an approval capability', () => {
    const h = sqlite(), store = checkpointStore(h.port, scope);
    expect(Object.keys(store.reader)).toEqual(['latest']);
    expect(store.reader.latest()).toEqual({ version: 1, scope, revision: 0, archiveSha256: null, approvedAt: 0 });
    expect(h.db.prepare('SELECT count(*) AS n FROM library_checkpoint_decisions').get()).toEqual({ n: 0 });
  });
  it('approves, withdraws and reapproves via contiguous CAS decisions; reopening retains them', () => {
    const h = sqlite(); let time = 100;
    const open = () => checkpointStore(h.port, scope, () => time), store = open();
    expect(store.admin.execute(owner, command())).toMatchObject({ revision: 1, archiveSha256: H, approvedAt: 100 });
    time = 101;
    expect(open().admin.execute(owner, command('withdraw', 1, null))).toMatchObject({ revision: 2, archiveSha256: null });
    time = 102;
    expect(open().admin.execute(owner, command('approve-other', 2, OTHER))).toMatchObject({ revision: 3, archiveSha256: OTHER });
    expect(open().reader.latest()).toEqual(store.reader.latest());
    expect(h.db.prepare('SELECT revision,archive_sha256 FROM library_checkpoint_decisions ORDER BY revision').all()).toEqual([
      { revision: 1, archive_sha256: H }, { revision: 2, archive_sha256: null }, { revision: 3, archive_sha256: OTHER },
    ]);
  });
  it('replays the original receipt after later withdrawal without reapproving or reading the clock', () => {
    const h = sqlite(); const store = checkpointStore(h.port, scope, () => 100);
    const first = store.admin.execute(owner, command()); store.admin.execute(owner, command('withdraw', 1, null));
    const reopened = checkpointStore(h.port, scope, () => { throw new Error('clock must not run for replay'); });
    expect(reopened.admin.execute(owner, command())).toEqual(first);
    expect(reopened.reader.latest()).toMatchObject({ revision: 2, archiveSha256: null });
  });
  it.each(['reason', 'archiveSha256', 'expectedRevision'] as const)('rejects conflicting replay of %s without changing evidence', field => {
    const h = sqlite(), store = checkpointStore(h.port, scope, () => 100); store.admin.execute(owner, command());
    const changed = { ...command(), [field]: field === 'expectedRevision' ? 1 : field === 'reason' ? 'different reason' : OTHER };
    expect(() => store.admin.execute(owner, changed)).toThrow('CHECKPOINT_COMMAND_CONFLICT');
    expect(store.reader.latest().revision).toBe(1);
  });
  it('fences competing handles and permits retry after a failed CAS', () => {
    const h = sqlite(), a = checkpointStore(h.port, scope, () => 100), b = checkpointStore(h.port, scope, () => 100);
    a.admin.execute(owner, command());
    expect(() => b.admin.execute(owner, command('second'))).toThrow('CHECKPOINT_REVISION');
    expect(b.admin.execute(owner, command('second', 1, OTHER)).revision).toBe(2);
  });
  it.each([{ ...owner, environment: 'prod' }, { ...owner, principal: 'impostor' }, { ...owner, role: 'dispatcher' }])('rejects unauthorized owner labels %j even on replay', context => {
    const h = sqlite(), store = checkpointStore(h.port, scope); store.admin.execute(owner, command());
    expect(() => store.admin.execute(context as typeof owner, command())).toThrow('CHECKPOINT_PERMISSION');
    expect(store.reader.latest().revision).toBe(1);
  });
  it.each([
    { ...command(), key: '' }, { ...command(), expectedRevision: -1 }, { ...command(), expectedRevision: 0.5 },
    { ...command(), archiveSha256: 'A'.repeat(64) }, { ...command(), reason: '' }, { ...command(), reason: 'line\nbreak' },
    { ...command(), extra: true }, { ...command(), reason: 'x'.repeat(257) },
  ])('rejects malformed command atomically: %j', input => {
    const h = sqlite(), store = checkpointStore(h.port, scope);
    expect(() => store.admin.execute(owner, input)).toThrow(); expect(store.reader.latest().revision).toBe(0);
  });
  it('does not invoke getters while validating untrusted commands', () => {
    const h = sqlite(), store = checkpointStore(h.port, scope); let called = false;
    const input = { ...command(), get reason() { called = true; return 'reason'; } };
    expect(() => store.admin.execute(owner, input)).toThrow(); expect(called).toBe(false);
  });
  it.each(Object.keys(scope) as (keyof typeof scope)[])('binds persisted scope field %s', key => {
    const h = sqlite(), store = checkpointStore(h.port, scope); store.admin.execute(owner, command());
    expect(() => checkpointStore(h.port, { ...scope, [key]: key === 'policyHash' ? OTHER : 'other' })).toThrow('CHECKPOINT_SCOPE');
    expect(store.reader.latest().archiveSha256).toBe(H);
  });
  it('rejects malformed scope before schema creation', () => {
    const h = sqlite(); expect(() => validateScope({ ...scope, unexpected: true })).toThrow();
    expect(() => checkpointStore(h.port, { ...scope, policyHash: 'bad' })).toThrow();
    expect(h.db.prepare("SELECT name FROM sqlite_master WHERE name GLOB 'library_checkpoint_*'").all()).toEqual([]);
  });
  it('copies caller scope and returned checkpoints so neither can mutate persisted authority', () => {
    const h = sqlite(), input = { ...scope }, store = checkpointStore(h.port, input, () => 100);
    input.ownerPrincipal = 'impostor'; const result = store.admin.execute(owner, command());
    result.scope.ownerPrincipal = 'impostor'; result.archiveSha256 = OTHER;
    const read = store.reader.latest(); read.scope.projectId = 'other';
    expect(store.reader.latest()).toMatchObject({ scope, archiveSha256: H });
  });
  it('fails closed on clock rollback and invalid clock, without consuming keys', () => {
    const h = sqlite(); let time = 100; const store = checkpointStore(h.port, scope, () => time); store.admin.execute(owner, command());
    time = 99; expect(() => store.admin.execute(owner, command('next', 1))).toThrow('CHECKPOINT_CLOCK');
    time = NaN; expect(() => store.admin.execute(owner, command('next', 1))).toThrow();
    time = 100; expect(store.admin.execute(owner, command('next', 1)).revision).toBe(2);
  });
  it('rolls back failed append and permits exact retry', () => {
    const h = sqlite(), store = checkpointStore(h.port, scope, () => 100); h.fail('INSERT INTO library_checkpoint_decisions');
    expect(() => store.admin.execute(owner, command())).toThrow('injected SQLite failure');
    expect(store.reader.latest().revision).toBe(0); expect(store.admin.execute(owner, command()).revision).toBe(1);
  });
  it('rolls back partial schema initialization', () => {
    const h = sqlite(); h.fail('CREATE TABLE library_checkpoint_decisions');
    expect(() => checkpointStore(h.port, scope)).toThrow('injected SQLite failure');
    expect(h.db.prepare("SELECT name FROM sqlite_master WHERE name GLOB 'library_checkpoint_*'").all()).toEqual([]);
    expect(checkpointStore(h.port, scope).reader.latest().revision).toBe(0);
  });
  it.each(['CREATE TABLE library_checkpoint_unknown(x TEXT)', 'DROP TRIGGER library_checkpoint_decisions_update', 'ALTER TABLE library_checkpoint_decisions ADD COLUMN extra TEXT'])('rejects schema drift: %s', sql => {
    const h = sqlite(), store = checkpointStore(h.port, scope); store.admin.execute(owner, command()); h.db.exec(sql);
    expect(() => checkpointStore(h.port, scope)).toThrow('CHECKPOINT_SCHEMA'); expect(store.reader.latest().revision).toBe(1);
  });
  it.each(['binding', 'decisions'])('blocks SQL update, delete and replacement of %s evidence', table => {
    const h = sqlite(), store = checkpointStore(h.port, scope); store.admin.execute(owner, command()); const before = store.reader.latest();
    for (const sql of [`UPDATE library_checkpoint_${table} SET ${table === 'binding' ? 'content=content' : 'at_ms=at_ms'}`, `DELETE FROM library_checkpoint_${table}`, `INSERT OR REPLACE INTO library_checkpoint_${table} SELECT * FROM library_checkpoint_${table}`]) {
      expect(() => h.db.exec(sql)).toThrow(); expect(store.reader.latest()).toEqual(before);
    }
  });
  it('blocks direct sequence gaps and duplicate keys', () => {
    const h = sqlite(), store = checkpointStore(h.port, scope); store.admin.execute(owner, command());
    expect(() => h.db.prepare('INSERT INTO library_checkpoint_decisions VALUES(?,?,?,?,?)').run(3, 'gap', '{}', H, 100)).toThrow();
    expect(() => h.db.prepare('INSERT INTO library_checkpoint_decisions VALUES(?,?,?,?,?)').run(2, 'approve', '{}', H, 100)).toThrow();
    expect(store.reader.latest().revision).toBe(1);
  });
  it('retains all 1024 lifetime decisions, rejects overflow, and still allows replay', () => {
    const h = sqlite(), store = checkpointStore(h.port, scope, () => 100);
    for (let n = 0; n < 1024; n++) store.admin.execute(owner, command(`key-${n}`, n, n % 2 ? null : H));
    expect(() => store.admin.execute(owner, command('overflow', 1024))).toThrow('checkpoint sequence or capacity');
    expect(store.reader.latest()).toMatchObject({ revision: 1024, archiveSha256: null });
    expect(store.admin.execute(owner, command('key-0', 0)).revision).toBe(1);
    expect(h.db.prepare('SELECT count(*) AS n FROM library_checkpoint_decisions').get()).toEqual({ n: 1024 });
  });
  it('does not read or modify catalog restore data as an approval source', () => {
    const h = sqlite(); h.db.exec("CREATE TABLE library_restore_guard(archive TEXT); INSERT INTO library_restore_guard VALUES('untrusted')");
    const store = checkpointStore(h.port, scope); expect(store.reader.latest().revision).toBe(0);
    store.admin.execute(owner, command());
    expect(h.db.prepare('SELECT * FROM library_restore_guard').all()).toEqual([{ archive: 'untrusted' }]);
  });
});

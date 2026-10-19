import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { SqlStoragePort } from '../../../packages/compute-authority/src/durable/contracts';
import { ArtifactStore, MAX_ARTIFACT_BYTES, MAX_TOTAL_ARTIFACT_BYTES } from './artifact-store';

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE leases(id TEXT PRIMARY KEY)');
  const statements: string[] = [];
  const sql: SqlStoragePort = { exec(query, ...bindings) {
    statements.push(query);
    return db.prepare(query).all(...bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value)) as Record<string, unknown>[];
  } };
  const store = new ArtifactStore(sql);
  const lease = (id: string) => db.prepare('INSERT INTO leases VALUES(?)').run(id);
  lease('lease'); lease('other');
  return { db, sql, store, lease, statements };
}

describe('sealed SQL artifact bytes (Node SQLite adapter)', () => {
  it('hashes actual view bytes, copies input/output, reopens, and exposes authorization metadata', () => {
    const f = fixture();
    const backing = new Uint8Array([9, 1, 2, 9]);
    const result = f.store.put('lease', 'executor', backing.subarray(1, 3));
    expect(result).toEqual({ reference: expect.stringMatching(/^[a-f0-9]{64}$/), sha256: hash(new Uint8Array([1, 2])), bytes: 2 });
    backing.fill(0);
    const read = f.store.read(result.reference, 2); expect([...read]).toEqual([1, 2]); read.fill(8);
    expect([...new ArtifactStore(f.sql).read(result.reference, 2)]).toEqual([1, 2]);
    expect(f.store.getMetadata(result.reference)).toEqual({ ...result, leaseId: 'lease', principal: 'executor' });
    expect(f.statements.some(s => /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b/i.test(s))).toBe(false);
  });

  it('replays identical puts but rejects changed principal or bytes and isolates cross-lease refs', () => {
    const { store, db } = fixture(); const bytes = new Uint8Array([1]);
    const first = store.put('lease', 'executor', bytes);
    expect(store.put('lease', 'executor', bytes)).toEqual(first);
    expect(() => store.put('lease', 'other', bytes)).toThrow('conflict');
    expect(() => store.put('lease', 'executor', new Uint8Array([2]))).toThrow('conflict');
    const other = store.put('other', 'executor', bytes);
    expect(other.sha256).toBe(first.sha256); expect(other.reference).not.toBe(first.reference);
    expect(db.prepare('SELECT * FROM compute_artifact_bytes').all()).toHaveLength(2);
  });

  it('blocks updates, deletes, duplicates, and REPLACE even without recursive triggers', () => {
    const { store, db } = fixture(); const r = store.put('lease', 'executor', new Uint8Array([1]));
    for (const query of [
      "UPDATE compute_artifact_bytes SET principal='other'",
      'DELETE FROM compute_artifact_bytes',
      'INSERT INTO compute_artifact_bytes SELECT * FROM compute_artifact_bytes',
      'INSERT OR REPLACE INTO compute_artifact_bytes SELECT * FROM compute_artifact_bytes',
    ]) expect(() => db.exec(query)).toThrow('immutable');
    expect(store.read(r.reference, 1)).toEqual(new Uint8Array([1]));
    expect(() => store.put('missing', 'executor', new Uint8Array())).toThrow(/FOREIGN KEY/);
  });

  it('validates IDs, byte type, limits and exact 1 MiB boundary including empty content', () => {
    const { store } = fixture();
    for (const id of ['', 'a/b', 'a'.repeat(65), 'a\n', null]) {
      expect(() => store.put(id as string, 'executor', new Uint8Array())).toThrow();
      expect(() => store.put('lease', id as string, new Uint8Array())).toThrow();
    }
    expect(() => store.put('lease', 'executor', [] as unknown as Uint8Array)).toThrow();
    expect(() => store.put('lease', 'executor', new Uint8Array(MAX_ARTIFACT_BYTES + 1))).toThrow();
    const full = store.put('lease', 'executor', new Uint8Array(MAX_ARTIFACT_BYTES));
    expect(store.read(full.reference, MAX_ARTIFACT_BYTES)).toHaveLength(MAX_ARTIFACT_BYTES);
    expect(() => store.read(full.reference, MAX_ARTIFACT_BYTES - 1)).toThrow();
    const empty = store.put('other', 'executor', new Uint8Array());
    expect(store.read(empty.reference, 0)).toHaveLength(0);
    for (const max of [-1, 0.5, NaN, Infinity, MAX_ARTIFACT_BYTES + 1]) expect(() => store.read(empty.reference, max)).toThrow();
    for (const ref of ['', 'A'.repeat(64), 'a'.repeat(65)]) expect(() => store.read(ref, 1)).toThrow('reference');
    expect(() => store.read('0'.repeat(64), 1)).toThrow('not found');
  });

  it('rejects forged hash, ref, size, or content rows on reads', () => {
    for (const corruption of ["sha256='" + '0'.repeat(64) + "'", "ref='" + '0'.repeat(64) + "'", 'size=2', "bytes=x'02'"]) {
      const { db, store } = fixture(); const r = store.put('lease', 'executor', new Uint8Array([1]));
      db.exec('DROP TRIGGER compute_artifact_no_update; PRAGMA ignore_check_constraints=ON');
      db.exec(`UPDATE compute_artifact_bytes SET ${corruption}`);
      const ref = corruption.startsWith('ref=') ? '0'.repeat(64) : r.reference;
      expect(() => store.read(ref, 10)).toThrow(); expect(() => store.getMetadata(ref)).toThrow();
    }
  });

  it('shares caller rollback and commit with the parent staging decision', () => {
    const { db, store } = fixture();
    db.exec('BEGIN'); const rejected = store.put('lease', 'executor', new Uint8Array([1])); db.exec('ROLLBACK');
    expect(() => store.read(rejected.reference, 1)).toThrow('not found');
    db.exec('BEGIN'); const accepted = store.put('lease', 'executor', new Uint8Array([2])); db.exec('COMMIT');
    expect(store.read(accepted.reference, 1)).toEqual(new Uint8Array([2]));
  });

  it('caps growth at 64 MiB while allowing identical retries at capacity', () => {
    const { store, lease, db } = fixture(); const bytes = new Uint8Array(MAX_ARTIFACT_BYTES);
    let first!: ReturnType<ArtifactStore['put']>;
    for (let i = 0; i < MAX_TOTAL_ARTIFACT_BYTES / MAX_ARTIFACT_BYTES; i++) {
      const id = `bulk-${i}`; lease(id); const result = store.put(id, 'executor', bytes); if (i === 0) first = result;
    }
    expect(store.put('bulk-0', 'executor', bytes)).toEqual(first);
    expect(() => store.put('lease', 'executor', new Uint8Array([1]))).toThrow('capacity');
    expect(db.prepare('SELECT sum(size) AS total FROM compute_artifact_bytes').get()?.total).toBe(MAX_TOTAL_ARTIFACT_BYTES);
  });
});

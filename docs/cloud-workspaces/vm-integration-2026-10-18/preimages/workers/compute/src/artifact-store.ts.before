import { createHash } from 'node:crypto';
import type { SqlStoragePort, SqlValue } from '../../../packages/compute-authority/src/durable/contracts';

export const MAX_ARTIFACT_BYTES = 1024 * 1024;
export const MAX_TOTAL_ARTIFACT_BYTES = 64 * 1024 * 1024;
const ID = /^[A-Za-z0-9._-]{1,64}$/;
const SHA = /^[a-f0-9]{64}$/;
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const referenceFor = (leaseId: string, sha256: string) => digest(JSON.stringify(['compute-artifact-v1', leaseId, sha256]));
function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('invalid artifact identifier');
}
function reference(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !SHA.test(value)) throw new Error('invalid artifact reference');
}
export interface ArtifactMetadata {
  reference: string;
  sha256: string;
  bytes: number;
  leaseId: string;
  principal: string;
}

/**
 * Sealed bytes in ONE host-bound authority SQL namespace. The host must supply
 * the same SQL port as DurableAuthority; references alone grant no authorization.
 * The caller owns the encompassing transaction: put and core stageResult must
 * commit together only after an accepted live lease fence, rolling back on any
 * rejected stageResult (including an {ok:false} return). This store never starts,
 * commits or rolls back a transaction. Metadata supports host-authorized reads;
 * the host must check principal/lease binding before exposing bytes to a caller.
 */
export class ArtifactStore {
  constructor(private readonly sql: SqlStoragePort) {
    this.query(`CREATE TABLE IF NOT EXISTS compute_artifact_bytes (
      ref TEXT PRIMARY KEY NOT NULL,
      lease_id TEXT NOT NULL UNIQUE REFERENCES leases(id),
      principal TEXT NOT NULL,
      sha256 TEXT NOT NULL CHECK(length(sha256)=64),
      bytes BLOB NOT NULL CHECK(typeof(bytes)='blob'),
      size INTEGER NOT NULL CHECK(typeof(size)='integer' AND size BETWEEN 0 AND 1048576 AND size=length(bytes))
    )`);
    this.query(`CREATE TRIGGER IF NOT EXISTS compute_artifact_no_update BEFORE UPDATE ON compute_artifact_bytes
      BEGIN SELECT RAISE(ABORT,'immutable artifact bytes'); END`);
    this.query(`CREATE TRIGGER IF NOT EXISTS compute_artifact_no_delete BEFORE DELETE ON compute_artifact_bytes
      BEGIN SELECT RAISE(ABORT,'immutable artifact bytes'); END`);
    // REPLACE can bypass DELETE triggers when recursive_triggers is disabled.
    this.query(`CREATE TRIGGER IF NOT EXISTS compute_artifact_no_replace BEFORE INSERT ON compute_artifact_bytes
      WHEN EXISTS(SELECT 1 FROM compute_artifact_bytes WHERE ref=NEW.ref OR lease_id=NEW.lease_id)
      BEGIN SELECT RAISE(ABORT,'immutable artifact bytes'); END`);
  }

  private query(statement: string, ...bindings: SqlValue[]) {
    return [...this.sql.exec(statement, ...bindings)];
  }

  put(leaseId: string, principal: string, bytes: Uint8Array): Pick<ArtifactMetadata, 'reference' | 'sha256' | 'bytes'> {
    identifier(leaseId); identifier(principal);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_ARTIFACT_BYTES) throw new Error('invalid artifact bytes');
    const copy = new Uint8Array(bytes);
    const sha256 = digest(copy);
    const ref = referenceFor(leaseId, sha256);
    const existing = this.query('SELECT ref FROM compute_artifact_bytes WHERE lease_id=?', leaseId)[0];
    if (existing) {
      const stored = this.load(String(existing.ref), MAX_ARTIFACT_BYTES);
      if (stored.metadata.principal !== principal || stored.metadata.sha256 !== sha256 ||
          stored.bytes.length !== copy.length || !stored.bytes.every((byte, i) => byte === copy[i])) {
        throw new Error('artifact lease conflict');
      }
    } else {
      const total = this.query('SELECT COALESCE(sum(length(bytes)),0) AS total FROM compute_artifact_bytes')[0]?.total;
      if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0 || total + copy.byteLength > MAX_TOTAL_ARTIFACT_BYTES) {
        throw new Error('artifact storage capacity exceeded');
      }
      this.query('INSERT INTO compute_artifact_bytes(ref,lease_id,principal,sha256,bytes,size) VALUES(?,?,?,?,CASE WHEN ?=0 THEN zeroblob(0) ELSE ? END,?)',
        ref, leaseId, principal, sha256, copy.byteLength, copy.buffer, copy.byteLength);
    }
    return { reference: ref, sha256, bytes: copy.byteLength };
  }

  getMetadata(ref: string): ArtifactMetadata {
    return this.load(ref, MAX_ARTIFACT_BYTES).metadata;
  }

  read(ref: string, maxBytes: number): Uint8Array {
    return this.load(ref, maxBytes).bytes;
  }

  private load(ref: string, maxBytes: number): { metadata: ArtifactMetadata; bytes: Uint8Array } {
    reference(ref);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_ARTIFACT_BYTES) throw new Error('invalid artifact read limit');
    const row = this.query(`SELECT ref,lease_id,principal,sha256,size,length(bytes) AS actual_size,typeof(bytes) AS byte_type
      FROM compute_artifact_bytes WHERE ref=?`, ref)[0];
    if (!row) throw new Error('artifact not found');
    identifier(row.lease_id); identifier(row.principal);
    if (row.ref !== ref || typeof row.sha256 !== 'string' || !SHA.test(row.sha256) ||
        !Number.isSafeInteger(row.size) || (row.size as number) < 0 || (row.size as number) > maxBytes ||
        row.actual_size !== row.size || row.byte_type !== 'blob' || referenceFor(row.lease_id, row.sha256) !== ref) {
      throw new Error('artifact integrity or size mismatch');
    }
    const blob = this.query('SELECT bytes FROM compute_artifact_bytes WHERE ref=? AND length(bytes)<=?', ref, maxBytes)[0]?.bytes;
    if (!(blob instanceof Uint8Array) && !(blob instanceof ArrayBuffer)) throw new Error('invalid artifact blob');
    const bytes = blob instanceof ArrayBuffer ? new Uint8Array(blob.slice(0)) : new Uint8Array(blob);
    if (bytes.byteLength !== row.size || digest(bytes) !== row.sha256) throw new Error('artifact integrity mismatch');
    return { metadata: { reference: ref, leaseId: row.lease_id, principal: row.principal, sha256: row.sha256, bytes: bytes.length }, bytes };
  }
}

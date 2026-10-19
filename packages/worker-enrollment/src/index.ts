import { createHash } from 'node:crypto';
import { SCHEMA } from './schema';
import { EnrollmentError, type ApprovedIdentity, type EnrollRequest, type ExecutorBinding, type HeartbeatRequest, type Options, type OwnerContext, type RevokeRequest, type EnrollmentStatus, type MutationResult, type SqlValue, type TransactionPort } from './contracts';
export * from './contracts';
type Row = Record<string, unknown>;
const fail = (code: string): never => { throw new EnrollmentError(code); };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function exact(value: unknown, keys: string[]): asserts value is Row {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail('invalid-fields');
}
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(value)) fail('invalid-identifier');
}
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail('invalid-integer');
}
function digest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('invalid-digest');
}
const identityKeys = ['workerId','principal','workerClass','cpu','ramMib','devices'];
function identity(value: unknown): ApprovedIdentity {
  exact(value, identityKeys); id(value.workerId); id(value.principal);
  if (value.workerClass !== 'general' && value.workerClass !== 'edge') fail('invalid-class');
  integer(value.cpu, 0, 65536); integer(value.ramMib, 0, 1073741824);
  if (!Array.isArray(value.devices) || value.devices.length > 64) fail('invalid-devices');
  const devices = (value.devices as unknown[]).map(d => {
    exact(d, ['id','kind','vramMib']); id(d.id); integer(d.vramMib, 1, 1073741824);
    if (d.kind !== 'cuda' && d.kind !== 'metal') fail('invalid-device-kind');
    return {id:d.id,kind:d.kind as 'cuda'|'metal',vramMib:d.vramMib};
  }).sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (new Set(devices.map(d => d.id)).size !== devices.length) fail('duplicate-device');
  if (value.workerClass === 'edge' ? value.cpu !== 0 || value.ramMib !== 0 || devices.length !== 0 : value.cpu < 1 || value.ramMib < 1) fail('class-geometry');
  return {workerId:value.workerId,principal:value.principal,workerClass:value.workerClass as 'general'|'edge',cpu:value.cpu,ramMib:value.ramMib,devices};
}
/** All contexts/options are host-established, never caller-authorized JSON.
 * Methods throw EnrollmentError on domain rejection and propagate storage errors.
 * No callbacks, network operations, tokens, or compute mutations live here.
 */
export class WorkerEnrollment {
  readonly heartbeatFreshnessMs: number;
  readonly heartbeatMinIntervalMs: number;
  constructor(private readonly storage: TransactionPort, private readonly options: Options) {
    id(options.environment); id(options.authorityId);
    this.heartbeatFreshnessMs = options.heartbeatFreshnessMs ?? 60000;
    integer(this.heartbeatFreshnessMs, 1, 300000);
    this.heartbeatMinIntervalMs = options.heartbeatMinIntervalMs ?? Math.min(1000,this.heartbeatFreshnessMs);
    integer(this.heartbeatMinIntervalMs,1,this.heartbeatFreshnessMs);
    const workers = options.maxWorkers ?? 128, credentials = options.maxCredentials ?? 4096, events = options.maxEvents ?? 65536;
    integer(workers,1,128); integer(credentials,1,4096); integer(events,credentials+1,65536);
    storage.transactionSync(() => {
      SCHEMA.forEach(sql => this.q(sql));
      const meta = this.one('SELECT * FROM enrollment_meta');
      if (!meta) this.q('INSERT INTO enrollment_meta VALUES(1,2,?,?,?,?,?,?,?,0)',options.environment,options.authorityId,this.heartbeatFreshnessMs,this.heartbeatMinIntervalMs,workers,credentials,events);
      else if (meta.schema_version !== 2 || meta.environment !== options.environment || meta.authority_id !== options.authorityId || meta.freshness_ms !== this.heartbeatFreshnessMs || meta.heartbeat_min_interval_ms !== this.heartbeatMinIntervalMs || meta.max_workers !== workers || meta.max_credentials !== credentials || meta.max_events !== events) fail('namespace-or-policy-mismatch');
    });
  }
  private q(sql: string, ...args: SqlValue[]): Row[] { return [...this.storage.sql.exec(sql,...args)]; }
  private one(sql: string, ...args: SqlValue[]) { return this.q(sql,...args)[0]; }
  /** Read observation never advances durable time or liveness. */
  private observedTime(): number {
    const observed = (this.options.now ?? Date.now)(); integer(observed,0);
    const persisted = this.one('SELECT clock_ms FROM enrollment_meta WHERE singleton=1')?.clock_ms;
    integer(persisted,0);
    return Math.max(observed, persisted);
  }
  private now(): number {
    const time = this.observedTime();
    this.q('UPDATE enrollment_meta SET clock_ms=? WHERE singleton=1',time); return time;
  }
  private owner(c: OwnerContext) { exact(c,['role','principal']); id(c.principal); if(c.role !== 'owner') fail('forbidden'); }
  private binding(row: Row): ExecutorBinding {
    return {role:'executor',workerId:String(row.worker_id),principal:String(row.principal),revision:Number(row.revision),incarnation:Number(row.incarnation)};
  }
  private current(workerId: string): Row | undefined {
    return this.one('SELECT c.*,w.principal,w.identity FROM enrollment_credentials c JOIN enrollment_workers w USING(worker_id) WHERE c.worker_id=? ORDER BY revision DESC LIMIT 1',workerId);
  }
  private active(row: Row | undefined, time: number): Row {
    if (!row || row.revoked_ms !== null || Number(row.expires_ms) <= time) fail('inactive-credential');
    return row!;
  }
  private executor(c: ExecutorBinding, time: number): Row {
    exact(c,['role','workerId','principal','revision','incarnation']); id(c.workerId); id(c.principal); integer(c.revision,1); integer(c.incarnation,0);
    if (c.role !== 'executor') fail('forbidden');
    const row = this.active(this.current(c.workerId),time);
    if (row.principal !== c.principal || row.revision !== c.revision || row.incarnation !== c.incarnation) fail('identity-fence');
    return row;
  }
  private replay(actor: string, operation: string, key: string, request: unknown): Row | undefined {
    const prior = this.one('SELECT request_hash,result FROM enrollment_events WHERE actor=? AND operation=? AND request_key=?',actor,operation,key);
    if (prior && prior.request_hash !== hash(request)) fail('idempotency-conflict');
    return prior ? JSON.parse(String(prior.result)) as Row : undefined;
  }
  private event(actor: string, operation: string, key: string, request: unknown, workerId: string, revision: number, time: number, result: unknown) {
    this.q('INSERT INTO enrollment_events(actor,operation,request_key,request_hash,worker_id,revision,at_ms,result) VALUES(?,?,?,?,?,?,?,?)',actor,operation,key,hash(request),workerId,revision,time,JSON.stringify(result));
  }
  private statusRow(row: Row, time: number): EnrollmentStatus {
    const inactive = row.revoked_ms !== null || Number(row.expires_ms) <= time;
    return {...this.binding(row),identity:JSON.parse(String(row.identity)),expiresAt:Number(row.expires_ms),revokedAt:row.revoked_ms as number|null,lastSeen:row.last_seen as number|null,sequence:Number(row.sequence),freshness:inactive?'inactive':row.last_seen===null?'never-seen':time-Number(row.last_seen)<this.heartbeatFreshnessMs?'fresh':'stale'};
  }
  enroll(c: OwnerContext, r: EnrollRequest): MutationResult {
    this.owner(c); exact(r,[...identityKeys,'key','tokenSha256','expiresAt','expectedRevision','incarnation']);
    const approved = identity(Object.fromEntries(identityKeys.map(k=>[k,(r as unknown as Row)[k]])));
    id(r.key); digest(r.tokenSha256); integer(r.expiresAt,1); integer(r.expectedRevision,0); integer(r.incarnation,0);
    const request = {...approved,key:r.key,tokenSha256:r.tokenSha256,expiresAt:r.expiresAt,expectedRevision:r.expectedRevision,incarnation:r.incarnation};
    return this.storage.transactionSync(() => {
      const time = this.now(), old = this.current(r.workerId), replay = this.replay(c.principal,'enroll',r.key,request);
      if (replay) {
        this.active(old,time);
        if (old!.revision !== replay.revision) fail('identity-fence');
        return {status:this.statusRow(old!,time),applied:false,replayed:true,isCurrent:true};
      }
      if ((old?.revision ?? 0) !== r.expectedRevision) fail('revision-conflict');
      if (r.expiresAt <= time) fail('invalid-expiry');
      if (old && r.incarnation <= Number(old.incarnation)) fail('incarnation-conflict');
      if (old && old.identity !== JSON.stringify(approved)) fail('immutable-approved-identity');
      if (this.one('SELECT 1 FROM enrollment_credentials WHERE digest=?',r.tokenSha256)) fail('credential-already-used');
      if (!old) this.q('INSERT INTO enrollment_workers VALUES(?,?,?)',r.workerId,r.principal,JSON.stringify(approved));
      const revision = r.expectedRevision+1; integer(revision,1);
      this.q('INSERT INTO enrollment_credentials(worker_id,revision,incarnation,digest,issued_ms,expires_ms) VALUES(?,?,?,?,?,?)',r.workerId,revision,r.incarnation,r.tokenSha256,time,r.expiresAt);
      const result = this.statusRow(this.current(r.workerId)!,time);
      this.event(c.principal,'enroll',r.key,request,r.workerId,revision,time,result);
      return {status:result,applied:true,replayed:false,isCurrent:true};
    });
  }
  revoke(c: OwnerContext, r: RevokeRequest): MutationResult {
    this.owner(c); exact(r,['key','workerId','revision']); id(r.key); id(r.workerId); integer(r.revision,1);
    return this.storage.transactionSync(() => {
      const time = this.now(), replay = this.replay(c.principal,'revoke',r.key,{workerId:r.workerId,revision:r.revision});
      const isCurrent = this.current(r.workerId)?.revision === r.revision;
      if (replay) return {status:replay as unknown as EnrollmentStatus,applied:false,replayed:true,isCurrent};
      const row = this.one('SELECT c.*,w.principal,w.identity FROM enrollment_credentials c JOIN enrollment_workers w USING(worker_id) WHERE worker_id=? AND revision=?',r.workerId,r.revision);
      if (!row) fail('unknown-credential');
      // Exactly one immutable revocation event per credential preserves the reserved capacity.
      if (row!.revoked_ms !== null) fail('already-revoked');
      this.q('UPDATE enrollment_credentials SET revoked_ms=? WHERE worker_id=? AND revision=?',time,r.workerId,r.revision);
      row!.revoked_ms = time; const result = this.statusRow(row!,time);
      this.event(c.principal,'revoke',r.key,{workerId:r.workerId,revision:r.revision},r.workerId,r.revision,time,result);
      return {status:result,applied:true,replayed:false,isCurrent};
    });
  }
  authenticateDigest(tokenSha256: string, readOnly = false): ExecutorBinding | null {
    digest(tokenSha256);
    return this.storage.transactionSync(() => {
      // Mutating executor operations retain the persisted monotonic authentication clock.
      const time = readOnly ? this.observedTime() : this.now();
      const row = this.one('SELECT c.*,w.principal FROM enrollment_credentials c JOIN enrollment_workers w USING(worker_id) WHERE digest=? AND revoked_ms IS NULL AND expires_ms>? AND revision=(SELECT max(revision) FROM enrollment_credentials WHERE worker_id=c.worker_id)',tokenSha256,time);
      return row ? this.binding(row) : null;
    });
  }
  heartbeat(c: ExecutorBinding, r: HeartbeatRequest): EnrollmentStatus {
    exact(r,['key','sequence','observedIdentity']); id(r.key); integer(r.sequence,1); const observed = identity(r.observedIdentity);
    return this.storage.transactionSync(() => {
      const time = this.now(), row = this.executor(c,time);
      if (row.identity !== JSON.stringify(observed)) fail('observed-identity-mismatch');
      const request = {binding:this.binding(row),sequence:r.sequence,observedIdentity:observed};
      const last = this.one('SELECT * FROM enrollment_liveness WHERE worker_id=? AND revision=?',c.workerId,c.revision);
      if (last?.request_key === r.key) {
        if(last.request_hash !== hash(request)) fail('idempotency-conflict');
        return JSON.parse(String(last.result)) as EnrollmentStatus;
      }
      if (r.sequence !== Number(row.sequence)+1) fail('sequence-conflict');
      if(row.last_seen !== null && time-Number(row.last_seen)<this.heartbeatMinIntervalMs) fail('heartbeat-rate-limited');
      this.q('UPDATE enrollment_credentials SET last_seen=?,sequence=? WHERE worker_id=? AND revision=?',time,r.sequence,c.workerId,c.revision);
      const result = this.statusRow(this.current(c.workerId)!,time);
      if(last) this.q('UPDATE enrollment_liveness SET sequence=?,request_key=?,request_hash=?,result=? WHERE worker_id=? AND revision=?',r.sequence,r.key,hash(request),JSON.stringify(result),c.workerId,c.revision);
      else this.q('INSERT INTO enrollment_liveness VALUES(?,?,?,?,?,?)',c.workerId,c.revision,r.sequence,r.key,hash(request),JSON.stringify(result));
      return result;
    });
  }
  /** Freshness is a liveness observation, not proof of a connection or process stop. */
  requireFresh(c: ExecutorBinding): EnrollmentStatus {
    return this.storage.transactionSync(() => {
      const time = this.now(), result = this.statusRow(this.executor(c,time),time);
      if (result.freshness !== 'fresh') fail('heartbeat-stale'); return result;
    });
  }
  status(c: OwnerContext, query: {afterWorkerId: string | null; limit: number}): {workers:EnrollmentStatus[]; observedAt:number; heartbeatFreshnessMs:number} {
    this.owner(c); exact(query,['afterWorkerId','limit']); if(query.afterWorkerId !== null) id(query.afterWorkerId); integer(query.limit,1,128);
    return this.storage.transactionSync(() => {
      const time = this.observedTime();
      const rows = this.q('SELECT c.*,w.principal,w.identity FROM enrollment_credentials c JOIN enrollment_workers w USING(worker_id) WHERE c.worker_id>? AND c.revision=(SELECT max(revision) FROM enrollment_credentials WHERE worker_id=c.worker_id) ORDER BY c.worker_id LIMIT ?',query.afterWorkerId ?? '',query.limit);
      return {workers:rows.map(row=>this.statusRow(row,time)),observedAt:time,heartbeatFreshnessMs:this.heartbeatFreshnessMs};
    });
  }
}

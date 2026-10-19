import { lstat, open, rename, mkdir, rmdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalPath } from '../../worker-runtime/src/node';
import type { HostJournal, JournalSession, JournalState } from './index';
/** A present file is evidence. Only ENOENT means absent; malformed state must not
 * reach the client's truthiness/phase dispatch or be replaced by fresh state. */
function journalState(value: unknown): JournalState {
  const need = (ok: unknown): void => {if (!ok) throw Error('invalid-journal');};
  const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  const fields = (v: unknown, required: string[], optional: string[] = []): void => {
    need(record(v)); const r = v as Record<string, unknown>;
    need(required.every(k => Object.hasOwn(r,k)) && Object.keys(r).every(k => required.includes(k) || optional.includes(k)));
  };
  const uint = (v: unknown, min = 0): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
  const key = (v: unknown): boolean => typeof v === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(v);
  const digest = (v: unknown): boolean => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  fields(value,['version','binding','stepKey','heartbeatSequence','heartbeatPending','heartbeatLastSeen',
    'heartbeatRefreshRequired','pollSequence','phase','keys','used'],['work','upload','stop','summary']);
  const s = value as JournalState;
  need(s.version === 1 && digest(s.binding) && key(s.stepKey) && uint(s.heartbeatSequence,1) && uint(s.pollSequence) &&
    typeof s.heartbeatPending === 'boolean' && typeof s.heartbeatRefreshRequired === 'boolean' &&
    (s.heartbeatLastSeen === null || uint(s.heartbeatLastSeen)) &&
    ['heartbeat','poll','ready','running','upload','done','blocked'].includes(s.phase));
  fields(s.keys,['heartbeat','poll','upload']); need(Object.values(s.keys).every(digest));
  need(Array.isArray(s.used) && s.used.length <= 1024 && s.used.every(digest) && new Set(s.used).size === s.used.length);
  if (Object.hasOwn(s,'work')) {
    fields(s.work,['profileHash','workload','lease']); const w = s.work!;
    fields(w.workload,['id','specification','resources','expectedHash','maxBytes']);
    fields(w.workload.resources,['cpu','ramMib']);
    need(digest(w.profileHash) && key(w.workload.id) && typeof w.workload.specification === 'string' &&
      Buffer.byteLength(w.workload.specification) <= 16384 && digest(w.workload.expectedHash) &&
      uint(w.workload.maxBytes,1) && w.workload.maxBytes <= 1048576 &&
      Number.isFinite(w.workload.resources.cpu) && w.workload.resources.cpu > 0 && uint(w.workload.resources.ramMib,1));
    fields(w.lease,['id','worker_id','workload_id','epoch','generation','incarnation','capability','expires_ms','state']);
    const l = w.lease;
    need(key(l.id) && key(l.worker_id) && l.workload_id === w.workload.id && uint(l.epoch,1) && uint(l.generation) &&
      uint(l.incarnation) && uint(l.expires_ms,1) && l.state === 'RUNNING' && typeof l.capability === 'string' &&
      l.capability.length > 0 && l.capability.length <= 8192);
  }
  if (Object.hasOwn(s,'stop')) {
    fields(s.stop,['identity','containerId','stopped','reason']); const stop = s.stop!;
    fields(stop.identity,['leaseId','epoch','generation','incarnation']);
    need(key(stop.identity.leaseId) && uint(stop.identity.epoch,1) && uint(stop.identity.generation) && uint(stop.identity.incarnation) &&
      (stop.containerId === null || digest(stop.containerId)) && typeof stop.stopped === 'boolean' &&
      (stop.reason === 'unknown' || stop.reason === 'inspect-stopped') &&
      (!stop.stopped || stop.reason === 'inspect-stopped' && digest(stop.containerId)));
  }
  if (Object.hasOwn(s,'upload')) {
    fields(s.upload,['expectedEpoch','key','fence','bytesBase64','exitCode']); const u = s.upload!;
    fields(u.fence,['leaseId','epoch','generation','incarnation','capability']);
    need(uint(u.expectedEpoch,1) && digest(u.key) && key(u.fence.leaseId) && uint(u.fence.epoch,1) &&
      uint(u.fence.generation) && uint(u.fence.incarnation) && typeof u.fence.capability === 'string' &&
      u.fence.capability.length > 0 && u.fence.capability.length <= 8192 && u.exitCode === 0 &&
      typeof u.bytesBase64 === 'string' && u.bytesBase64.length > 0 && u.bytesBase64.length <= 5464 &&
      Buffer.from(u.bytesBase64,'base64').toString('base64') === u.bytesBase64);
  }
  if (Object.hasOwn(s,'summary')) {
    fields(s.summary,['kind'],['code','httpStatus']); const r = s.summary!;
    need(['idle','heartbeat','uploaded','blocked','retry'].includes(r.kind) &&
      (r.code === undefined || typeof r.code === 'string') &&
      (r.httpStatus === undefined || uint(r.httpStatus,100) && r.httpStatus <= 599));
  }
  need(!['ready','running','upload'].includes(s.phase) || s.work !== undefined);
  need(s.phase !== 'running' || s.stop !== undefined);
  need(s.phase !== 'upload' || s.upload !== undefined && s.stop?.stopped === true);
  need(s.phase !== 'done' || s.summary !== undefined && ['idle','heartbeat','uploaded'].includes(s.summary.kind));
  need(s.phase !== 'blocked' || s.summary?.kind === 'blocked');
  return s;
}
/** Pre-provision an owner-only directory. Never breaks stale locks or removes run evidence.
 * One root per enrolled credential; a leftover lock requires explicit owner reconciliation. */
export class NodeHostJournal implements HostJournal {
  constructor(private readonly root: string) {}
  async exclusive<T>(run: (session: JournalSession) => Promise<T>): Promise<T> {
    await canonicalPath(this.root);
    const dir = await lstat(this.root);
    if(!dir.isDirectory() || dir.uid !== process.getuid?.() || (dir.mode & 0o077) !== 0) throw Error('journal-private-root-required');
    const lock = join(this.root,'step.lock');
    await mkdir(lock,{mode:0o700});
    const syncRoot = async () => { const h=await open(this.root,'r');try{await h.sync();}finally{await h.close();} };
    // Lock reaches durable storage before entering any caller operation.
    await syncRoot();
    const file=join(this.root,'state.json');
    let healthy=true;
    const session: JournalSession = {
      load: async () => {
        const stat = await lstat(file).catch(e => {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw e;
        });
        if (stat === null) return null;
        if(!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 1048576) throw Error('invalid-journal');
        // Once observed present, disappearance/read/parse/shape errors are rejection.
        return journalState(JSON.parse(await readFile(file,'utf8')));
      },
      save: async state => {
        try {
          const bytes=JSON.stringify(state); if(Buffer.byteLength(bytes)>1048576) throw Error('journal-full');
          const temp=join(this.root,`state-${randomUUID()}.tmp`);
          const h=await open(temp,'wx',0o600);
          try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}
          await rename(temp,file);await syncRoot();
        } catch(e) {healthy=false;throw e;}
      }
    };
    try{return await run(session);}
    finally { if(healthy){await rmdir(lock);await syncRoot();} }
  }
}

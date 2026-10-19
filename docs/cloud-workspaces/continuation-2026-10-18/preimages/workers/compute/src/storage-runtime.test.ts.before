// Platform preflight only: actual local workerd SQLite transactions and persistence.
// This does not certify the fabric authority domain invariants or deployment.
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = `
export class StorageProbe {
 constructor(ctx) {
  this.ctx = ctx;
  this.sql = ctx.storage.sql;
  this.sql.exec('CREATE TABLE IF NOT EXISTS probe (id TEXT PRIMARY KEY, value INTEGER NOT NULL)');
 }
 async fetch(request) {
  const command = new URL(request.url).pathname;
  if (command === '/write') {
   this.ctx.storage.transactionSync(() => {
    this.sql.exec('INSERT INTO probe (id,value) VALUES (?,?)', 'persisted', 7);
    this.sql.exec('INSERT INTO probe (id,value) VALUES (?,?)', 'coupled', 8);
   });
  }
  if (command === '/rollback') {
   try {
    this.ctx.storage.transactionSync(() => {
     this.sql.exec('INSERT INTO probe (id,value) VALUES (?,?)', 'must-not-exist', 99);
     throw new Error('injected rollback');
    });
   } catch {}
  }
  return Response.json(this.sql.exec('SELECT id,value FROM probe ORDER BY id').toArray());
 }
}
export default { fetch(request, env) {
 return env.PROBE.get(env.PROBE.idFromName('local-storage-preflight')).fetch(request);
}};
`;
function runtime(persistence: string) {
 const options = convertV4MiniflareOptions({
  name: "foundry-compute-storage-preflight",
  modules: true, script, compatibilityDate: '2026-10-05',
  durableObjects: { PROBE: { className: 'StorageProbe', useSQLite: true } },
 });
 return new Miniflare({...options,resourcePersistencePath:persistence});
}
describe('real local SQLite Durable Object preflight',()=>{
 it('rolls back a failed transaction and retains committed rows across runtime recreation',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'foundry-do-preflight-'));
  let mf:Miniflare|undefined;
  try {
   mf=runtime(dir);
   const written=await mf.dispatchFetch('https://local.test/write');
   expect(written.status).toBe(200);
   expect(await written.json()).toEqual([{id:'coupled',value:8},{id:'persisted',value:7}]);
   const rolled=await mf.dispatchFetch('https://local.test/rollback');
   expect(await rolled.json()).toEqual([{id:'coupled',value:8},{id:'persisted',value:7}]);
   await mf.dispose();mf=runtime(dir);
   const restarted=await mf.dispatchFetch('https://local.test/read');
   expect(await restarted.json()).toEqual([{id:'coupled',value:8},{id:'persisted',value:7}]);
  } finally {
   await mf?.dispose();
   // This directory is created only by this test; never any project or session data.
   await rm(dir,{recursive:true,force:true});
  }
 },30000);
});

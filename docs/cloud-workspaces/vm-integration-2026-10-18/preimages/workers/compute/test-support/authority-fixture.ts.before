/** Test-only frontdoor and instrumentation. Never imported by production entry. */
export const authorityFixture = `
import { DurableObject } from 'cloudflare:workers';
import { DurableAuthority } from './packages/compute-authority/src/durable/authority.ts';

export class TestFabricAuthority extends DurableObject {
 constructor(ctx, env) {
  super(ctx, env);
  this.ctx = ctx; this.env = env; this.now = 1000000;
  this.inTransaction = false; this.failNextOutbox = false; this.artifactReads = 0;
  const storage = {
   sql: {exec: (query, ...bindings) => {
    const cursor = ctx.storage.sql.exec(query, ...bindings);
    if (this.failNextOutbox && /INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO\\s+outbox\\b/i.test(query)) {
     this.failNextOutbox = false; throw new Error('injected local outbox fault');
    }
    return cursor;
   }},
   transactionSync: (callback) => ctx.storage.transactionSync(() => {
    this.inTransaction = true;
    try {return callback();} finally {this.inTransaction = false;}
   }),
  };
  this.core = new DurableAuthority(storage, {
   environment: 'local-test', authorityId: ctx.id.toString(),
   issuerId: 'local-fixture-issuer',
   issuerKey: 'fixture-only-issuer-key-not-a-production-credential-0001',
   now: () => this.now, maxLeaseLifetimeMs: 60000, verificationDeadlineMs: 120000,
   readArtifact: async (reference, maxBytes) => {
    if (this.inTransaction) throw new Error('artifact I/O inside SQL transaction');
    this.artifactReads++;
    if(this.pauseRead) await new Promise(resolve => {this.resumeRead=resolve;});
    const value = await env.TEST_ARTIFACTS.get(reference);
    if (!value || value.size > maxBytes) throw new Error('artifact unavailable or oversized');
    return new Uint8Array(await value.arrayBuffer());
   },
  });
 }
 execute(actor, command) {return this.core.execute(actor, command);}
 snapshot() {return this.core.snapshot();}
 async verify(actor, request) {return this.core.verifyAndFinalize(actor, request);}
 configure(value) {
  if (value.pauseRead !== undefined) this.pauseRead=value.pauseRead;
  if (value.releaseRead && this.resumeRead) {this.pauseRead=false;this.resumeRead();this.resumeRead=undefined;}
  if (value.now !== undefined) this.now = value.now;
  if (value.failNextOutbox !== undefined) this.failNextOutbox = value.failNextOutbox;
  return {artifactReads:this.artifactReads};
 }
 dump(table) {
  if (!['authority_meta','quotas','workers','devices','workloads','placements','attempts','leases','reservations','device_reservations','artifacts','receipts','commands','renewals','requeues','stop_receipts','events','outbox'].includes(table)) throw new Error('invalid test table');
  return this.ctx.storage.sql.exec('SELECT * FROM '+table).toArray();
 }
}

export default {async fetch(request, env) {
 const input = await request.json();
 const stub = env.AUTHORITY.get(env.AUTHORITY.idFromName(input.instance || 'local-authority'));
 if (input.action === 'stageArtifact') {
  const bytes = new Uint8Array(input.bytes);
  if (bytes.length > 4194304) return Response.json({error:'oversized'}, {status:400});
  const hashBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const reference = Array.from(hashBytes).map(x=>x.toString(16).padStart(2,'0')).join('');
  await env.TEST_ARTIFACTS.put(reference, bytes);
  return Response.json({reference});
 }
 try {
  if (input.action === 'configure') return Response.json(await stub.configure(input.value));
  if (input.action === 'snapshot') return Response.json(await stub.snapshot());
  if (input.action === 'dump') return Response.json(await stub.dump(input.table));
  if (input.action === 'verify') return Response.json(await stub.verify(input.actor,input.request));
  return Response.json(await stub.execute(input.actor,input.command));
 } catch {return Response.json({ok:false,code:'FIXTURE_EXCEPTION'}, {status:500});}
}};
`;

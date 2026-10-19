import {describe,it,expect} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {checkpointStore,type CheckpointScope} from '../../../packages/library-checkpoint/src/index';
import {recoveryReconciler} from '../../../packages/library-checkpoint/src/reconcile';
import {withResilience,type ResilienceFixture} from '../test-support/resilience';
function setup(h:ResilienceFixture){
 let db=new DatabaseSync(join(h.directory,'checkpoint.sqlite'));
 const port={sql:{exec:(q:string,...b:(string|number|null)[])=>db.prepare(q).all(...b) as any},transactionSync:<T>(fn:()=>T):T=>{db.exec('BEGIN IMMEDIATE');try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}}};
 const scope:CheckpointScope={environment:'local',authorityId:'checkpoint',catalogAuthorityId:h.catalogId,sourceAuthorityId:h.sourceId,relayAuthorityId:'relay',projectId:'project-a',policyVersion:h.binding.policyVersion,policyHash:h.binding.policyHash,ownerPrincipal:'checkpoint-owner'};
 let store=checkpointStore(port,scope,()=>h.clock);const ctx={environment:'local',principal:'checkpoint-owner',role:'owner' as const};
 const callback=()=>recoveryReconciler(scope,{checkpoint:store.recovery,relay:h.relay,owner:h.owner,dispatcher:h.dispatcher,source:h.sourceHttp(),now:()=>h.clock});
 return {scope,get store(){return store;},approve(pin:string|null){return store.admin.execute(ctx,{key:'approve-'+(store.reader.latest().revision+1),expectedRevision:store.reader.latest().revision,archiveSha256:pin,reason:'explicit local fixture approval'});},bind(){h.recoveryHost=callback();},restart(){db.close();db=new DatabaseSync(join(h.directory,'checkpoint.sqlite'));store=checkpointStore(port,scope,()=>h.clock);h.recoveryHost=callback();},close(){db.close();}};
}
const status=async(h:ResilienceFixture)=>(await h.req('/v1/library/project-a/recovery-status')).body;
const reconcile=(h:ResilienceFixture)=>h.req('/v1/library/project-a/reconcile-recovery');
describe('independent checkpoint + actual compute feed + persistent relay + restored workerd',()=>{
 it('reconciles an explicitly approved archive using authenticated actual fence observations and retained targets',()=>withResilience(async h=>{
  const c=setup(h);try{const backup=(await h.req('/v1/library/project-a/export')).body;c.approve(backup.sha256);c.bind();expect((await h.restoreCatalog(backup.archive,backup.sha256)).status).toBe(200);
   expect((await status(h)).quarantined).toBe(true);expect((await reconcile(h)).status).toBe(200);expect((await status(h)).quarantined).toBe(false);
   const snapshot=h.relay.snapshot(h.owner);expect(snapshot.targets).toHaveLength(1);expect(snapshot.targets[0].generation).toBe(1);expect(snapshot.cursor).toBeGreaterThan(0);
   await h.cancel();for(let n=0;n<3;n++)await h.step();expect((await h.req('/v1/library/project-a/snapshot')).body.records.some((r:any)=>r.kind==='cancellation')).toBe(true);
   await h.restartRestoredCatalog();expect((await status(h)).quarantined).toBe(false);
  }finally{c.close();}
 }));
 it('refuses an older backup after a surviving relay already acknowledged cancellation and a newer checkpoint was approved',()=>withResilience(async h=>{
  const c=setup(h);try{const old=(await h.req('/v1/library/project-a/export')).body;h.register();await h.issue();await h.cancel();for(let n=0;n<5;n++)await h.step();
   expect(h.relay.snapshot(h.owner).deliveries.filter(d=>d.state==='acked')).toHaveLength(2);
   const latest=(await h.req('/v1/library/project-a/export')).body;expect(latest.sha256).not.toBe(old.sha256);c.approve(latest.sha256);h.restartRelay();c.restart();
   expect((await h.restoreCatalog(old.archive,old.sha256)).status).toBe(200);expect((await reconcile(h)).status).not.toBe(200);expect((await status(h)).quarantined).toBe(true);await h.restartRestoredCatalog();expect((await status(h)).quarantined).toBe(true);
  }finally{c.close();}
 }));
 it('cancels an invalid restored attempt even when its archive is the approved checkpoint and prior cancellation was ACKed',()=>withResilience(async h=>{
  const c=setup(h);try{const old=(await h.req('/v1/library/project-a/export')).body;c.approve(old.sha256);h.register();await h.issue();await h.cancel();for(let n=0;n<5;n++)await h.step();h.restartRelay();c.restart();
   expect((await h.restoreCatalog(old.archive,old.sha256)).status).toBe(200);expect((await reconcile(h)).status).toBe(200);const s=(await h.req('/v1/library/project-a/snapshot')).body;expect(s.records.some((r:any)=>r.kind==='cancellation'&&r.body.reason==='recovery-current-fence-invalid')).toBe(true);
   expect(h.relay.snapshot(h.owner).targets).toHaveLength(3);expect((await status(h)).quarantined).toBe(false);
  }finally{c.close();}
 }));
 it('fails closed without approval, after withdrawal, or while compute is unavailable',()=>withResilience(async h=>{
  const c=setup(h);try{const b=(await h.req('/v1/library/project-a/export')).body;c.bind();await h.restoreCatalog(b.archive,b.sha256);expect((await reconcile(h)).status).not.toBe(200);expect((await status(h)).quarantined).toBe(true);
   c.approve(b.sha256);h.sourceOffline=true;expect((await reconcile(h)).status).not.toBe(200);expect((await status(h)).quarantined).toBe(true);h.sourceOffline=false;c.approve(null);expect((await reconcile(h)).status).not.toBe(200);expect((await status(h)).quarantined).toBe(true);
  }finally{c.close();}
 }));
 it('preserves an independently verified result when success quarantines the worker',()=>withResilience(async h=>{
  const c=setup(h);try{expect((await h.complete()).status).toBe(200);const b=(await h.req('/v1/library/project-a/export')).body;c.approve(b.sha256);c.bind();await h.restoreCatalog(b.archive,b.sha256);expect((await reconcile(h)).status).toBe(200);expect((await h.req('/v1/library/project-a/snapshot')).body.records.some((r:any)=>r.kind==='cancellation')).toBe(false);
  }finally{c.close();}
 }));
});

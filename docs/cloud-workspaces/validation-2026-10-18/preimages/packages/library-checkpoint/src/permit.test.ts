import {describe,it,expect,vi} from 'vitest';
import {checkpointStore} from './index';
import {recoveryReconciler} from './reconcile';
import {setup,sqlite,scope,owner,command,H,challenge,page,observation,targetId,binding,deferred} from './test-support';
import {canonical,sha256} from '../../library-jobs/src/data';
import {LibraryCatalog} from '../../library-catalog/src/catalog';
import {markRestored,recoveryChallenge,finishRecovery,recoveryStatus} from '../../../workers/library/src/recovery-guard';
const signal=()=>new AbortController().signal;
function guardFixture(){const h=setup(),db=sqlite(),context={environment:'test',authorityId:'catalog',projectId:'project',principal:'owner',role:'owner' as const};const catalog=new LibraryCatalog(db.port,{environment:context.environment,authorityId:context.authorityId,projectId:context.projectId,policy:{version:'p1',ownerPrincipal:'owner',writerPrincipal:'writer',verifierPrincipal:'verifier'},now:h.now});catalog.execute({...context,principal:'writer',role:'writer'},{operation:'stageTransfer',key:'stage',body:{version:1,intentId:'intent',binding:binding(),expiresAt:10000}});markRestored(db.port,H);const request=recoveryChallenge(db.port,catalog,context);return {...h,db,context,catalog,request,finish:(p:unknown)=>finishRecovery(db.port,catalog,context,request,p,h.now())};}
describe('durable bounded recovery approval permit',()=>{
 it('retains scope/revision/archive/restore/challenge identity and immutable issuance across reopen',()=>{
  const h=setup(),c=challenge(),request={expectedRevision:1,restoreId:c.restoreId,archiveSha256:H,challengeSha256:sha256(canonical(c)),expiresAt:1100};const a=h.store.recovery.issuePermit(request);expect(a).toMatchObject({version:1,authorityId:scope.authorityId,revision:1,issuedAt:100,expiresAt:1100,restoreId:c.restoreId});
  expect(checkpointStore(h.checkpointDb.port,scope,h.now).recovery.issuePermit(request)).toEqual(a);
  for(const q of ["DELETE FROM library_checkpoint_permits","UPDATE library_checkpoint_permits SET content='{}'","INSERT OR REPLACE INTO library_checkpoint_permits SELECT * FROM library_checkpoint_permits"])expect(()=>h.checkpointDb.db.exec(q)).toThrow();
 });
 it.each([{expectedRevision:0},{archiveSha256:'b'.repeat(64)},{expiresAt:100},{expiresAt:1101},{challengeSha256:'bad'},{restoreId:''}])('rejects invalid issuance %j',delta=>{const h=setup(),c=challenge();expect(()=>h.store.recovery.issuePermit({expectedRevision:1,restoreId:c.restoreId,archiveSha256:H,challengeSha256:sha256(canonical(c)),expiresAt:1100,...delta})).toThrow();expect(h.checkpointDb.db.prepare('SELECT count(*) n FROM library_checkpoint_permits').get()).toEqual({n:0});});
 it('withdrawal stops new issuance while an already issued one-second permit remains valid until its deadline',async()=>{
  const h=guardFixture(),proof=await recoveryReconciler(scope,h.ports)(h.request,signal());h.store.admin.execute(owner,command('withdraw',1,null));
  expect(()=>h.store.recovery.issuePermit({expectedRevision:1,restoreId:h.request.restoreId,archiveSha256:H,challengeSha256:sha256(canonical(h.request)),expiresAt:1100})).toThrow('CHECKPOINT_PERMIT_APPROVAL');
  expect(h.finish(proof)).toMatchObject({ready:true});expect(h.store.reader.latest().archiveSha256).toBe(null);
 });
 it('rejects the issued permit at the deadline and keeps quarantine closed',async()=>{const h=guardFixture(),proof=await recoveryReconciler(scope,h.ports)(h.request,signal());h.time(proof.approval.expiresAt);expect(()=>h.finish(proof)).toThrow('RECOVERY_PERMIT_EXPIRED_OR_MISMATCH');expect(recoveryStatus(h.db.port).quarantined).toBe(true);});
 it('bounds current-fence application by its actual expiry',async()=>{const h=guardFixture();h.source.observe.mockImplementation(async b=>observation({binding:b,expiresAt:101}));const proof=await recoveryReconciler(scope,h.ports)(h.request,signal());expect(proof.approval.expiresAt).toBe(101);h.time(102);expect(()=>h.finish(proof)).toThrow('RECOVERY_PERMIT_EXPIRED_OR_MISMATCH');expect(recoveryStatus(h.db.port).quarantined).toBe(true);});
 it('does not apply active lease expiry to independently accepted results',async()=>{const h=guardFixture();h.source.observe.mockImplementation(async b=>observation({binding:b,current:false,accepted:true,state:'SUCCEEDED',expiresAt:1}));const proof=await recoveryReconciler(scope,h.ports)(h.request,signal());expect(proof.approval.expiresAt).toBe(1100);h.time(200);expect(h.finish(proof)).toMatchObject({ready:true});});
 it.each(['restoreId','archiveSha256','challengeSha256','authorityId','permitId'])('rejects malformed or mismatched permit %s',async key=>{const h=guardFixture(),proof=await recoveryReconciler(scope,h.ports)(h.request,signal());(proof.approval as any)[key]=key==='authorityId'?'invalid space':'bad';expect(()=>h.finish(proof)).toThrow();expect(recoveryStatus(h.db.port).quarantined).toBe(true);});
 it('preserves a final withdrawal slot after ordinary approval capacity is exhausted',()=>{const h=setup(false);for(let n=0;n<1023;n++)h.store.admin.execute(owner,command('approve-'+n,n));expect(()=>h.store.admin.execute(owner,command('overflow',1023))).toThrow();expect(h.store.admin.execute(owner,command('terminal-withdrawal',1023,null))).toMatchObject({revision:1024,archiveSha256:null});expect(()=>h.store.admin.execute(owner,command('rollover',1024))).toThrow();});
 it('bounds permit retention without losing the ability to withdraw',()=>{const h=setup(),c=challenge();for(let n=0;n<1024;n++)h.store.recovery.issuePermit({expectedRevision:1,restoreId:'restore-'+n,archiveSha256:H,challengeSha256:sha256(canonical(c)),expiresAt:1100});expect(()=>h.store.recovery.issuePermit({expectedRevision:1,restoreId:'overflow',archiveSha256:H,challengeSha256:sha256(canonical(c)),expiresAt:1100})).toThrow();expect(h.store.admin.execute(owner,command('withdraw',1,null)).archiveSha256).toBe(null);});
 it('fails synchronous dispatcher preflight without starting a timeout or orphan rejection',async()=>{vi.useFakeTimers();const h=setup(),r=recoveryReconciler(scope,{...h.ports,dispatcher:{...h.ports.dispatcher,principal:'wrong'}});await expect(r(challenge(),signal())).rejects.toThrow('PERMISSION');expect(vi.getTimerCount()).toBe(0);});
 it('fails initial watermark storage without starting a timeout',async()=>{vi.useFakeTimers();const h=setup();h.relayDb.fail('SELECT * FROM library_revoke_meta');await expect(recoveryReconciler(scope,h.ports)(challenge(),signal())).rejects.toThrow('injected SQLite failure');expect(vi.getTimerCount()).toBe(0);});
 it('observes32 checks with four bounded lanes under40ms source latency',async()=>{
  vi.useFakeTimers();const h=setup(),start=Date.now();h.ports.now=()=>100+Date.now()-start;
  const store=checkpointStore(h.checkpointDb.port,scope,h.ports.now);h.ports.checkpoint=store.recovery;
  const c=challenge();c.checks=Array.from({length:32},(_,i)=>({...c.checks[0],intentId:'i-'+i,targetId:targetId('i-'+i)}));let active=0,max=0;
  h.source.observe.mockImplementation(async b=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,40));active--;return observation({binding:b,observedAt:h.ports.now()});});
  const pending=recoveryReconciler(scope,h.ports)(c,signal());await vi.advanceTimersByTimeAsync(400);const proof=await pending;expect(proof.checks).toHaveLength(32);expect(max).toBe(4);expect(proof.observedAt).toBeLessThan(1100);
 });
 it('retains admission until all concurrent observations settle after one fails',async()=>{
  vi.useFakeTimers();const h=setup(),c=challenge();c.checks.push({...c.checks[0],intentId:'two',targetId:targetId('two')});const held=deferred<unknown>();h.source.observe.mockRejectedValueOnce(new Error('source failure')).mockReturnValueOnce(held.promise);
  const r=recoveryReconciler(scope,h.ports),pending=r(c,signal()).catch(e=>e.message);await vi.advanceTimersByTimeAsync(4001);expect(await pending).toBe('RECONCILER_ABORTED');await expect(r(c,signal())).rejects.toThrow('BUSY');held.resolve(observation());await vi.advanceTimersByTimeAsync(1);
 });
 it('handles reordered epoch/head responses then catches up and invalidates old attempts',async()=>{
  vi.useFakeTimers();const h=setup(),c=challenge();c.checks.push({...c.checks[0],intentId:'two',targetId:targetId('two')});let calls=0;
  h.source.readPage.mockImplementation(async after=>after===0&&calls>0?page(0,{epoch:2,head:1,through:1,events:[{seq:1,kind:'epoch-bumped',epoch:2,leaseId:null,workloadId:null,workerId:null,generation:null,incarnation:null}]}):page(after,{epoch:after?2:1}));
  h.source.observe.mockImplementation(async b=>{const n=calls++;if(n===0){await new Promise(r=>setTimeout(r,20));return observation({binding:b});}return observation({binding:b,epoch:2,head:1,current:false,state:'MISMATCH'});});
  const pending=recoveryReconciler(scope,h.ports)(c,signal());await vi.advanceTimersByTimeAsync(30);const proof=await pending;expect(proof.checks.map(x=>x.valid)).toEqual([false,false]);expect(h.relay.sourceWatermark(h.ports.dispatcher)).toEqual({head:1,epoch:2});expect(h.relay.cursor(h.ports.dispatcher)).toBe(1);
 });

 it.each([{current:true,accepted:true},{observedAt:101},{observedAt:100,expiresAt:99}])('does not let a malformed concurrent high-water reply poison a valid sibling: %j',async delta=>{
  const h=setup(),c=challenge();c.checks.push({...c.checks[0],intentId:'two',targetId:targetId('two')});h.source.observe.mockResolvedValueOnce(observation({head:9,...delta})).mockResolvedValueOnce(observation());
  const r=recoveryReconciler(scope,h.ports);await expect(r(c,signal())).rejects.toThrow();expect(h.relay.sourceWatermark(h.ports.dispatcher)).toEqual({head:0,epoch:1});expect((await r(c,signal())).checks.every(x=>x.valid)).toBe(true);
 });

});

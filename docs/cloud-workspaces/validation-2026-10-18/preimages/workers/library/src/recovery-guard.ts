import {createHash,randomUUID} from 'node:crypto';
import {canonical} from '../../../packages/library-jobs/src/data';
import {fields,hash,integer,identifier} from '../../../packages/library-catalog/src/validation';
import {LibraryCatalog} from '../../../packages/library-catalog/src/catalog';
import {LibraryRejected,type TransactionPort,type LibraryContext,type TransferBinding} from '../../../packages/library-catalog/src/types';
export interface RecoveryCheck {intentId:string;generation:number;binding:TransferBinding;targetId:string}
export interface RecoveryChallenge {restoreId:string;archiveSha256:string;checks:RecoveryCheck[]}
export interface RecoveryPermit {version:1;authorityId:string;revision:number;restoreId:string;archiveSha256:string;challengeSha256:string;issuedAt:number;expiresAt:number;permitId:string}
export interface RecoveryProof {approval:RecoveryPermit;restoreId:string;approvedArchiveSha256:string;observedAt:number;checks:(RecoveryCheck&{valid:boolean;sourceHead:number;relayCursor:number})[]}
const sha=(x:unknown)=>createHash('sha256').update(canonical(x)).digest('hex');
/** Sidecar is deliberately outside catalog archives: every import starts quarantined. */
export function markRestored(port:TransactionPort,archiveSha256:string){
 port.sql.exec("CREATE TABLE library_restore_guard(id INTEGER PRIMARY KEY CHECK(id=1),restore_id TEXT NOT NULL,archive_sha256 TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('quarantined','ready')),proof TEXT)");
 port.sql.exec("CREATE TRIGGER library_restore_identity BEFORE UPDATE ON library_restore_guard WHEN NEW.id!=OLD.id OR NEW.restore_id!=OLD.restore_id OR NEW.archive_sha256!=OLD.archive_sha256 OR OLD.phase='ready' BEGIN SELECT RAISE(ABORT,'immutable recovery identity'); END");
 for(const op of ['DELETE','INSERT'])port.sql.exec(`CREATE TRIGGER library_restore_${op.toLowerCase()} BEFORE ${op} ON library_restore_guard WHEN EXISTS(SELECT 1 FROM library_restore_guard) BEGIN SELECT RAISE(ABORT,'retained recovery guard'); END`);
 const restoreId=randomUUID();port.sql.exec("INSERT INTO library_restore_guard VALUES(1,?,?,'quarantined',NULL)",restoreId,archiveSha256);return restoreId;
}
export function recoveryStatus(port:TransactionPort){
 const exists=[...port.sql.exec("SELECT name FROM sqlite_master WHERE name='library_restore_guard'")];if(!exists.length)return {quarantined:false,restoreId:null,archiveSha256:null};
 const row=[...port.sql.exec('SELECT * FROM library_restore_guard WHERE id=1')][0];
 if(!row||!['quarantined','ready'].includes(String(row.phase)))throw new LibraryRejected('RECOVERY_GUARD_INVALID',409);
 return {quarantined:row.phase==='quarantined',restoreId:String(row.restore_id),archiveSha256:String(row.archive_sha256)};
}
export function recoveryChallenge(port:TransactionPort,catalog:LibraryCatalog,context:LibraryContext):RecoveryChallenge{
 const status=recoveryStatus(port);if(!status.quarantined||!status.restoreId||!status.archiveSha256)throw new LibraryRejected('RECOVERY_NOT_QUARANTINED',409);
 const state=catalog.snapshot(context);
 const checks:RecoveryCheck[]=[];
 for(const intent of state.records.filter(r=>r.kind==='intent')){
  if(state.policyRevoked||state.records.some(r=>r.kind==='cancellation'&&r.id===intent.id))continue;
  const authorization=state.records.filter(r=>r.kind==='authorization'&&r.body.intentId===intent.id).at(-1)!.body;
  const generation=Number(authorization.generation),binding=authorization.binding as TransferBinding;
  const targetId=sha({domain:'library-recovery-target/v1',restoreId:status.restoreId,authorityId:context.authorityId,intentId:intent.id,generation});
  checks.push({intentId:intent.id,generation,binding,targetId});
 }
 return {restoreId:status.restoreId,archiveSha256:status.archiveSha256,checks};
}
/** The host supplies an independent latest-approved archive checkpoint and current observations.
 * Body-supplied labels cannot clear this guard. No reconciler means no activation. */
export function finishRecovery(port:TransactionPort,catalog:LibraryCatalog,context:LibraryContext,challenge:RecoveryChallenge,input:unknown,now:number){
 const p=JSON.parse(canonical(input)) as RecoveryProof;fields(p,['approval','restoreId','approvedArchiveSha256','observedAt','checks']);hash(p.approvedArchiveSha256);integer(p.observedAt);integer(now);
 const a=p.approval;fields(a,['version','authorityId','revision','restoreId','archiveSha256','challengeSha256','issuedAt','expiresAt','permitId']);identifier(a.authorityId);integer(a.revision);integer(a.issuedAt);integer(a.expiresAt);hash(a.permitId);hash(a.archiveSha256);hash(a.challengeSha256);
 if(a.version!==1||a.revision<1||a.restoreId!==challenge.restoreId||a.archiveSha256!==challenge.archiveSha256||a.challengeSha256!==sha(challenge)||a.issuedAt!==p.observedAt||a.issuedAt>now||a.expiresAt<=now||a.expiresAt<=a.issuedAt||a.expiresAt-a.issuedAt>1000)throw new LibraryRejected('RECOVERY_PERMIT_EXPIRED_OR_MISMATCH',409);
 if(p.restoreId!==challenge.restoreId||p.approvedArchiveSha256!==challenge.archiveSha256)throw new LibraryRejected('RECOVERY_CHECKPOINT_MISMATCH',409);
 if(p.observedAt>now||now-p.observedAt>5000||!Array.isArray(p.checks)||p.checks.length!==challenge.checks.length)throw new LibraryRejected('RECOVERY_PROOF_STALE',409);
 for(let n=0;n<p.checks.length;n++){
  const item=p.checks[n];fields(item,['intentId','generation','binding','targetId','valid','sourceHead','relayCursor']);const {valid,sourceHead,relayCursor,...binding}=item;integer(sourceHead);integer(relayCursor);
  if(typeof valid!=='boolean'||relayCursor<sourceHead||canonical(binding)!==canonical(challenge.checks[n]))throw new LibraryRejected('RECOVERY_PROOF_BINDING',409);
 }
 return port.transactionSync(()=>{
  if(canonical(recoveryChallenge(port,catalog,context))!==canonical(challenge))throw new LibraryRejected('RECOVERY_STATE_CHANGED',409);
  for(const item of p.checks)if(!item.valid)catalog.execute(context,{operation:'cancelTransfer',key:'sys-revoke-'+sha([challenge.restoreId,item.intentId]),body:{version:1,intentId:item.intentId,reason:'recovery-current-fence-invalid'}});
  port.sql.exec("UPDATE library_restore_guard SET phase='ready',proof=? WHERE id=1 AND phase='quarantined'",canonical(p));
  return {ready:true,restoreId:challenge.restoreId};
 });
}

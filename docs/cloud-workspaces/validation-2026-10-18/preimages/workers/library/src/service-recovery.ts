import {exportCatalog,importCatalog,archiveSha256,MAX_ARCHIVE_BYTES,type RecoveryBinding,type RecoveryDestinationPort} from '../../../packages/library-recovery/src/index';
import {LibraryRejected,type LibraryContext,type TransactionPort} from '../../../packages/library-catalog/src/types';
import {exportDeliveryJournal,restoreDeliveryJournal} from './delivery-journal';
import {markRestored} from './recovery-guard';
/** Service archive adds durable delivery outcomes; restore guard is always regenerated closed. */
export function exportService(port:TransactionPort,binding:RecoveryBinding,c:LibraryContext){
 return port.transactionSync(()=>{
  const catalog=exportCatalog(port,binding,c);
  const archive=JSON.stringify({format:'foundry-library-service-recovery-v1',catalog:catalog.archive,deliveries:exportDeliveryJournal(port)});
  if(Buffer.byteLength(archive)>MAX_ARCHIVE_BYTES)throw new LibraryRejected('SERVICE_ARCHIVE_BUDGET',400);
  return {archive,sha256:archiveSha256(archive)};
 });
}
export function importService(port:RecoveryDestinationPort,binding:RecoveryBinding,c:LibraryContext,archive:string,pin:string){
 if(typeof archive!=='string'||Buffer.byteLength(archive)>MAX_ARCHIVE_BYTES)throw new LibraryRejected('SERVICE_ARCHIVE_BUDGET',400);
 if(archiveSha256(archive)!==pin)throw new LibraryRejected('RECOVERY_ARCHIVE_DIGEST',400);
 const a=JSON.parse(archive);
 if(!a||typeof a!=='object'||Array.isArray(a)||Object.keys(a).sort().join(',')!=='catalog,deliveries,format'||a.format!=='foundry-library-service-recovery-v1'||typeof a.catalog!=='string'||JSON.stringify(a)!==archive)throw new LibraryRejected('SERVICE_ARCHIVE_FORMAT',400);
 return port.transactionSync(()=>{
  const result=importCatalog(port,binding,c,a.catalog,archiveSha256(a.catalog));
  restoreDeliveryJournal(port,a.deliveries,c);
  const restoreId=markRestored(port,pin);
  return {...result,archiveSha256:pin,quarantined:true,restoreId};
 });
}

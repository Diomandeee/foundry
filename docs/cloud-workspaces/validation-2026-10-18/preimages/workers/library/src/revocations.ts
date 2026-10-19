import {deliveryReply,saveDeliveryReply} from './delivery-journal';
import {createHash} from 'node:crypto';
import {canonical} from '../../../packages/library-jobs/src/data';
import {fields,hash,integer,validateBinding} from '../../../packages/library-catalog/src/validation';
import {LibraryRejected,type LibraryContext,type TransactionPort} from '../../../packages/library-catalog/src/types';
import {LibraryCatalog} from '../../../packages/library-catalog/src/catalog';
import {eventCheck,applies,type Delivery,type DeliveryReceipt} from '../../../packages/library-revocation/src/index';
/** Called only after project-owner HTTP authentication. No remote callback supplies its actor. */
export function applyCatalogRevocation(port:TransactionPort,catalog:LibraryCatalog,context:LibraryContext,input:unknown):DeliveryReceipt{
 if(context.role!=='owner')throw new LibraryRejected('PERMISSION',403);
 const d=JSON.parse(canonical(input)) as Delivery;
 fields(d,['version','deliveryId','revision','target','event','evidenceId','key']);hash(d.deliveryId);hash(d.evidenceId);hash(d.key);integer(d.revision);
 if(d.version!==1||d.revision<1||d.key!==d.deliveryId)throw new LibraryRejected('INVALID_DELIVERY',400);
 const t=d.target;fields(t,['version','targetId','kind','environment','authorityId','projectId','resourceId','generation','binding']);integer(t.generation);validateBinding(t.binding,context.projectId,t.binding.policyVersion);eventCheck(d.event);
 if(t.version!==1||t.kind!=='catalog'||t.generation<1||t.environment!==context.environment||t.authorityId!==context.authorityId||t.projectId!==context.projectId||!applies(d.event,t))throw new LibraryRejected('DELIVERY_BINDING',409);
 const expected=createHash('sha256').update(canonical({source:t.binding.compute.authorityId,event:d.event})).digest('hex');
 if(d.evidenceId!==expected)throw new LibraryRejected('EVIDENCE_BINDING',409);
 const reply=(status:DeliveryReceipt['status']):DeliveryReceipt=>({version:1,deliveryId:d.deliveryId,evidenceId:d.evidenceId,targetId:t.targetId,status});
 return port.transactionSync(()=>{
  const cached=deliveryReply(port,context,d);if(cached)return cached;
  const terminal=(status:DeliveryReceipt['status'])=>saveDeliveryReply(port,context,d,reply(status));
  const snapshot=catalog.snapshot(context),records=snapshot.records;
  if(!records.some(r=>r.kind==='intent'&&r.id===t.resourceId))throw new LibraryRejected('TARGET_ABSENT',409);
  const a=records.filter(r=>r.kind==='authorization'&&r.body.intentId===t.resourceId).at(-1)?.body;
  if(!a)throw new LibraryRejected('TARGET_ABSENT',409);
  if(snapshot.policyRevoked||records.some(r=>r.kind==='cancellation'&&r.id===t.resourceId))return terminal('already-revoked');
  const generation=Number(a.generation);
  if(generation<t.generation)throw new LibraryRejected('TARGET_GENERATION',409);
  if(generation===t.generation&&canonical(a.binding)!==canonical(t.binding))throw new LibraryRejected('TARGET_BINDING',409);
  if(generation>t.generation&&!applies(d.event,{...t,binding:a.binding as typeof t.binding}))return terminal('superseded');
  // A successor reusing the same revoked compute fence is also invalid. The check
  // and cancellation share one target transaction; a different attempt is spared.
  catalog.execute(context,{operation:'cancelTransfer',key:'sys-revoke-'+d.key,body:{version:1,intentId:t.resourceId,reason:'compute-revocation:'+d.evidenceId}});
  return terminal('revoked');
 });
}

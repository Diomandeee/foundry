import {createHash} from 'node:crypto';
import {canonical} from '../../../packages/library-jobs/src/data';
import {LibraryRejected,type TransactionPort,type LibraryContext} from '../../../packages/library-catalog/src/types';
import type {Delivery,DeliveryReceipt} from '../../../packages/library-revocation/src/types';
const ddl=[
 "CREATE TABLE library_delivery_receipts(id TEXT PRIMARY KEY,digest TEXT NOT NULL,context TEXT NOT NULL CHECK(length(CAST(context AS BLOB))<=2048),request TEXT NOT NULL CHECK(length(CAST(request AS BLOB))<=8192),reply TEXT NOT NULL CHECK(length(CAST(reply AS BLOB))<=1024),control INTEGER NOT NULL CHECK(control IN (0,1)))",
 ...['UPDATE','DELETE'].map(op=>`CREATE TRIGGER library_delivery_${op.toLowerCase()} BEFORE ${op} ON library_delivery_receipts BEGIN SELECT RAISE(ABORT,'immutable delivery receipt'); END`),
 "CREATE TRIGGER library_delivery_replace BEFORE INSERT ON library_delivery_receipts WHEN EXISTS(SELECT 1 FROM library_delivery_receipts WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'immutable delivery identity'); END",
 "CREATE TRIGGER library_delivery_capacity BEFORE INSERT ON library_delivery_receipts WHEN (SELECT count(*) FROM library_delivery_receipts WHERE control=NEW.control)>=CASE NEW.control WHEN 1 THEN 32 ELSE 256 END BEGIN SELECT RAISE(ABORT,'delivery receipt capacity'); END",
];
function ensure(port:TransactionPort){const objects=[...port.sql.exec("SELECT name,sql FROM sqlite_master WHERE name='library_delivery_receipts' OR name GLOB 'library_delivery_*'")];if(objects.length){if(objects.length!==ddl.length||!ddl.every(sql=>objects.some(r=>r.name===sql.split(' ')[2].split('(')[0]&&r.sql===sql)))throw new LibraryRejected('DELIVERY_JOURNAL_SCHEMA',409);}else for(const sql of ddl)port.sql.exec(sql);}
const digest=(c:unknown,d:unknown)=>{const {revision,...command}=d as Delivery;return createHash('sha256').update(canonical({context:c,delivery:command})).digest('hex');};
export function deliveryReply(port:TransactionPort,c:LibraryContext,d:Delivery):DeliveryReceipt|null{
 ensure(port);const row=[...port.sql.exec('SELECT * FROM library_delivery_receipts WHERE id=?',d.deliveryId)][0];if(!row)return null;
 if(row.digest!==digest(c,d))throw new LibraryRejected('DELIVERY_REPLAY_MISMATCH',409);return JSON.parse(String(row.reply));
}
export function saveDeliveryReply(port:TransactionPort,c:LibraryContext,d:Delivery,r:DeliveryReceipt){
 port.sql.exec('INSERT INTO library_delivery_receipts VALUES(?,?,?,?,?,?)',d.deliveryId,digest(c,d),canonical(c),canonical(d),canonical(r),r.status==='revoked'?1:0);return r;
}
export function exportDeliveryJournal(port:TransactionPort){
 const present=[...port.sql.exec("SELECT name FROM sqlite_master WHERE name='library_delivery_receipts'")];if(!present.length)return [];
 ensure(port);return [...port.sql.exec('SELECT * FROM library_delivery_receipts ORDER BY id')];
}
export function restoreDeliveryJournal(port:TransactionPort,input:unknown,context:LibraryContext){
 if(!Array.isArray(input)||input.length>288)throw new LibraryRejected('DELIVERY_ARCHIVE_LIMIT',400);
 ensure(port);let controls=0,normal=0;
 for(const value of input){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='context,control,digest,id,reply,request')throw new LibraryRejected('DELIVERY_ARCHIVE_FIELDS',400);
  const row=value as Record<string,unknown>;
  if(!['id','digest','context','request','reply'].every(k=>typeof row[k]==='string')||![0,1].includes(Number(row.control)))throw new LibraryRejected('DELIVERY_ARCHIVE_FIELDS',400);
  if(row.control===1)controls++;else normal++;if(controls>32||normal>256||String(row.request).length>8192||String(row.context).length>2048||String(row.reply).length>1024)throw new LibraryRejected('DELIVERY_ARCHIVE_LIMIT',400);
  if(!/^[a-f0-9]{64}(?![\s\S])/.test(String(row.id))||!/^[a-f0-9]{64}(?![\s\S])/.test(String(row.digest)))throw new LibraryRejected('DELIVERY_ARCHIVE_BINDING',400);
  const c=JSON.parse(String(row.context)) as LibraryContext,d=JSON.parse(String(row.request)) as Delivery,r=JSON.parse(String(row.reply)) as DeliveryReceipt;
  if(canonical(c)!==canonical(context)||digest(c,d)!==row.digest||d.deliveryId!==row.id||d.key!==row.id||r.deliveryId!==row.id||r.evidenceId!==d.evidenceId||r.targetId!==d.target.targetId||r.version!==1||!['revoked','already-revoked','superseded'].includes(r.status)||(r.status==='revoked'?1:0)!==row.control)throw new LibraryRejected('DELIVERY_ARCHIVE_BINDING',400);
  port.sql.exec('INSERT INTO library_delivery_receipts VALUES(?,?,?,?,?,?)',String(row.id),String(row.digest),String(row.context),String(row.request),String(row.reply),Number(row.control));
 }
}

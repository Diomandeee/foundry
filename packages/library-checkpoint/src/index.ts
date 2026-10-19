import {canonical,freeze,sha256} from '../../library-jobs/src/data';
import {fields,identifier,integer,hash,text,need} from '../../library-catalog/src/validation';
import type {TransactionPort} from '../../library-catalog/src/types';
import type {RecoveryPermit} from '../../../workers/library/src/recovery-guard';
export interface PermitRequest {expectedRevision:number;restoreId:string;archiveSha256:string;challengeSha256:string;expiresAt:number}
export interface RecoveryCheckpoint {latest():Checkpoint;issuePermit(request:PermitRequest):RecoveryPermit}
export interface CheckpointScope {environment:string;authorityId:string;catalogAuthorityId:string;sourceAuthorityId:string;relayAuthorityId:string;projectId:string;policyVersion:string;policyHash:string;ownerPrincipal:string}
export interface Checkpoint {version:1;scope:CheckpointScope;revision:number;archiveSha256:string|null;approvedAt:number}
export interface CheckpointCommand {key:string;expectedRevision:number;archiveSha256:string|null;reason:string}
const clean=<T>(value:unknown):T=>JSON.parse(canonical(value));
const ddl=[
 'CREATE TABLE library_checkpoint_binding(id INTEGER PRIMARY KEY CHECK(id=1),content TEXT NOT NULL)',
 'CREATE TABLE library_checkpoint_decisions(revision INTEGER PRIMARY KEY CHECK(revision>0),key TEXT UNIQUE NOT NULL,request TEXT NOT NULL,archive_sha256 TEXT,at_ms INTEGER NOT NULL CHECK(at_ms>=0))',
 'CREATE TABLE library_checkpoint_permits(id TEXT PRIMARY KEY,content TEXT NOT NULL)',
 ...['binding','decisions','permits'].flatMap(table=>['UPDATE','DELETE'].map(operation=>`CREATE TRIGGER library_checkpoint_${table}_${operation.toLowerCase()} BEFORE ${operation} ON library_checkpoint_${table} BEGIN SELECT RAISE(ABORT,'immutable checkpoint evidence'); END`)),
 "CREATE TRIGGER library_checkpoint_permits_insert BEFORE INSERT ON library_checkpoint_permits WHEN EXISTS(SELECT 1 FROM library_checkpoint_permits WHERE id=NEW.id) OR (SELECT count(*) FROM library_checkpoint_permits)>=1024 BEGIN SELECT RAISE(ABORT,'retained checkpoint permit or capacity'); END",
 "CREATE TRIGGER library_checkpoint_binding_insert BEFORE INSERT ON library_checkpoint_binding WHEN EXISTS(SELECT 1 FROM library_checkpoint_binding) BEGIN SELECT RAISE(ABORT,'immutable checkpoint binding'); END",
 "CREATE TRIGGER library_checkpoint_decisions_insert BEFORE INSERT ON library_checkpoint_decisions WHEN NEW.revision!=(SELECT COALESCE(max(revision),0)+1 FROM library_checkpoint_decisions) OR EXISTS(SELECT 1 FROM library_checkpoint_decisions WHERE key=NEW.key) OR (SELECT count(*) FROM library_checkpoint_decisions)>=1024 OR (NEW.archive_sha256 IS NOT NULL AND (SELECT count(*) FROM library_checkpoint_decisions)>=1023) BEGIN SELECT RAISE(ABORT,'checkpoint sequence or capacity'); END",
];
export function validateScope(input:unknown):CheckpointScope{
 const s=clean<CheckpointScope>(input);fields(s,['environment','authorityId','catalogAuthorityId','sourceAuthorityId','relayAuthorityId','projectId','policyVersion','policyHash','ownerPrincipal']);
 for(const k of ['environment','authorityId','catalogAuthorityId','sourceAuthorityId','relayAuthorityId','projectId','policyVersion','ownerPrincipal'] as const)identifier(s[k]);hash(s.policyHash);return s;
}
/** Separate owner-controlled ledger. Restoring a catalog never writes or selects this checkpoint.
 * Trusted host retains reader/admin handles; no client HTTP approval route is installed. */
export function checkpointStore(port:TransactionPort,input:CheckpointScope,now:()=>number=Date.now){
 const scope=freeze(validateScope(input)),binding=canonical(scope);
 const rows=(q:string,...b:(string|number|null)[])=>[...port.sql.exec(q,...b)];
 port.transactionSync(()=>{
  const objects=rows("SELECT name,sql FROM sqlite_master WHERE name GLOB 'library_checkpoint_*'");
  if(objects.length){need(objects.length===ddl.length&&ddl.every(sql=>objects.some(r=>r.name===sql.split(' ')[2].split('(')[0]&&r.sql===sql)),'CHECKPOINT_SCHEMA');need(rows('SELECT content FROM library_checkpoint_binding WHERE id=1')[0]?.content===binding,'CHECKPOINT_SCOPE');}
  else{for(const sql of ddl)rows(sql);rows('INSERT INTO library_checkpoint_binding VALUES(1,?)',binding);}
 });
 function latest():Checkpoint{
  const row=rows('SELECT * FROM library_checkpoint_decisions ORDER BY revision DESC LIMIT 1')[0];
  return {version:1,scope:clean(scope),revision:Number(row?.revision??0),archiveSha256:row?row.archive_sha256 as string|null:null,approvedAt:Number(row?.at_ms??0)};
 }
 function issuePermit(input:PermitRequest):RecoveryPermit{
  const p=clean<PermitRequest>(input);fields(p,['expectedRevision','restoreId','archiveSha256','challengeSha256','expiresAt']);integer(p.expectedRevision);identifier(p.restoreId);hash(p.archiveSha256);hash(p.challengeSha256);integer(p.expiresAt);
  return port.transactionSync(()=>{const c=latest(),issuedAt=now();integer(issuedAt);need(c.revision===p.expectedRevision&&c.archiveSha256===p.archiveSha256,'CHECKPOINT_PERMIT_APPROVAL');need(issuedAt>=c.approvedAt&&p.expiresAt>issuedAt&&p.expiresAt-issuedAt<=1000,'CHECKPOINT_PERMIT_LIFETIME');
   const core={version:1 as const,authorityId:scope.authorityId,revision:c.revision,restoreId:p.restoreId,archiveSha256:p.archiveSha256,challengeSha256:p.challengeSha256,issuedAt,expiresAt:p.expiresAt};const permit={...core,permitId:sha256(canonical({domain:'library-recovery-permit/v1',scope,permit:core}))};
   const previous=rows('SELECT content FROM library_checkpoint_permits WHERE id=?',permit.permitId)[0];if(previous){need(previous.content===canonical(permit),'CHECKPOINT_PERMIT_CONFLICT');return clean<RecoveryPermit>(JSON.parse(String(previous.content)));}
   rows('INSERT INTO library_checkpoint_permits VALUES(?,?)',permit.permitId,canonical(permit));return permit;
  });
 }
 return {reader:{latest},recovery:{latest,issuePermit},admin:{
  execute(context:{environment:string;principal:string;role:'owner'},input:CheckpointCommand):Checkpoint{
   const c=clean<typeof context>(context);fields(c,['environment','principal','role']);need(c.environment===scope.environment&&c.principal===scope.ownerPrincipal&&c.role==='owner','CHECKPOINT_PERMISSION',403);
   const command=clean<CheckpointCommand>(input);fields(command,['key','expectedRevision','archiveSha256','reason']);identifier(command.key);integer(command.expectedRevision);if(command.archiveSha256!==null)hash(command.archiveSha256);text(command.reason);
   const request=canonical(command);
   return port.transactionSync(()=>{
    const existing=rows('SELECT * FROM library_checkpoint_decisions WHERE key=?',command.key)[0];
    if(existing){need(existing.request===request,'CHECKPOINT_COMMAND_CONFLICT');return {version:1,scope:clean(scope),revision:Number(existing.revision),archiveSha256:existing.archive_sha256 as string|null,approvedAt:Number(existing.at_ms)};}
    const previous=latest();need(previous.revision===command.expectedRevision,'CHECKPOINT_REVISION');const at=now();integer(at);need(at>=previous.approvedAt,'CHECKPOINT_CLOCK');
    rows('INSERT INTO library_checkpoint_decisions VALUES(?,?,?,?,?)',previous.revision+1,command.key,request,command.archiveSha256,at);return latest();
   });
  }
 }};
}

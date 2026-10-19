import { createHash } from 'node:crypto';
import { LibraryCatalog } from '../../library-catalog/src/catalog';
import type { LibraryCatalogOptions, LibraryContext, LibraryEnvelope, SqlValue, TransactionPort } from '../../library-catalog/src/types';
import { canonical, fields, hash, identifier, integer, need } from '../../library-catalog/src/validation';
import { schemaObjects } from '../../library-catalog/src/schema';

export type RecoveryBinding = Omit<LibraryCatalogOptions, 'now'>;
/** Host-selected adapter capability, never accepted from request/archive data.
 * DO mode requires a runtime that forbids attachments/temp schema/identity PRAGMAs.
 * Ordinary SQLite MUST use the default checks, regardless of SQL authorizer failures.
 */
export interface RecoveryDestinationPort extends TransactionPort {
  readonly storageKind?: 'node-sqlite' | 'cloudflare-sqlite';
}
export const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const namespace = 'library_catalog';
type Row = Record<string, unknown>;
interface Archive {
  format: 'foundry-library-catalog-recovery-v1';
  namespace: 'library_catalog';
  schema: { name: string | undefined; sql: string }[];
  meta: Row[];
  records: Row[];
  commands: Row[];
}
export interface RecoveryReceipt {
  archiveSha256: string;
  commands: number;
  records: number;
  metadataRestored: true;
  contentVerified: false;
}
export const archiveSha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const rows = (port: TransactionPort, sql: string, ...values: SqlValue[]) => [...port.sql.exec(sql, ...values)];
const normalized = (row: unknown, budget: number): Row => JSON.parse(canonical(row, budget)) as Row;
const sortedSchema = [...schemaObjects].sort((a,b) => a.name!.localeCompare(b.name!));

/** Context is supplied by an authenticated host, never decoded from archive/request labels. */
function owner(options: RecoveryBinding, context: LibraryContext): RecoveryBinding {
  const b = normalized(options, 2048) as unknown as RecoveryBinding;
  fields(b, ['environment','authorityId','projectId','policy']);
  fields(b.policy, ['version','ownerPrincipal','writerPrincipal','verifierPrincipal']);
  for (const value of [b.environment,b.authorityId,b.projectId,...Object.values(b.policy)]) identifier(value);
  need(new Set([b.policy.ownerPrincipal,b.policy.writerPrincipal,b.policy.verifierPrincipal]).size === 3);
  const c = normalized(context, 1024) as unknown as LibraryContext;
  fields(c, ['environment','authorityId','projectId','principal','role']);
  need(c.role === 'owner' && c.principal === b.policy.ownerPrincipal && c.environment === b.environment && c.authorityId === b.authorityId && c.projectId === b.projectId, 'RECOVERY_OWNER_REQUIRED', 403);
  return b;
}
function schemaCheck(port: TransactionPort): void {
  const objects = rows(port,"SELECT name,sql FROM sqlite_master WHERE name GLOB 'library_catalog_*' ORDER BY name LIMIT 17");
  need(objects.length === sortedSchema.length && sortedSchema.every(e => objects.some(a => a.name === e.name && a.sql === e.sql)), 'RECOVERY_SCHEMA');
}
const columns = {
  meta: ['id','version','binding'],
  records: ['seq','kind','id','principal','at','body'],
  commands: ['seq','key','digest','control','actor','request','reply','at'],
} as const;
const limits = { meta: 1, records: 225, commands: 1057 } as const;
const strings = { binding:2048, kind:32, id:128, principal:96, body:1792, key:96, digest:64, actor:1024, request:8192, reply:1024 } as const;
function validateRows(kind: keyof typeof columns, value: unknown): Row[] {
  need(Array.isArray(value) && value.length <= limits[kind], 'RECOVERY_ROW_BUDGET');
  return value.map((item, index) => {
    const row = normalized(item, 16384);
    fields(row, columns[kind]);
    for (const [key, v] of Object.entries(row)) {
      if (Object.hasOwn(strings, key) && !(kind === 'meta' && key === 'id')) {
        need(typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= strings[key as keyof typeof strings], 'RECOVERY_FIELD_BUDGET');
      } else integer(v);
    }
    if (kind === 'meta') need(row.id === 1 && row.version === 1, 'RECOVERY_META');
    else need(row.seq === index + 1, 'RECOVERY_SEQUENCE');
    if (kind === 'commands') { hash(row.digest); need(row.control === 0 || row.control === 1, 'RECOVERY_CONTROL'); }
    return row;
  });
}
function validate(value: unknown, binding: RecoveryBinding): Archive {
  fields(value, ['format','namespace','schema','meta','records','commands']);
  const a = value as Archive;
  need(a.format === 'foundry-library-catalog-recovery-v1' && a.namespace === namespace, 'RECOVERY_FORMAT');
  // Canonical comparison also rejects unknown schema-object properties.
  need(canonical(a.schema, 32768) === canonical(sortedSchema, 32768), 'RECOVERY_SCHEMA');
  const meta = validateRows('meta', a.meta), records = validateRows('records', a.records), commands = validateRows('commands', a.commands);
  need(meta.length === 1 && meta[0].binding === canonical(binding, 2048), 'RECOVERY_BINDING');
  need(commands.filter(c => c.control === 0).length <= 1024 && commands.filter(c => c.control === 1).length <= 33, 'RECOVERY_COMMAND_BUDGET');
  return {format:a.format, namespace, schema:sortedSchema, meta, records, commands};
}
const encode = (a: Archive): string => {
  const text = JSON.stringify(a);
  need(Buffer.byteLength(text) <= MAX_ARCHIVE_BYTES, 'RECOVERY_ARCHIVE_BUDGET');
  return text;
};
function readArchive(port: TransactionPort, binding: RecoveryBinding): Archive {
  schemaCheck(port);
  // Check SQL byte budgets before materializing potentially corrupted large TEXT columns.
  for (const kind of ['meta','records','commands'] as const) {
    const table = `library_catalog_${kind}`;
    const checks = columns[kind].filter(k => Object.hasOwn(strings,k) && !(kind === 'meta' && k === 'id')).map(k => `length(CAST(${k} AS BLOB))>${strings[k as keyof typeof strings]}`).join(' OR ');
    need(Number(rows(port,`SELECT count(*) AS n FROM ${table}`)[0].n) <= limits[kind], 'RECOVERY_ROW_BUDGET');
    need(rows(port,`SELECT 1 AS bad FROM ${table} WHERE ${checks} LIMIT 1`).length === 0, 'RECOVERY_FIELD_BUDGET');
  }
  return validate({ format:'foundry-library-catalog-recovery-v1', namespace, schema:sortedSchema,
    meta:rows(port,'SELECT * FROM library_catalog_meta LIMIT 2'),
    records:rows(port,'SELECT * FROM library_catalog_records ORDER BY seq LIMIT 226'),
    commands:rows(port,'SELECT * FROM library_catalog_commands ORDER BY seq LIMIT 1058') }, binding);
}
/** Export is a single consistent transaction. No source initialization or evidence repair. */
export function exportCatalog(port: TransactionPort, binding: RecoveryBinding, context: LibraryContext): { archive: string; sha256: string } {
  const b = owner(binding, context);
  return port.transactionSync(() => { const archive = encode(readArchive(port,b)); return {archive,sha256:archiveSha256(archive)}; });
}
/** expectedSha256 MUST arrive through an independently authenticated trusted channel. */
export function importCatalog(port: RecoveryDestinationPort, binding: RecoveryBinding, context: LibraryContext, archive: string, expectedSha256: string): RecoveryReceipt {
  const b = owner(binding, context);
  hash(expectedSha256);
  need(typeof archive === 'string' && archive.length <= MAX_ARCHIVE_BYTES && Buffer.byteLength(archive) <= MAX_ARCHIVE_BYTES, 'RECOVERY_ARCHIVE_BUDGET');
  need(archiveSha256(archive) === expectedSha256, 'RECOVERY_ARCHIVE_DIGEST');
  const a = validate(JSON.parse(archive), b);
  // Strict serialization rejects duplicate JSON keys, alternate representations and trailing data.
  need(encode(a) === archive, 'RECOVERY_ENCODING');
  return port.transactionSync(() => {
    need(port.storageKind === undefined || port.storageKind === 'node-sqlite' || port.storageKind === 'cloudflare-sqlite', 'RECOVERY_STORAGE_KIND');
    need(rows(port,'SELECT name FROM sqlite_master LIMIT 1').length === 0, 'RECOVERY_DESTINATION_NOT_EMPTY');
    if (port.storageKind !== 'cloudflare-sqlite') {
      need(rows(port,'PRAGMA database_list').every(db => db.name === 'main' || db.name === 'temp') && rows(port,'PRAGMA user_version')[0].user_version === 0 && rows(port,'PRAGMA application_id')[0].application_id === 0, 'RECOVERY_DESTINATION_NOT_EMPTY');
      need(rows(port,'SELECT name FROM sqlite_temp_master LIMIT 1').length === 0, 'RECOVERY_DESTINATION_NOT_EMPTY');
    }
    // All nested catalog transactions participate in this outer rollback boundary.
    const inner: TransactionPort = {sql:port.sql, transactionSync:fn => fn()};
    let now = 0;
    const catalog = new LibraryCatalog(inner, {...b, now:()=>now});
    for (const command of a.commands) {
      now = command.at as number;
      catalog.execute(JSON.parse(command.actor as string) as LibraryContext, JSON.parse(command.request as string) as LibraryEnvelope);
    }
    // Compare exact SQL rows, including canonical stored text, actor, digest, reply, time and control bit.
    need(encode(readArchive(inner,b)) === archive, 'RECOVERY_REPLAY_MISMATCH');
    return {archiveSha256:expectedSha256,commands:a.commands.length,records:a.records.length,metadataRestored:true,contentVerified:false};
  });
}
export { rehearseContentRecovery } from './content';
export type { ContentRecoveryReceipt, RecoveryContentPort } from './content';

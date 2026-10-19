import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { LibraryRejected, type LibraryCatalogOptions, type LibraryContext, type LibraryEnvelope, type LibraryRecord, type LibraryReply, type LibrarySnapshot, type RecordKind, type SqlValue, type TransactionPort, type TransferBinding } from './types';
import { canonical, fields, identifier, integer, need, validateEnvelope } from './validation';
import { schema, schemaObjects } from './schema';

type Authorization = { intentId: string; generation: number; binding: TransferBinding; expiresAt: number };
export class LibraryCatalog {
  private readonly binding: string;
  private readonly options: Omit<LibraryCatalogOptions, 'now'>;
  private readonly now: () => number;
  constructor(private readonly port: TransactionPort, options: LibraryCatalogOptions) {
    // Reject accessors before destructuring; the only permitted function is the DI clock.
    need(options !== null && typeof options === 'object' && !types.isProxy(options) && Object.getPrototypeOf(options) === Object.prototype);
    const ds = Object.getOwnPropertyDescriptors(options);
    need(Object.getOwnPropertySymbols(options).length === 0 && Object.values(ds).every(d => 'value' in d && d.enumerable));
    need(Object.keys(ds).every(k => ['environment','authorityId','projectId','policy','now'].includes(k)));
    const config = { ...options }; delete config.now;
    this.options = JSON.parse(canonical(config, 2048));
    fields(this.options, ['environment','authorityId','projectId','policy']);
    for (const k of ['environment','authorityId','projectId'] as const) identifier(this.options[k]);
    fields(this.options.policy, ['version','ownerPrincipal','writerPrincipal','verifierPrincipal']);
    for (const v of Object.values(this.options.policy)) identifier(v);
    const p = this.options.policy;
    need(new Set([p.ownerPrincipal,p.writerPrincipal,p.verifierPrincipal]).size === 3);
    need(options.now === undefined || typeof options.now === 'function');
    this.now = options.now ?? Date.now;
    this.binding = canonical(this.options, 2048);
    port.transactionSync(() => {
      const objects = this.objects();
      if (objects.length) { this.assertSchema(); this.assertBinding(); }
      else {
        for (const sql of schema) this.rows(sql);
        this.rows('INSERT INTO library_catalog_meta VALUES(1,1,?)', this.binding);
      }
    });
  }
  private rows(sql: string, ...bindings: SqlValue[]): Record<string, unknown>[] { return [...this.port.sql.exec(sql, ...bindings)]; }
  private objects() { return this.rows("SELECT name,sql FROM sqlite_master WHERE name GLOB 'library_catalog_*' ORDER BY name"); }
  private assertSchema() {
    const actual = this.objects();
    need(actual.length === schemaObjects.length && schemaObjects.every(e => actual.some(a => a.name === e.name && a.sql === e.sql)), 'SCHEMA_INCOMPLETE', 409);
  }
  private assertBinding() {
    const m = this.rows('SELECT * FROM library_catalog_meta');
    need(m.length === 1 && m[0].version === 1 && m[0].binding === this.binding, 'BINDING_MISMATCH', 409);
  }
  private context(input: LibraryContext): LibraryContext {
    const c = JSON.parse(canonical(input, 1024)) as LibraryContext;
    fields(c, ['environment','authorityId','projectId','principal','role']);
    for (const k of ['environment','authorityId','projectId','principal'] as const) identifier(c[k]);
    need(c.environment === this.options.environment && c.authorityId === this.options.authorityId && c.projectId === this.options.projectId, 'PERMISSION', 403);
    need(['owner','writer','verifier'].includes(c.role) && c.principal === this.options.policy[`${c.role}Principal`], 'PERMISSION', 403);
    return c;
  }
  private readRecords(): LibraryRecord[] {
    return this.rows('SELECT * FROM library_catalog_records ORDER BY seq').map(r => ({seq: Number(r.seq), kind: r.kind as RecordKind, id: String(r.id), principal: String(r.principal), at: Number(r.at), body: JSON.parse(String(r.body))}));
  }
  private view(): LibrarySnapshot {
    const records = this.readRecords(), promotions = records.filter(r => r.kind === 'promotion');
    const last = promotions.at(-1);
    return {version:1,environment:this.options.environment,authorityId:this.options.authorityId,projectId:this.options.projectId,
      revision: Number(this.rows('SELECT count(*) AS n FROM library_catalog_commands')[0].n), canonicalRevision:promotions.length,
      canonicalSnapshotId: last ? String(last.body.snapshotId) : null, policyRevoked:records.some(r => r.kind === 'revocation'), records};
  }
  snapshot(context: LibraryContext): LibrarySnapshot {
    this.context(context);
    return this.port.transactionSync(() => {
      this.assertSchema(); this.assertBinding(); const result = this.view();
      canonical(result, 512 * 1024); return result;
    });
  }
  execute(context: LibraryContext, envelope: LibraryEnvelope): LibraryReply {
    const c = this.context(context), e = validateEnvelope(envelope, this.options.projectId, this.options.policy.version);
    if(e.key.startsWith('sys-revoke-'))need(c.role==='owner','RESERVED_CONTROL_KEY',403);
    const digest = createHash('sha256').update(canonical({binding:this.binding,context:c,envelope:e}, 16384)).digest('hex');
    return this.port.transactionSync(() => {
      this.assertSchema(); this.assertBinding();
      const existing = this.rows('SELECT digest,reply FROM library_catalog_commands WHERE key=?', e.key)[0];
      if (existing) { need(existing.digest === digest, 'IDEMPOTENCY_MISMATCH', 409); return JSON.parse(String(existing.reply)); }
      const now = this.now(); integer(now);
      const state = this.view(), records = state.records;
      const control = e.operation === 'cancelTransfer' || e.operation === 'revokePolicy';
      const roles: Record<LibraryEnvelope['operation'], LibraryContext['role'][]> = {
        stageTransfer:['writer'],authorizeTransfer:['owner'],cancelTransfer:['owner','writer'],revokePolicy:['owner'],
        attestTransfer:['verifier'],publishSnapshot:['writer'],recordVerification:['verifier'],createCandidate:['writer'],promoteCandidate:['owner'],
      };
      need(roles[e.operation].includes(c.role), 'PERMISSION', 403);
      if (!control) need(!state.policyRevoked, 'POLICY_REVOKED', 409);
      const normalCount = Number(this.rows('SELECT count(*) AS n FROM library_catalog_commands WHERE control=0')[0].n);
      if (!control) need(normalCount < 1024, 'CAPACITY', 409);
      let replyId = '', generation: number | undefined, accepted = true;
      const find = (kind: RecordKind, id: string): LibraryRecord => {
        const row = records.find(r => r.kind === kind && r.id === id); need(row, 'UNKNOWN_' + kind.toUpperCase(), 409); return row;
      };
      const append = (kind: RecordKind, id: string, body: unknown) => {
        need(!records.some(r => r.kind === kind && r.id === id), 'IDENTITY_EXISTS', 409);
        const safety = kind === 'cancellation' || kind === 'revocation';
        need(records.filter(r => (r.kind === 'cancellation' || r.kind === 'revocation') === safety).length < (safety ? 33 : 192), 'CAPACITY', 409);
        const content = canonical(body, 1792);
        this.rows('INSERT INTO library_catalog_records VALUES(?,?,?,?,?,?)', records.length+1, kind, id, c.principal, now, content);
        records.push({seq:records.length+1,kind,id,principal:c.principal,at:now,body:JSON.parse(content)});
        replyId = id;
      };
      const ensureAttestable = (intentId: string, binding: TransferBinding) => {
        // Reserve enough row space for every legal attestation ID and timestamp,
        // not merely the short IDs used by a successful staging request.
        const worst = canonical({version:1,attestationId:'a'.repeat(96),intentId,
          generation:Number.MAX_SAFE_INTEGER,binding,manifestHash:binding.content.manifestHash,
          bytes:binding.content.bytes,hostAttestation:'a'.repeat(64),
          attestedAt:Number.MAX_SAFE_INTEGER,expiresAt:Number.MAX_SAFE_INTEGER,
          evidenceScope:'host-content-attestation'});
        need(new TextEncoder().encode(worst).length <= 1792, 'ATTESTATION_CAPACITY', 409);
      };
      const current = (intentId: string, expectedGeneration?: number, requireLive = true): Authorization => {
        find('intent', intentId);
        const row = records.filter(r => r.kind === 'authorization' && r.body.intentId === intentId).at(-1);
        need(row, 'MISSING_AUTHORIZATION', 409);
        const a = row.body as unknown as Authorization;
        if (expectedGeneration !== undefined) need(a.generation === expectedGeneration, 'GENERATION_FENCE', 409);
        need(!records.some(r => r.kind === 'cancellation' && r.id === intentId), 'TRANSFER_CANCELLED', 409);
        if (requireLive) need(now < a.expiresAt && !state.policyRevoked, 'AUTHORIZATION_EXPIRED', 409);
        return a;
      };
      switch (e.operation) {
        case 'stageTransfer': {
          const b = e.body;
          need(records.filter(r => r.kind === 'intent').length < 32, 'CAPACITY', 409);
          need(b.expiresAt > now && b.expiresAt - now <= 86_400_000, 'EXPIRY', 409);
          ensureAttestable(b.intentId,b.binding);
          append('intent', b.intentId, {version:1,intentId:b.intentId,binding:b.binding});
          generation = 1;
          append('authorization', `${b.intentId}:1`, {version:1,intentId:b.intentId,generation,binding:b.binding,expiresAt:b.expiresAt});
          replyId = b.intentId; break;
        }
        case 'authorizeTransfer': {
          const b = e.body, previous = current(b.intentId,b.expectedGeneration,false);
          need(!records.some(r => r.kind === 'snapshot' && r.body.intentId === b.intentId), 'TRANSFER_PUBLISHED', 409);
          need(b.expiresAt > now && b.expiresAt - now <= 86_400_000, 'EXPIRY', 409);
          // New attempts may change compute fences, never the staged content identity.
          need(canonical(previous.binding.content) === canonical(b.binding.content), 'CONTENT_BINDING', 409);
          ensureAttestable(b.intentId,b.binding);
          generation = previous.generation+1; integer(generation);
          append('authorization', `${b.intentId}:${generation}`, {version:1,intentId:b.intentId,generation,binding:b.binding,expiresAt:b.expiresAt});
          replyId = b.intentId; break;
        }
        case 'cancelTransfer': {
          find('intent', e.body.intentId); append('cancellation',e.body.intentId,e.body); break;
        }
        case 'revokePolicy': append('revocation','policy',e.body); break;
        case 'attestTransfer': {
          const b = e.body, a = current(b.intentId,b.generation);
          need(b.attestedAt <= now && b.expiresAt > now, 'ATTESTATION_EXPIRED', 409);
          need(canonical(b.binding) === canonical(a.binding), 'ATTESTATION_BINDING', 409);
          need(b.manifestHash === a.binding.content.manifestHash && b.bytes === a.binding.content.bytes, 'CONTENT_BINDING', 409);
          append('transferAttestation',b.attestationId,{...b,evidenceScope:'host-content-attestation'}); break;
        }
        case 'publishSnapshot': {
          const b = e.body; current(b.intentId,b.generation);
          const attestation = find('transferAttestation', b.attestationId);
          need(now < Number(attestation.body.expiresAt), 'ATTESTATION_EXPIRED', 409);
          need(attestation.principal !== c.principal && attestation.body.intentId === b.intentId && attestation.body.generation === b.generation, 'ATTESTATION_BINDING', 409);
          need(!records.some(r => r.kind === 'snapshot' && r.body.intentId === b.intentId), 'TRANSFER_PUBLISHED', 409);
          if (b.provenance.parentSnapshotId !== null) find('snapshot',b.provenance.parentSnapshotId);
          append('snapshot',b.snapshotId,{...b,evidenceScope:'catalog-metadata-only'}); break;
        }
        case 'recordVerification': {
          const b = e.body, snapshot = find('snapshot',b.snapshotId);
          need(snapshot.principal !== c.principal, 'INDEPENDENT_VERIFIER', 403);
          append('verification',b.verificationId,{...b,evidenceScope:'host-independent-verification-attestation'}); break;
        }
        case 'createCandidate': {
          const b = e.body; find('snapshot',b.snapshotId);
          const verification = find('verification',b.verificationId);
          need(verification.body.snapshotId === b.snapshotId, 'VERIFICATION_BINDING', 409);
          // Expected revision is a proposal, including stale proposals. Retain every candidate.
          append('candidate',b.candidateId,b); break;
        }
        case 'promoteCandidate': {
          const b = e.body, candidate = find('candidate', b.candidateId);
          find('snapshot',String(candidate.body.snapshotId));
          // Publication sealed transfer authorization. Lease expiry/cancel cannot erase history.
          if (b.expectedCanonicalRevision !== state.canonicalRevision || candidate.body.expectedCanonicalRevision !== b.expectedCanonicalRevision) {
            accepted = false; replyId = b.candidateId;
          } else append('promotion',String(state.canonicalRevision+1),{version:1,candidateId:b.candidateId,snapshotId:candidate.body.snapshotId,expectedCanonicalRevision:b.expectedCanonicalRevision});
          break;
        }
      }
      const reply: LibraryReply = {version:1,accepted,revision:state.revision+1,operation:e.operation,id:replyId,
        canonicalRevision:state.canonicalRevision+(accepted && e.operation === 'promoteCandidate' ? 1 : 0),
        ...(generation === undefined ? {} : {generation}), ...(!accepted ? {code:'CANONICAL_CONFLICT' as const} : {})};
      // Command request, actor/audit, digest and stable reply commit in the same transaction as domain rows.
      this.rows('INSERT INTO library_catalog_commands VALUES(?,?,?,?,?,?,?,?)',state.revision+1,e.key,digest,control?1:0,canonical(c,1024),canonical(e),canonical(reply,1024),now);
      canonical(this.view(),512*1024);
      return reply;
    });
  }
}

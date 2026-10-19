import type { TransactionPort, LibraryContext, TransferBinding } from '../../library-catalog/src/types';
import { validateBinding } from '../../library-catalog/src/validation';
import type { ObjectRead, ObjectRef } from '../../library-jobs/src/types';
import { HARD_LIMITS, manifestBytes } from '../../library-jobs/src/index';
import { boundedBytes, readResult, canonical, freeze } from '../../library-jobs/src/data';
import { archiveSha256, exportCatalog, type RecoveryBinding } from './index';

export interface RecoveryContentPort {
  /** Trusted host authorizes exact immutable-generation reads and bounds before allocation. */
  readObject(ref: Readonly<ObjectRef>, maxBytes: number): ObjectRead;
}
export interface ContentRecoveryReceipt {
  scope: 'local-exact-generation-byte-rehearsal';
  contentVerified: boolean;
  checkedRefs: number;
  verifiedBytes: number;
  failures: { ref: ObjectRef; code: 'MISSING_CORRUPT_OR_UNREADABLE' | 'CONTENT_BUDGET' }[];
}
/** Independent byte proof. Grants no publication, compute acceptance or full-project claim. */
export function rehearseContentRecovery(port: TransactionPort, binding: RecoveryBinding, context: LibraryContext, content: RecoveryContentPort): ContentRecoveryReceipt {
  const archive = JSON.parse(exportCatalog(port,binding,context).archive) as {records: {kind:string;body:string}[]};
  const refs = new Map<string, Readonly<ObjectRef>>();
  const failures: ContentRecoveryReceipt['failures'] = [];
  let reserved = 0, verifiedBytes = 0, checkedRefs = 0;
  function add(input: ObjectRef): void {
    const ref = freeze(JSON.parse(canonical(input)) as ObjectRef);
    const key = canonical([ref.projectId,ref.objectKey,ref.generation]);
    const old = refs.get(key);
    if (old && canonical(old) !== canonical(ref)) throw new Error('conflicting immutable reference');
    if (!old) { if (refs.size >= 4096) throw new Error('reference count budget'); refs.set(key,ref); }
  }
  for (const row of archive.records) {
    if (!['intent','authorization','transferAttestation'].includes(row.kind)) continue;
    const b = (JSON.parse(row.body) as {binding:TransferBinding}).binding;
    validateBinding(b, binding.projectId, binding.policy.version);
    add({projectId:b.projectId,objectKey:b.content.objectKey,generation:b.content.objectGeneration,sha256:b.content.objectHash,sizeBytes:b.content.bytes});
  }
  // Map iteration includes objects discovered from verified manifest bytes. Never trust a worker list.
  for (const ref of refs.values()) {
    const manifest = ref.objectKey.startsWith(`projects/${binding.projectId}/manifests/`);
    const maximum = manifest ? HARD_LIMITS.maxManifestBytes : HARD_LIMITS.maxObjectBytes;
    if (checkedRefs >= 4096 || ref.sizeBytes > maximum || reserved + ref.sizeBytes > HARD_LIMITS.maxTotalBytes) {
      failures.push({ref,code:'CONTENT_BUDGET'}); continue;
    }
    reserved += ref.sizeBytes; checkedRefs++;
    try {
      const read = readResult(content.readObject(ref, ref.sizeBytes));
      if (canonical(read.ref) !== canonical(ref)) throw new Error('immutable read mismatch');
      const bytes = boundedBytes(read.bytes, ref.sizeBytes);
      if (bytes.length !== ref.sizeBytes || archiveSha256(bytes) !== ref.sha256) throw new Error('actual byte mismatch');
      if (manifest) {
        const text = new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes);
        const parsed = JSON.parse(text) as {projectId:string;objects:ObjectRef[]};
        const expected = manifestBytes(parsed);
        if (parsed.projectId !== binding.projectId || Buffer.compare(Buffer.from(bytes), Buffer.from(expected)) !== 0) throw new Error('manifest mismatch');
        for (const object of parsed.objects) add(object);
      }
      verifiedBytes += bytes.length;
    } catch {
      failures.push({ref,code:'MISSING_CORRUPT_OR_UNREADABLE'});
    }
  }
  return {scope:'local-exact-generation-byte-rehearsal', contentVerified:refs.size > 0 && failures.length === 0, checkedRefs,verifiedBytes,failures};
}

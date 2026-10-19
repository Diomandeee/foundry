import type {VerifyRequest,VerifyVerdict} from '@foundry/verify';
import type {VerificationReceipt} from '@foundry/stores';
async function bytesDigest(bytes:Uint8Array):Promise<string>{
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes).buffer))].map(b=>b.toString(16).padStart(2,'0')).join('');
}
const digest=(value:unknown)=>bytesDigest(new TextEncoder().encode(JSON.stringify(value)));
/** Persist only bounded identities and outcomes, not source contents, credentials,
 * verifier output or exception text. Exact proposal SHA binds complete Git content. */
export async function verificationReceipt(request:VerifyRequest,verdict:VerifyVerdict,
  context:{namespace:string;ref:string;before:string;baseSha:string|null;files:Record<string,string>;deleted:readonly string[];enforce:boolean;requireChecked:boolean}):Promise<VerificationReceipt>{
  if(typeof verdict.checked!=='boolean'||typeof verdict.ok!=='boolean'||!Array.isArray(verdict.runs)||verdict.runs.length>128)
    throw new Error('verification: invalid bounded verdict');
  const runs=verdict.runs.map(r=>{
    if(typeof r.name!=='string'||!r.name||r.name.length>200||typeof r.ok!=='boolean')throw new Error('verification: invalid run');
    return {name:r.name,ok:r.ok};
  });
  if(verdict.checked&&(runs.length===0||verdict.ok!==runs.every(r=>r.ok)))throw new Error('verification: inconsistent outcome');
  const files=[];
  for(const path of Object.keys(context.files).sort())files.push({path,sha256:await bytesDigest(new TextEncoder().encode(context.files[path]))});
  const contentHash=await digest({files,deleted:[...context.deleted].sort()});
  const body={version:1 as const,request:{repo:request.repo,baseBranch:request.baseBranch,headSha:request.headSha,
    files:[...request.files],namespace:context.namespace,ref:context.ref,before:context.before,baseSha:context.baseSha,contentHash},
    policy:{enforce:context.enforce,requireChecked:context.requireChecked},verdict:{checked:verdict.checked,ok:verdict.ok,runs}};
  if(new TextEncoder().encode(JSON.stringify(body)).byteLength>262144)throw new Error('verification: receipt byte budget');
  return {...body,sha256:await digest(body)};
}

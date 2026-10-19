export class HttpFailure extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export function exact(value: unknown, fields: string[]): asserts value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) throw new HttpFailure(400, 'invalid-request');
}
/** Enforces the limit while streaming, including requests without Content-Length. */
export async function boundedJson(request: Request, limit: number, deadlineMs = 10000, signal?: AbortSignal): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new HttpFailure(415,'json-required');
  const reader=request.body?.getReader();
  if (!reader) throw new HttpFailure(400,'body-required');
  if (signal?.aborted) { void reader.cancel().catch(() => {}); throw new HttpFailure(408, 'request-timeout'); }
  const bytes = new Uint8Array(limit);
  let count = 0;
  const expiresAt = Date.now() + deadlineMs;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HttpFailure(408, 'request-timeout')), deadlineMs);
  });
  // An outer logical deadline aborts the reader as well, so a late body can never
  // keep running after the caller has already returned.
  const aborted = signal ? new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(new HttpFailure(408, 'request-timeout')), {once: true});
  }) : undefined;
  try {
    for (let reads = 0; ; reads++) {
      // Also bound immediately resolved reads, which can starve the deadline timer.
      if (Date.now() >= expiresAt) throw new HttpFailure(408, 'request-timeout');
      if (reads >= 65536) throw new HttpFailure(413, 'request-too-many-chunks');
      const {value,done} = await (aborted ? Promise.race([reader.read(), timeout, aborted]) : Promise.race([reader.read(), timeout]));
      if (Date.now() >= expiresAt) throw new HttpFailure(408, 'request-timeout');
      if (done) break;
      if (value.byteLength === 0) continue;
      if (value.byteLength > limit - count) throw new HttpFailure(413, 'request-too-large');
      bytes.set(value, count);
      count += value.byteLength;
    }
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes.subarray(0, count)));}
    catch{throw new HttpFailure(400,'invalid-json');}
  } catch (error) {
    // An underlying source can leave cancel pending forever or reject it.
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer!);
    reader.releaseLock();
  }
}
export const jsonResponse=(value:unknown,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});

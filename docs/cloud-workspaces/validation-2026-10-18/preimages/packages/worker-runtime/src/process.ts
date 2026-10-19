import { spawn } from 'node:child_process';
import type { CliResult, ExecuteOptions } from './index';

/** Internal OS primitive, not a workload execution API. No inherited secrets/environment. */
export function spawnBounded(executable: string, argv: readonly string[], options: ExecuteOptions): Promise<CliResult> {
  return new Promise(resolve => {
    if (options.signal?.aborted) { resolve({code:null,stdout:new Uint8Array(),stderr:new Uint8Array(),truncated:false,interrupted:true}); return; }
    let child: ReturnType<typeof spawn>;
    try { child = spawn(executable,[...argv],{shell:false,env:{PATH:'/usr/bin:/bin',LANG:'C',TSX_DISABLE_CACHE:'1'},stdio:['pipe','pipe','pipe'],detached:process.platform !== 'win32'}); }
    catch { resolve({code:null,stdout:new Uint8Array(),stderr:new Uint8Array(),truncated:false,interrupted:false}); return; }
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), truncated = false, interrupted = false;
    const terminate = () => {
      interrupted = true;
      if (child.pid && process.platform !== 'win32') {
        try { process.kill(-child.pid,'SIGKILL'); } catch { child.kill('SIGKILL'); }
      } else child.kill('SIGKILL');
    };
    const capture = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      const current = stream === 'stdout' ? stdout : stderr;
      const room = Math.max(0,options.maxBytes-current.length);
      const next = Buffer.concat([current,chunk.subarray(0,room)]);
      if (stream === 'stdout') stdout = next; else stderr = next;
      if (chunk.length > room) { truncated = true; terminate(); }
    };
    child.stdout?.on('data',(chunk: Buffer) => capture('stdout',chunk));
    child.stderr?.on('data',(chunk: Buffer) => capture('stderr',chunk));
    child.stdin?.on('error',() => {});
    child.on('error',() => {}); // Close follows spawn error. Do not expose OS messages or argv.
    const timer = setTimeout(terminate, options.timeoutMs);
    options.signal?.addEventListener('abort',terminate,{once:true});
    if (options.signal?.aborted) terminate();
    child.on('close',code => {
      clearTimeout(timer); options.signal?.removeEventListener('abort',terminate);
      resolve({code,stdout,stderr,truncated,interrupted});
    });
    child.stdin?.end(options.stdin);
  });
}

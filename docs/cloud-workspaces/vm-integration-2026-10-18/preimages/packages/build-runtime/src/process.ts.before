import { spawn } from 'node:child_process';
import type { Exit } from './types.js';
import { check } from './plans.js';
export interface ProcessHandle {
  pid: number | undefined; completion: Promise<Exit>; closed: () => boolean;
  killGroup(): void;
}
/** No shell, ambient env, stdin, or unbounded logs. A group signal is NOT descendant proof. */
export function launch(executable: string, argv: readonly string[], cwd: string, env: Readonly<Record<string,string>>, maxBytes: number, timeoutMs: number): ProcessHandle {
  check(Number.isSafeInteger(maxBytes) && maxBytes > 0 && Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'invalid-process-bounds');
  const child = spawn(executable,[...argv],{cwd,env:{...env},shell:false,detached:true,stdio:['ignore','pipe','pipe']});
  let closed = false, limited = false, size = 0;
  const chunks: Buffer[] = [];
  const killGroup = () => { if (child.pid && !closed) { try { process.kill(-child.pid,'SIGKILL'); } catch { /* inspect must establish stop */ } } };
  const completion = new Promise<Exit>(resolve => {
    let settled = false;
    const finish = (code: number | null, signal: string | null) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({code,signal,limited,output:Buffer.concat(chunks)});
    };
    const timer = setTimeout(() => { limited = true; killGroup(); finish(null,'deadline'); },timeoutMs);
    // close may never follow a daemonized child retaining stdio; timer resolves unknown.
    child.on('close',(code,signal) => { closed = true; finish(code,signal); });
    child.on('error',() => { killGroup(); finish(null,'spawn-error'); });
    const capture = (data: Buffer) => {
      const remaining = maxBytes - size;
      if (remaining > 0) { chunks.push(Buffer.from(data.subarray(0,remaining))); size += Math.min(data.length,remaining); }
      if (data.length > remaining) { limited = true; killGroup(); finish(null,'output-limit'); }
    };
    child.stdout?.on('data',capture); child.stderr?.on('data',capture);
  });
  return {pid:child.pid,completion,closed:() => closed,killGroup};
}
export async function command(executable: string, args: readonly string[], cwd: string, env: Readonly<Record<string,string>>, timeoutMs = 5000): Promise<string> {
  const p = launch(executable,args,cwd,env,262144,timeoutMs), r = await p.completion;
  check(p.closed() && r.code === 0 && !r.limited, 'control-unavailable');
  return Buffer.from(r.output).toString('utf8');
}

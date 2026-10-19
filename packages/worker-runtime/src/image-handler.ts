/** Image entrypoint source: owner bundles this into /opt/foundry/event-summary.cjs.
 * No host execution path selects a caller script. Baking/vetting/pinning the image is gated.
 */
import { TextDecoder } from 'node:util';
import { executeEventSummary } from '../../epoch-jobs/src/index';
async function main(): Promise<void> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk); bytes += buffer.length;
    if (bytes > 16384) throw new Error('input-limit');
    chunks.push(buffer);
  }
  const input = new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
  const output = executeEventSummary(input);
  if (output.length > 4096) throw new Error('output-limit');
  await new Promise<void>((resolve,reject) => process.stdout.write(output,error => error ? reject(error) : resolve()));
}
void main().catch(() => { process.stderr.write('summary-rejected\n'); process.exitCode = 1; process.stdin.destroy(); });

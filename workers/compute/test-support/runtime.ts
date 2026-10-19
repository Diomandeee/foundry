import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Local workerd fixture only; no deploy/account calls or shared dev registry. */
export async function localRuntime(script: string, persistence: string, name = 'foundry-compute-local-tests') {
  const bundled = await build({
    stdin: { contents: script, resolveDir: repositoryRoot, sourcefile: 'local-compute-fixture.ts', loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022',
    external: ['cloudflare:*', 'node:*'], logLevel: 'silent',
  });
  const options = convertV4MiniflareOptions({
    name, modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-10-05', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { AUTHORITY: { className: 'TestFabricAuthority', useSQLite: true } },
    r2Buckets: ['TEST_ARTIFACTS'],
    logRequests: false,
  });
  for (const worker of options.workers) worker.dev = { ...worker.dev, unsafeRegisterWorker: false };
  return new Miniflare({ ...options, resourcePersistencePath: persistence, telemetry: { enabled: false } });
}

import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
/** Actual workerd with local SQLite only, without account registration or telemetry. */
export async function libraryRuntime(script:string,persistence:string){
 const bundle=await build({stdin:{contents:script,resolveDir:root,sourcefile:'local-library-fixture.ts',loader:'ts'},bundle:true,write:false,format:'esm',platform:'neutral',target:'es2022',external:['cloudflare:*','node:*'],logLevel:'silent'});
 const options=convertV4MiniflareOptions({name:'foundry-library-tests',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-05',compatibilityFlags:['nodejs_compat'],durableObjects:{LIBRARY_CATALOG:{className:'TestLibrary',useSQLite:true}},logRequests:false});
 for(const worker of options.workers)worker.dev={...worker.dev,unsafeRegisterWorker:false};
 return new Miniflare({...options,resourcePersistencePath:persistence,telemetry:{enabled:false}});
}

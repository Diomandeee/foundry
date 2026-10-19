import {mkdir,copyFile,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {privateDirectory,need,PilotError} from './private-state';
/** Explicit future build preparation only. Never invokes Docker, pulls or publishes. */
export async function packageImage(outputRoot:string,ownerApproved:boolean){
 need(ownerApproved===true,'pilot-image-build-gated',403);await privateDirectory(outputRoot);
 const directory=join(outputRoot,'foundry-image-'+randomUUID());await mkdir(directory,{mode:0o700});
 const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../..');
 const {build}=await import('esbuild');
 await build({entryPoints:[join(root,'packages/worker-runtime/src/image-handler.ts')],outfile:join(directory,'event-summary.cjs'),bundle:true,format:'cjs',platform:'node',target:'node24',external:['node:*'],logLevel:'silent',sourcemap:false});
 await copyFile(join(here,'image/Dockerfile'),join(directory,'Dockerfile'));await copyFile(join(here,'image/dockerignore'),join(directory,'.dockerignore'));
 await writeFile(join(directory,'PACKAGING.json'),JSON.stringify({version:1,template:'epoch-event-summary-v1',state:'handler-bundled-not-image-built',baseImage:null,imageDigest:null,requiresOwnerVettedNode24Base:true},null,2)+'\n',{mode:0o600});
 return directory;
}
export async function main(args=process.argv.slice(2)){
 need(args.length===3&&args[0]==='--output-root'&&args[2]==='--owner-approved-build','pilot-image-build-gated',403);
 const output=await packageImage(args[1],true);process.stdout.write('image-context='+output+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void main().catch(()=>{process.stderr.write('pilot-image-packaging-failed\n');process.exitCode=1;});

import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadOwnerConfig} from './config.js';
import {prepareHost} from './host.js';
import {loadVerifyConfig,verifyAttempt} from './verify.js';

export const usage='Usage: cli.ts prepare|prepare-verify --config /absolute/private.json\n       cli.ts run|verify --config /absolute/private.json --approval-receipt-sha256 HEX';
export function parseArgs(args:readonly string[]){
  const [command,flag,file,receiptFlag,receipt]=args;
  if(!['prepare','prepare-verify','run','verify'].includes(command??'')||flag!=='--config'||!file||!file.startsWith('/')||
    ((command==='prepare'||command==='prepare-verify')?args.length!==3:
      args.length!==5||receiptFlag!=='--approval-receipt-sha256'||!/^[0-9a-f]{64}$/.test(receipt??'')))throw new Error('invalid-arguments');
  return {command:command!,file,receipt};
}
export async function main(args:readonly string[]=process.argv.slice(2)):Promise<number>{
  if(args.length===1&&args[0]==='--help'){process.stdout.write(usage+'\n');return 0;}
  const cancel=new AbortController();const stop=()=>cancel.abort();
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
  try{
    const a=parseArgs(args);
    if(a.command==='prepare-verify'){
      const c=await loadVerifyConfig(a.file);
      process.stdout.write(JSON.stringify({state:'prepared-not-verified',attemptId:c.attemptId,expectedEpoch:c.expectedEpoch})+'\n');return 0;
    }
    if(a.command==='verify'){
      const result=await verifyAttempt(await loadVerifyConfig(a.file),a.receipt!,cancel.signal);
      process.stdout.write(JSON.stringify(result)+'\n');return 0;
    }
    const host=prepareHost(await loadOwnerConfig(a.file));
    if(a.command==='prepare'){process.stdout.write(JSON.stringify(host.preparation)+'\n');return 0;}
    const result=await host.run(a.receipt!,cancel.signal);
    // Never emit raw output bytes, credentials, capability or provider errors.
    process.stdout.write(JSON.stringify({state:result.state,...(result.runtime?{outcome:result.runtime.outcome,stopped:result.runtime.stop.stopped}:{})})+'\n');
    return result.state==='staged-awaiting-verifier'?0:result.state==='owner-reconciliation-required'?2:3;
  }catch{process.stderr.write('build-pilot-unconfirmed; retain attempt state and inspect owner records\n');return 2;}
  finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  void main().then(code=>{process.exitCode=code;},()=>{process.exitCode=2;});
}

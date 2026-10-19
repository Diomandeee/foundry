import {pathToFileURL} from 'node:url';
import {AuthorityTransport} from './transport';
import {need} from './private-state';
/** Explicit owner-approved bootstrap read. Cannot submit commands or write configuration. */
export async function main(args=process.argv.slice(2)){
 need(args.length===7&&args[0]==='--origin'&&args[2]==='--environment'&&args[4]==='--credential-ref'&&args[6]==='--owner-approved-read','pilot-discovery-gated',403);
 const transport=new AuthorityTransport({origin:args[1],environment:args[3]}),abort=new AbortController();const stop=()=>abort.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{const status=await transport.discover(args[5],abort.signal);process.stdout.write(JSON.stringify({version:1,state:'observed-unpinned-authority',...status})+'\n');}finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void main().catch(()=>{process.stderr.write('pilot-authority-discovery-failed\n');process.exitCode=1;});

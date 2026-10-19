import {HttpFailure} from '../../compute/src/http';
/** Streaming exact archive text; no eager max-size buffer and no unbounded .text(). */
export async function archiveBody(request:Request,limit:number):Promise<string>{
 if(request.headers.get('content-type')!=='application/vnd.foundry.catalog-recovery+json')throw new HttpFailure(415,'archive-media-type');
 const reader=request.body?.getReader();if(!reader)throw new HttpFailure(400,'body-required');
 let timer:ReturnType<typeof setTimeout>|undefined;
 const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new HttpFailure(408,'archive-timeout')),10000);});
 const deadline=Date.now()+10000,decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});let bytes=0,text='';
 try{
  for(let n=0;;n++){
   if(n>=4096||Date.now()>=deadline)throw new HttpFailure(413,'archive-stream-limit');
   const {value,done}=await Promise.race([reader.read(),timeout]);if(Date.now()>=deadline)throw new HttpFailure(408,'archive-timeout');if(done)break;
   bytes+=value.byteLength;if(bytes>limit)throw new HttpFailure(413,'archive-too-large');
   text+=decoder.decode(value,{stream:true});
  }
  text+=decoder.decode();return text;
 }catch(error){void reader.cancel().catch(()=>{});if(error instanceof HttpFailure)throw error;throw new HttpFailure(400,'archive-invalid-utf8');}
 finally{if(timer)clearTimeout(timer);reader.releaseLock();}
}

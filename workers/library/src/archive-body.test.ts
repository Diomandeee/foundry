import {it,expect} from 'vitest';
import {archiveBody} from './archive-body';
const headers={'content-type':'application/vnd.foundry.catalog-recovery+json'};
it('preserves a UTF-8 BOM split across chunks for exact-byte pin rejection',async()=>{
 const pieces=[new Uint8Array([0xef]),new Uint8Array([0xbb]),new Uint8Array([0xbf]),new TextEncoder().encode('{}')];
 const stream=new ReadableStream<Uint8Array>({pull(c){const next=pieces.shift();if(next)c.enqueue(next);else c.close();}});
 expect(await archiveBody(new Request('https://archive',{method:'POST',headers,body:stream,duplex:'half'} as RequestInit),64)).toBe('\ufeff{}');
});
it('rejects EOF resuming beyond the deadline even before its timer callback runs',async()=>{
 const original=Date.now;let clock=1000000;Date.now=()=>clock;
 try{const stream=new ReadableStream<Uint8Array>({pull(c){clock+=10001;c.close();}});await expect(archiveBody(new Request('https://archive',{method:'POST',headers,body:stream,duplex:'half'} as RequestInit),64)).rejects.toMatchObject({status:408});}finally{Date.now=original;}
});

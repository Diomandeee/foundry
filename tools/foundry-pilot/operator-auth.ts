import {createHmac,createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {credential,need} from './private-state';
/** A separate local operator credential; authority credentials never enter the browser. */
export function operatorSessions(reference:string,origin:string,authorityReferences:readonly string[]=[]){
 const instance=randomBytes(32),name='foundry_operator',active=new Map<string,number>();
 const prune=()=>{const now=Date.now();for(const [nonce,at] of active)if(now<at||now-at>=900000)active.delete(nonce);};
 const cookieValue=(header:unknown):RegExpExecArray|null=>{if(typeof header!=='string'||header.length>4096)return null;const values=header.split(';').map(x=>x.trim()).filter(x=>x.startsWith(name+'='));if(values.length!==1)return null;return /^([0-9]{13})\.([a-f0-9]{32})\.([a-f0-9]{64})(?![\s\S])/.exec(values[0].slice(name.length+1));};
 const key=()=>createHash('sha256').update(credential(reference)).update(instance).digest();
 const mac=(value:string)=>createHmac('sha256',key()).update(origin+'\n'+value).digest('hex');
 const equal=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
 return {
  login(input:unknown):string{
   need(typeof input==='string'&&input.length>=32&&input.length<=8192,'operator-login-failed',401);
   for(const other of authorityReferences)need(!equal(createHash('sha256').update(credential(other)).digest('hex'),createHash('sha256').update(input).digest('hex')),'operator-credential-must-be-separate',503);
   const expected=createHash('sha256').update(credential(reference)).digest('hex'),provided=createHash('sha256').update(input).digest('hex');need(equal(expected,provided),'operator-login-failed',401);
   prune();need(active.size<32,'operator-session-capacity',429);const at=Date.now(),nonce=Buffer.from(randomBytes(16)).toString('hex');active.set(nonce,at);const value=String(at)+'.'+nonce;return name+'='+value+'.'+mac(value)+'; HttpOnly; SameSite=Strict; Path=/api/; Max-Age=900';
  },
  authenticated(header:unknown):boolean{
   prune();const match=cookieValue(header);if(!match)return false;
   const at=Number(match[1]),now=Date.now();if(at>now||now-at>=900000||active.get(match[2])!==at)return false;
   try{return equal(match[3],mac(match[1]+'.'+match[2]));}catch{return false;}
  },
  clear:(header:unknown)=>{const match=cookieValue(header);if(match)active.delete(match[2]);prune();return name+'=; HttpOnly; SameSite=Strict; Path=/api/; Max-Age=0';}
 };
}

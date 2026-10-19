import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import entry from './index';
import {policies,token} from '../test-support/client';
import type {LibraryEnvironment} from './config';
const auth=JSON.stringify([{tokenSha256:createHash('sha256').update(token('owner')).digest('hex'),principal:'owner',role:'owner',environment:'local'}]);
describe('Library outer route fault contract',()=>{
 it('returns bounded no-store JSON for rejected downstream fetches',async()=>{
  const env:LibraryEnvironment={LIBRARY_ENVIRONMENT:'local',LIBRARY_AUTHORITY_NAME:'catalog',LIBRARY_TRANSPORT_ENABLED:'true',LIBRARY_PROJECTS:JSON.stringify(policies),LIBRARY_AUTH_CONFIG:auth,LIBRARY_CATALOG:{idFromName:()=>({}),get:()=>({fetch:async()=>{throw new Error('private downstream detail');}})} as unknown as DurableObjectNamespace};
  const reply=await entry.fetch(new Request('https://local/v1/library/project-a/snapshot',{method:'POST',headers:{authorization:`Bearer ${token('owner')}`}}),env);
  expect(reply.status).toBe(503);expect(await reply.json()).toEqual({ok:false,code:'temporarily-unavailable'});expect(reply.headers.get('cache-control')).toBe('no-store');
 });
 it('rejects invalid host maps before addressing any project object',async()=>{
  const env:LibraryEnvironment={LIBRARY_ENVIRONMENT:'local',LIBRARY_AUTHORITY_NAME:'catalog',LIBRARY_TRANSPORT_ENABLED:'true',LIBRARY_PROJECTS:JSON.stringify(policies),LIBRARY_AUTH_CONFIG:'not-json'};
  const reply=await entry.fetch(new Request('https://local/v1/library/project-a/snapshot',{method:'POST'}),env);
  expect(reply.status).toBe(503);expect(await reply.json()).toEqual({ok:false,code:'library-unconfigured'});
 });
});

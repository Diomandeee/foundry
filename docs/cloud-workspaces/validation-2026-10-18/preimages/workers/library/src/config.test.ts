import {describe,it,expect} from 'vitest';
import {projects,route,policyDigest,authConfigured,type LibraryEnvironment} from './config';
const policy={projectId:'project-a',policyVersion:'v1',ownerPrincipal:'owner',writerPrincipal:'writer',verifierPrincipal:'verifier'};
const env:LibraryEnvironment={LIBRARY_ENVIRONMENT:'local',LIBRARY_AUTHORITY_NAME:'catalog',LIBRARY_PROJECTS:JSON.stringify([policy])};
describe('fixed project Library routing',()=>{
 it('validates the entire bounded host allowlist',()=>{
  expect(projects(env)).toEqual([policy]);
  for(const entries of [[],[policy,policy],[{...policy,extra:true}],[{...policy,projectId:'a\n'}],[{...policy,verifierPrincipal:'writer'}]])expect(()=>projects({...env,LIBRARY_PROJECTS:JSON.stringify(entries)})).toThrow('library-unconfigured');
  expect(()=>projects({...env,LIBRARY_ENVIRONMENT:'local\n'})).toThrow();
 });
 it('admits only exact project paths without alternate routing fields',()=>{
  expect(route(new Request('https://test/v1/library/project-a/commands',{method:'POST'}))).toEqual({projectId:'project-a',action:'commands'});
  for(const url of ['http://test/v1/library/project-a/commands','https://test/v1/library/project-a/commands?project=other','https://test/v1/library/project-a%2Fother/commands','https://test/v1/library/project-a/snapshot/'])expect(()=>route(new Request(url,{method:'POST'}))).toThrow();
  expect(()=>route(new Request('https://test/v1/library/project-a/snapshot'))).toThrow('post-required');
 });
 it('rejects broken host authentication maps separately from caller credentials',()=>{
  expect(()=>authConfigured({...env,LIBRARY_AUTH_CONFIG:'[]'})).not.toThrow();
  for(const config of [undefined,'{','{}','[{}]'])expect(()=>authConfigured({...env,LIBRARY_AUTH_CONFIG:config})).toThrow('library-unconfigured');
 });
 it('pins all authority, project and principal bindings independent of key order',()=>{
  const digest=policyDigest(env,policy);
  expect(policyDigest(env,{verifierPrincipal:'verifier',writerPrincipal:'writer',ownerPrincipal:'owner',policyVersion:'v1',projectId:'project-a'})).toBe(digest);
  for(const key of Object.keys(policy) as (keyof typeof policy)[])expect(policyDigest(env,{...policy,[key]:'changed'})).not.toBe(digest);
 });
});

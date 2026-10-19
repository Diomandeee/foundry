import {describe,it,expect,vi} from 'vitest';
import {parseVerifyConfig,verifyAttempt,type VerifyConfig} from './verify.js';
import {receipt} from './test-fixtures.js';
const c:VerifyConfig={version:1,origin:'https://compute.test',environment:'test',authorityId:'test-authority',expectedEpoch:4,attemptId:'test-attempt',jobId:'test-job',
  verifierCredentialRef:'TEST_VERIFIER_REF',otherCredentialRefs:['TEST_EXECUTOR_REF','TEST_ACCESS_REF','TEST_PROVIDER_REF'],approvalReceiptSha256:receipt};
const reply={ok:true,verified:true,jobId:c.jobId,attemptId:c.attemptId,source:{environment:c.environment,authorityId:c.authorityId,epoch:c.expectedEpoch}};
const response=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
describe('independent build verifier',()=>{
  it('calls exact authenticated endpoint once with approved job, authority, attempt and epoch',async()=>{
    const credential=vi.fn((_reference:string)=> 'v'.repeat(40));
    const fetch=vi.fn(async(url:Parameters<typeof globalThis.fetch>[0],init?:RequestInit)=>{
      expect(url).toBe('https://compute.test/v1/builds/verify-target');expect(init?.redirect).toBe('error');expect(init).toHaveProperty('credentials','omit');
      expect(JSON.parse(init!.body as string)).toEqual({environment:'test',authorityId:'test-authority',jobId:'test-job',expectedEpoch:4,attemptId:'test-attempt'});
      expect(init?.headers).toEqual({'content-type':'application/json',authorization:'Bearer '+'v'.repeat(40)});return response(reply);
    });
    const result=await verifyAttempt(c,receipt,new AbortController().signal,{credential,fetch});
    expect(result.state).toBe('verified');expect(fetch).toHaveBeenCalledTimes(1);expect(credential.mock.calls.every(args=>args[0]==='TEST_VERIFIER_REF')).toBe(true);
  });
  it.each([{...reply,verified:false},{...reply,attemptId:'wrong'},{...reply,jobId:'wrong'},{...reply,extra:true},{...reply,source:{...reply.source,authorityId:'wrong'}},{...reply,source:{...reply.source,environment:'wrong'}},{...reply,source:{...reply.source,epoch:5}},{ok:true}])('rejects incomplete or mismatched receipts',async value=>{
    const fetch=vi.fn(async()=>response(value));await expect(verifyAttempt(c,receipt,new AbortController().signal,{credential:()=> 'v'.repeat(40),fetch})).rejects.toThrow('unconfirmed');expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('accepts only the actual server replay receipt',async()=>{
    expect((await verifyAttempt(c,receipt,new AbortController().signal,{credential:()=> 'v'.repeat(40),fetch:async()=>response({...reply,replayed:true})})).replayed).toBe(true);
  });
  it('does not resolve credentials on missing approval or cancellation',async()=>{
    const credential=vi.fn((_reference:string)=> 'v'.repeat(40)),fetch=vi.fn(),abort=new AbortController();
    await expect(verifyAttempt(c,'wrong',abort.signal,{credential,fetch})).rejects.toThrow();abort.abort();
    await expect(verifyAttempt(c,receipt,abort.signal,{credential,fetch})).rejects.toThrow();expect(credential).not.toHaveBeenCalled();
  });
  it('rejects reference reuse and unknown configuration fields',()=>{
    expect(()=>parseVerifyConfig({...c,verifierCredentialRef:'TEST_ACCESS_REF'})).toThrow();expect(()=>parseVerifyConfig({...c,token:'secret'})).toThrow();
  });
  it.each([403,409,503])('keeps HTTP %s unconfirmed without retry',async status=>{
    const fetch=vi.fn(async()=>response(reply,status));await expect(verifyAttempt(c,receipt,new AbortController().signal,{credential:()=> 'v'.repeat(40),fetch})).rejects.toThrow('unconfirmed');expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects oversized streams and cancelled late replies',async()=>{
    await expect(verifyAttempt(c,receipt,new AbortController().signal,{credential:()=> 'v'.repeat(40),fetch:async()=>response('x'.repeat(20000))})).rejects.toThrow('unconfirmed');
    const abort=new AbortController();await expect(verifyAttempt(c,receipt,abort.signal,{credential:()=> 'v'.repeat(40),fetch:async()=>{abort.abort();return response(reply);}})).rejects.toThrow('unconfirmed');
  });
});

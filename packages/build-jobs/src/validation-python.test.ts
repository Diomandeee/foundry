import {describe,expect,it} from 'vitest';
import {profile} from './validation';
const image=`python@sha256:${'b'.repeat(64)}`;
const base=()=>({version:1,projectId:'comp-core',kind:'linux-build-v1',limits:{cpu:2,ramMib:2048,estimatedAdditionalBytes:1024**3,timeoutMs:120000,maxOutputBytes:1048576},
  recipe:{image,architecture:'x64',tool:'python',args:['-m','pytest','-q'],network:'none'},outputPaths:['out/junit.xml'],trustedProject:true,workerOptInRequired:true});
describe('python linux profiles',()=>{
  it('accepts python with and without installArgs',()=>{
    expect(()=>profile(base())).not.toThrow();
    const p=base();(p.recipe as any).installArgs=['--find-links','/work/source/wheels','numpy','pytest'];
    expect(()=>profile(p)).not.toThrow();
  });
  it('rejects installArgs on npm, empty installArgs and control characters',()=>{
    const npm=base();(npm.recipe as any).tool='npm';(npm.recipe as any).installArgs=['x'];
    expect(()=>profile(npm)).toThrow('linux-install-args');
    const empty=base();(empty.recipe as any).installArgs=[];
    expect(()=>profile(empty)).toThrow('linux-install-args');
    const bad=base();(bad.recipe as any).installArgs=['a\nb'];
    expect(()=>profile(bad)).toThrow('invalid-text');
  });
});

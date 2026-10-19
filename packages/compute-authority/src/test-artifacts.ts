// Shared deterministic staging fixture. Tests never trust worker-supplied hashes.
import {createHash} from 'node:crypto';
import {ComputeAuthority} from './authority.js';
export const ARTIFACT_BYTES=Buffer.from('x'.repeat(100));
export const POLICY={kind:'cpu-job',exitCode:0,stdoutSha256:createHash('sha256').update(ARTIFACT_BYTES).digest('hex')};
export const RESULT={outcome:'exited',exitCode:0,stdoutSha256:POLICY.stdoutSha256,stdoutBytes:100,artifactRef:'test-output'};
export function testAuthority(now:()=>number=Date.now,maxLifetimeMs=3_600_000){
 return new ComputeAuthority(now,maxLifetimeMs,{readArtifact:ref=>ref==='test-output'?ARTIFACT_BYTES:null});
}

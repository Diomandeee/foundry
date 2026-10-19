import {exact,need,digest,text} from './validation';
/** Owner-reviewed image observation, not host Xcode discovery or a trust tier. */
export interface MacVmCapability {
  version:1;backend:'apple-vz-macos-v1';architecture:'arm64';
  bootSha256:string;guestRunnerSha256:string;vmHelperSha256:string;treeGuardSha256:string;
  macos:string;developerDir:string;xcodeBuild:string;sdks:string[];
}
export function validateMacVmCapability(value:unknown):asserts value is MacVmCapability {
  const c=value as MacVmCapability;
  exact(c,['version','backend','architecture','bootSha256','guestRunnerSha256','vmHelperSha256','treeGuardSha256','macos','developerDir','xcodeBuild','sdks']);
  need(c.version===1&&c.backend==='apple-vz-macos-v1'&&c.architecture==='arm64','vm-capability-version',400);
  for(const d of [c.bootSha256,c.guestRunnerSha256,c.vmHelperSha256,c.treeGuardSha256])digest(d);
  text(c.macos);need(/^\d+(\.\d+){1,2}$/.test(c.macos),'vm-capability-macos',400);
  text(c.developerDir);need(/^\/Applications\/Xcode[^/]*\.app\/Contents\/Developer$/.test(c.developerDir),'vm-capability-developer-dir',400);
  text(c.xcodeBuild);need(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(c.xcodeBuild),'vm-capability-xcode',400);
  need(Array.isArray(c.sdks)&&c.sdks.length>0&&c.sdks.length<=64&&new Set(c.sdks).size===c.sdks.length,'vm-capability-sdks',400);
  for(const s of c.sdks){text(s);need(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(s),'vm-capability-sdk',400);}
}

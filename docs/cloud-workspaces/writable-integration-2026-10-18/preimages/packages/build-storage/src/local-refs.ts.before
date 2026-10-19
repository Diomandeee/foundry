import * as v from '../../build-jobs/src/validation';
import {check} from './checks';
import type {LocalRef} from './types';

export function shardedLocalRef(sha256:string,sizeBytes:number):LocalRef {
  v.digest(sha256); v.uint(sizeBytes,1,1048576);
  return {kind:'local-cas',sha256,sizeBytes,relativePath:`sha256/${sha256.slice(0,2)}/${sha256.slice(2,4)}/sha256-${sha256}`};
}
export function validateLocalRef(ref:LocalRef,sharded=false) {
  v.exact(ref,['kind','sha256','sizeBytes','relativePath']); v.digest(ref.sha256); v.uint(ref.sizeBytes,1,1048576);
  check(ref.kind==='local-cas'&&(ref.relativePath===shardedLocalRef(ref.sha256,ref.sizeBytes).relativePath||
    (!sharded&&ref.relativePath===`sha256-${ref.sha256}`)),'local-ref-layout');
}

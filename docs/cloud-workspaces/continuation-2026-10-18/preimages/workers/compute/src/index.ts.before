import type { AuthorityEnvironment } from './authority';
import { jsonResponse } from './http';
export { ComputeAuthority } from './authority';

/** A fixed configured authority; client namespace and identity hints are ignored. */
export default {
  async fetch(request:Request,env:AuthorityEnvironment):Promise<Response>{
    if(env.COMPUTE_TRANSPORT_ENABLED!=='true')return new Response('Compute transport is not enabled',{status:503});
    if(!env.AUTHORITY||!env.COMPUTE_AUTHORITY_NAME||!env.COMPUTE_ENVIRONMENT||!/^[A-Za-z0-9._-]{1,64}$/.test(env.COMPUTE_AUTHORITY_NAME))return jsonResponse({ok:false,code:'transport-unconfigured'},503);
    return env.AUTHORITY.get(env.AUTHORITY.idFromName(`${env.COMPUTE_ENVIRONMENT}:${env.COMPUTE_AUTHORITY_NAME}`)).fetch(request);
  },
};

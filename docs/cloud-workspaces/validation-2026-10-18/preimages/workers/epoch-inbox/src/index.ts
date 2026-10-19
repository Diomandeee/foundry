import type {EpochEnvironment} from './authority';
import {jsonResponse} from '../../compute/src/http';
export {EpochInboxAuthority} from './authority';
export default {
 async fetch(request:Request,env:EpochEnvironment):Promise<Response>{
  if(env.EPOCH_TRANSPORT_ENABLED!=='true')return jsonResponse({ok:false,code:'epoch-transport-disabled'},503);
  if(!env.EPOCH_INBOX||!/^[A-Za-z0-9._-]{1,64}$/.test(env.EPOCH_ENVIRONMENT??'')||!/^[A-Za-z0-9._-]{1,64}$/.test(env.EPOCH_AUTHORITY_NAME??''))return jsonResponse({ok:false,code:'epoch-transport-unconfigured'},503);
  return env.EPOCH_INBOX.get(env.EPOCH_INBOX.idFromName(`${env.EPOCH_ENVIRONMENT}:${env.EPOCH_AUTHORITY_NAME}`)).fetch(request);
 }
};

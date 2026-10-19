import type {PipelineEnvironment} from './authority';
import {jsonResponse} from '../../compute/src/http';
export {EpochPipelineAuthority} from './authority';
export default {async fetch(request:Request,env:PipelineEnvironment):Promise<Response>{
 if(env.EPOCH_TRANSPORT_ENABLED!=='true')return jsonResponse({ok:false,code:'pipeline-disabled'},503);
 if(!env.EPOCH_PIPELINE||!/^[A-Za-z0-9._-]{1,64}$/.test(env.EPOCH_ENVIRONMENT??'')||!/^[A-Za-z0-9._-]{1,64}$/.test(env.EPOCH_AUTHORITY_NAME??''))return jsonResponse({ok:false,code:'pipeline-unconfigured'},503);
 return env.EPOCH_PIPELINE.get(env.EPOCH_PIPELINE.idFromName(`${env.EPOCH_ENVIRONMENT}:${env.EPOCH_AUTHORITY_NAME}`)).fetch(request);
}};

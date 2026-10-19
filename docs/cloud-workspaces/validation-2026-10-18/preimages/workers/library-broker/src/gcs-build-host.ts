import {createGcsReader,type GcsHostConfig} from '../../../packages/library-gcs/src/index';
import {createGcsWriter} from '../../../packages/build-storage/src/gcs-writer';
import type {GcsWritePorts} from '../../../packages/build-storage/src/types';
import {createBuildBrokerHost,type BuildBrokerConfig} from './build-host';

export interface GcsBuildBrokerConfig extends Omit<BuildBrokerConfig,'providerRead'|'providerWriter'> {
  gcs:GcsHostConfig;provider:GcsWritePorts;
}
/** Inert service composition. Uses the existing actual create-only writer and
 * generation+metageneration-pinned reader; no ambient gcloud/SDK identity. No
 * server listen(), credential lookup, bucket change or provider call here. */
export function createGcsBuildBrokerHost(config:GcsBuildBrokerConfig){
  if(config.gcs.projectId!==config.approval.scope.projectId)throw new Error('build-broker: logical-project-binding');
  const reader=createGcsReader(config.gcs,{getAccessToken:(ref,signal)=>config.provider.getAccessToken(ref,signal),
    fetch:(url,init)=>config.provider.fetch(url,{...init,credentials:'omit'})});
  const writer=createGcsWriter(config.gcs,config.provider);
  return createBuildBrokerHost({...config,providerRead:reader.readObject,providerWriter:writer});
}

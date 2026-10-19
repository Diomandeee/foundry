import {canonical} from '../../../packages/library-jobs/src/data';
import {createGcsBuildBrokerHost,type GcsBuildBrokerConfig} from './gcs-build-host';
import type {ProjectInputRouteRequest} from '../../../packages/build-storage/src/project-input-io';
import {projectInputOperationKey} from '../../../packages/build-storage/src/project-input-io';

/** Explicit finite host-approved set. New scopes, DB files, grants, credentials and
 * bucket policies are never created by selection. All constructor DB handles must
 * already be supplied by the trusted host. Scope/credential authority is private. */
export function createBuildNamespaceSet(configs:readonly GcsBuildBrokerConfig[]){
  if(!Array.isArray(configs)||configs.length<1||configs.length>512)throw new Error('build-namespace-set-budget');
  const sorted=[...configs].sort((a,b)=>a.approval.namespaceRef.localeCompare(b.approval.namespaceRef));
  const ids=new Set<string>(),databases=new Set<unknown>();
  const first=sorted[0]!,scope=first.approval.scope;
  for(const c of sorted){
    if(ids.has(c.approval.namespaceRef)||databases.has(c.controlDb)||databases.has(c.brokerDb)||c.controlDb===c.brokerDb||
      c.environment!==first.environment||c.authorityId!==first.authorityId||c.ownerPrincipal!==first.ownerPrincipal||
      c.approval.profileHash!==first.approval.profileHash||c.approval.scope.projectId!==scope.projectId||c.approval.scope.principalRef!==scope.principalRef||canonical(c.approval.scope.compute)!==canonical(scope.compute))throw new Error('build-namespace-set-binding');
    ids.add(c.approval.namespaceRef);databases.add(c.controlDb);databases.add(c.brokerDb);
  }
  const hosts=sorted.map(createGcsBuildBrokerHost);
  const approvals=sorted.map(c=>JSON.parse(canonical(c.approval)) as GcsBuildBrokerConfig['approval']);
  const namespaces=hosts.map(host=>({scope:host.scope,issuer:host.issuer,capacity:host.capacity,writer:host.writer,reader:host.reader}));
  const selectNamespace=async(request:ProjectInputRouteRequest,signal:AbortSignal):Promise<string>=>{
    if(signal.aborted||!['read','publish'].includes(request.operation)||!['objects','manifests'].includes(request.kind)||
      !Number.isSafeInteger(request.sizeBytes)||request.sizeBytes<1||request.sizeBytes>1048576)throw new Error('build-namespace-selection');
    // Read routing is pinned to an exact approved reference. A publication uses
    // only a namespace whose immutable approval permits trusted publication.
    const permitted=(i:number)=>request.operation==='publish'?approvals[i]!.publication:
      request.ref!==null&&hosts[i]!.allowsRef(request.ref);
    const recovered=hosts.map((host,i)=>({host,i,receipt:host.reservation(projectInputOperationKey(host.scope,request))})).filter(x=>x.receipt!==null);
    if(recovered.length>1)throw new Error('build-namespace-reservation-ambiguous');
    if(recovered.length===1){const prior=recovered[0]!;if(!prior.host.isActive())throw new Error('build-prior-namespace-inactive-reconciliation-required');if(!permitted(prior.i)||prior.receipt!.artifacts!==1||prior.receipt!.bytes!==request.sizeBytes)throw new Error('build-namespace-reservation-conflict');return prior.host.scope.namespaceRef;}
    for(let i=0;i<hosts.length;i++){
      const approval=approvals[i]!;
      if(hosts[i]!.isActive()&&permitted(i)&&hosts[i]!.admission(1,request.sizeBytes).eligible)return approval.namespaceRef;
    }
    // Do not retry a reservation failure in a new namespace. Selection is a
    // capacity hint; the chosen durable transaction still owns final admission.
    throw new Error('build-approved-namespace-set-exhausted-or-object-unapproved');
  };
  return Object.freeze({routing:Object.freeze({namespaces:Object.freeze(namespaces),selectNamespace}),
    hosts:Object.freeze(hosts)});
}

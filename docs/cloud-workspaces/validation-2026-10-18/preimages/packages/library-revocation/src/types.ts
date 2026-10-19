import type {TransferBinding,TransactionPort} from '../../library-catalog/src/types';
export type {TransactionPort,TransferBinding};
export interface RevocationContext {environment:string;principal:string;role:'owner'|'dispatcher'}
export interface RevocationOptions {environment:string;authorityId:string;sourceAuthorityId:string;ownerPrincipal:string;dispatcherPrincipal:string;now?:()=>number}
export interface FenceEvent {seq:number;kind:'noop'|'lease-revoked'|'epoch-bumped'|'worker-quarantined'|'workload-cancelled';epoch:number;leaseId:string|null;workloadId:string|null;workerId:string|null;generation:number|null;incarnation:number|null}
export interface FencePage {version:1;environment:string;authorityId:string;epoch:number;after:number;through:number;head:number;events:FenceEvent[]}
export interface RevocationTarget {version:1;targetId:string;kind:'catalog'|'broker';environment:string;authorityId:string;projectId:string;resourceId:string;generation:number;binding:TransferBinding}
export interface Delivery {version:1;deliveryId:string;revision:number;target:RevocationTarget;event:FenceEvent;evidenceId:string;key:string}
export interface DeliveryReceipt {version:1;deliveryId:string;evidenceId:string;targetId:string;status:'revoked'|'already-revoked'|'superseded'}
export interface DeliveryPort {deliver(delivery:Delivery):Promise<unknown>}
export class RevocationRejected extends Error {constructor(public code:string,public status=409){super(code);this.name='RevocationRejected';}}

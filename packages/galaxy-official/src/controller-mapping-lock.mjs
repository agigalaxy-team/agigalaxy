import {ServiceError} from './shared/service-error.mjs';
import {createHash} from 'node:crypto';

const namespace='galaxy-controller-mapping/v1';
const namespaceKey=0x47434d31;
// A lock exists even when no association row exists, covering a concurrent
// first link as well as revoke/removal. Namespace and endpoint+subject isolate
// unrelated controllers; hash collisions only cause extra serialization.
export function controllerMappingLockKeys(endpoint,subjectIds){
 if(typeof endpoint!=='string'||!endpoint.length||!Array.isArray(subjectIds)||subjectIds.some(id=>typeof id!=='string'||!id.length))
  throw new ServiceError('chat_control_relationship_unavailable',503);
 return [...new Set(subjectIds.map(id=>createHash('sha256').update(JSON.stringify([namespace,endpoint,id])).digest().readInt32BE(0)))].sort((a,b)=>a-b);
}
export async function lockControllerMappingsWithin(db,endpoint,subjectIds,{exclusive=false}={}){
 // Sort physical keys, not just subject names: even a hash collision cannot
 // reverse the acquisition order of two overlapping controller batches.
 for(const key of controllerMappingLockKeys(endpoint,subjectIds))await db.query(`SELECT ${exclusive?'pg_advisory_xact_lock':'pg_advisory_xact_lock_shared'}($1,$2)`,[namespaceKey,key]);
}

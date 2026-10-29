import {isDeepStrictEqual} from 'node:util';
import {serviceConnectionBinding,serviceConnectionKinds,serviceConnectionConsumerReadbackSchema} from '../../../galaxy-contracts/src/operations-service-connections-schema.mjs';

export const serviceConnectionReceiptFiles=Object.freeze({api:'/var/log/galaxy/pilot/api/service-connections-adopted.json',worker:'/var/log/galaxy/pilot/worker/service-connections-adopted.json'});

export function serviceConnectionAdopted({observation,configuration,versionId,component,pid}){
 const parsed=serviceConnectionConsumerReadbackSchema.safeParse(observation);if(!parsed.success)return false;
 const value=parsed.data;if(value.component!==component||value.versionId!==versionId||value.pid!==pid)return false;
 const matches=value.connections.filter(row=>row.configuration.id===configuration.id&&row.configuration.kind===configuration.kind);
 return matches.length===1&&serviceConnectionMatches(matches[0].configuration,configuration)&&(configuration.kind==='file-scanning'||matches[0].credentialsConfigured===true);
}

export function serviceConnectionTargets(configuration){return configuration.kind==='ai-execution'?['api']:['api','worker'];}
export function serviceConnectionMatches(left,right){try{return isDeepStrictEqual(serviceConnectionBinding(left),serviceConnectionBinding(right));}catch{return false;}}
export {serviceConnectionKinds};

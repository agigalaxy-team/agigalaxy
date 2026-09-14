import * as z from 'zod/v4';
import {createNativeA2aHostV2} from '../../../galaxy-a2a/src/host-flow-v2.mjs';

const authentication = z.discriminatedUnion('mode', [
 z.strictObject({mode:z.literal('none')}),
 z.strictObject({mode:z.literal('bearer-environment'),variable:z.string().regex(/^GALAXY_A2A_PEER_[A-Z0-9_]{1,80}_TOKEN$/)}),
]);
export const nativeA2aSchema = z.strictObject({peers:z.array(z.strictObject({
 id:z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),name:z.string().max(160).optional(),endpoint:z.url(),tenant:z.string().max(256).optional(),
 peerPrincipal:z.string().min(1).max(160),agentCard:z.record(z.string(),z.unknown()),cardHash:z.string().regex(/^[0-9a-f]{64}$/),
 trustExpiresAt:z.number().int().positive(),authentication:authentication.default({mode:'none'}),
})).min(1).max(32)}).refine(config=>new Set(config.peers.map(p=>p.id)).size===config.peers.length,'Unique peer IDs required');

// Only the explicitly named child-process variable is read, only when this peer
// is actually used. No Official token, environment discovery or credential file
// enters the public configuration, peer listing, preview or persistent journal.
export function createConfiguredNativeA2a({runtime,directory,configuration,environment=process.env}) {
 const config=nativeA2aSchema.parse(configuration);
 const peers=config.peers.map(({authentication,...peer})=>peer);
 return createNativeA2aHostV2({runtime,directory,peers,readPeerAuthorization:async scope=>{
  const selected=config.peers.find(peer=>peer.id===scope.peerId);
  if(!selected||selected.endpoint!==scope.endpoint||selected.peerPrincipal!==scope.peerPrincipal||selected.cardHash!==scope.cardHash
   ||(selected.tenant??'')!==scope.tenant)throw new Error('Selected external authorization scope changed.');
  const authorization={subjectId:scope.subjectId,peerPrincipal:scope.peerPrincipal};
  if(selected.authentication.mode==='bearer-environment'){
   const credential=environment[selected.authentication.variable];
   if(typeof credential!=='string'||!/^[A-Za-z0-9._~+/-]{1,4096}={0,2}$/.test(credential))throw new Error('Configured external credential unavailable.');
   return {...authorization,credential};
  }
  return authorization;
 }});
}

import {randomUUID} from 'node:crypto';
import {maintenanceRequestSignature} from "../support/maintenance-signature.mjs";

const fail=()=>Object.assign(Error('maintenance_prosody_live_component_readiness_unconfirmed'),{code:'maintenance_prosody_live_component_readiness_unconfirmed'});
// The same protected loopback service identity used for maintenance approval.
// No URL, subject, room, stanza or message selection comes from the caller.
export function createMaintenanceProsodyProbe({configuration,fetchImpl=fetch,now=()=>Math.floor(Date.now()/1000)}){
 if(!/^http:\/\/127[.]0[.]0[.]1:[0-9]{1,5}\/v1\/internal\/maintenance\/authorize$/.test(configuration?.authorizationUrl??'')||typeof configuration.serviceKey!=='string'||configuration.serviceKey.length<32)throw fail();
 const url=configuration.authorizationUrl.replace(/\/authorize$/,'/chat-probe');
 return async function probe({operationId=null}={}){
  if(operationId!==null&&!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(operationId))throw fail();
  const body=JSON.stringify({version:1,kind:'prosody-current-state',operationId}),id=randomUUID(),at=String(now());let response;
  try{response=await fetchImpl(url,{method:'POST',redirect:'error',headers:{'content-type':'application/json','x-forwarded-for':'127.0.0.1','x-galaxy-service-key':configuration.serviceKey,'x-galaxy-request-id':id,'x-galaxy-request-at':at,'x-galaxy-service-signature':maintenanceRequestSignature(configuration.serviceKey,{id,at,body})},body,signal:AbortSignal.timeout(6000)});
   if(response.status!==200)throw fail();const raw=await response.text();if(Buffer.byteLength(raw)>2048)throw fail();const value=JSON.parse(raw);
   if(Object.keys(value).sort().join(',')!=='authenticatedGateway,bodyReturned,readOnly,roomsDomain,roundTrip'||value.authenticatedGateway!==true||value.roundTrip!==true||value.roomsDomain!=='rooms.galaxy.internal'||value.readOnly!==true||value.bodyReturned!==false)throw fail();return value;
  }catch{throw fail();}
 };
}

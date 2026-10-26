import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {dispatchOperationsMaintenance} from '../src/adapters/http/operations-maintenance-http.mjs';
import {MaintenanceNativeClient,maintenanceRequestSignature} from "../src/operations/maintenance/native.mjs";

test('fixed maintenance chat readiness authenticates before body and projects only the existing-connection acknowledgement',async()=>{
 const key='SYNTHETIC_MAINTENANCE_READINESS_KEY_ONLY',native=new MaintenanceNativeClient({key}),path='/v1/internal/maintenance/chat-probe';let probes=0,bodyReads=0;
 const acknowledgement={authenticatedGateway:true,roomsDomain:'rooms.galaxy.internal',roundTrip:true,readOnly:true,bodyReturned:false};
 const chat={async maintenanceReadiness(){probes++;return{...acknowledgement,internal:'DO_NOT_PROJECT'};}};
 async function call({input={version:1,kind:'prosody-current-state',operationId:null},remote='127.0.0.1',signed=true,method='POST',search='',service=chat}={}){
  const raw=JSON.stringify(input),id=randomUUID(),at=String(Math.floor(Date.now()/1000));
  const request=Readable.from((async function*(){bodyReads++;yield Buffer.from(raw);})());
  Object.assign(request,{method,socket:{remoteAddress:remote},headers:{'content-type':'application/json','x-galaxy-service-key':signed?key:'SYNTHETIC_WRONG_KEY','x-galaxy-request-id':id,'x-galaxy-request-at':at,'x-galaxy-service-signature':maintenanceRequestSignature(key,{id,at,body:raw})}});
  let result;const headers={};
  await dispatchOperationsMaintenance({maintenanceNative:native,chat:service,request,response:{setHeader(name,value){headers[name]=value;}},url:new URL('http://127.0.0.1'+path+search),send(status,value){result={status,value,headers};}});
  return result;
 }
 await assert.rejects(call({signed:false}),error=>error.status===401);assert.equal(bodyReads,0);assert.equal(probes,0);
 await assert.rejects(call({remote:'192.0.2.1'}),error=>error.status===401);assert.equal(bodyReads,0);
 await assert.rejects(call({search:'?room=anything'}),error=>error.status===404);assert.equal(bodyReads,0);
 await assert.rejects(call({input:{version:1,kind:'prosody-current-state',operationId:null,room:'PRIVATE'}}),error=>error.status===400);assert.equal(probes,0);
 const value=await call();assert.equal(value.status,200);assert.deepEqual(value.value,acknowledgement);assert.equal(value.headers['Cache-Control'],'no-store');assert.equal(probes,1);
 await assert.rejects(call({service:{async maintenanceReadiness(){throw Error('PRIVATE_TRANSPORT_ERROR');}}}),error=>error.status===503&&error.code==='maintenance_prosody_live_component_readiness_unconfirmed'&&!error.message.includes('PRIVATE'));
 await assert.rejects(call({service:{async maintenanceReadiness(){throw Object.assign(Error('PRIVATE_ACK'),{code:'chat_transport_invalid_reply'});}}}),error=>error.status===503&&error.code==='maintenance_prosody_probe_invalid_ack'&&!error.message.includes('PRIVATE'));
});

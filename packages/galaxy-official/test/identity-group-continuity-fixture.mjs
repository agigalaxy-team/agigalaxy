import {randomUUID} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createApi} from '../src/http.mjs';
import {createBrowserClient,browserScopes} from '../src/browser-client.mjs';
import {createIdentityGroupClientV2} from "../src/clients/identity-group-v2.mjs";
import {createIdentityGroupsWebClient} from "../../galaxy-web/src/features/identity-groups/identity-group-client.mjs";
import {digest} from '../src/shared/digest.mjs';
export async function identityGroupContinuityFixture(){
 const f=await serviceFixture(browserScopes,null,{now:Math.floor(Date.now()/1000),syntheticCommunityQuota:false}),p=await serviceFixture(browserScopes,f.db,{now:f.now,migrateDatabase:false,syntheticCommunityQuota:false}),q=await serviceFixture(browserScopes,f.db,{now:f.now,migrateDatabase:false,syntheticCommunityQuota:false});
 const server=createApi({...f,rateLimit:10000}),people={primary:f,secondary:p,outsider:q},apis={},runtimes={},locals={},fault={beforeWrite:false,lostAck:false},calls=[],packets=[],signatures={};
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 for(const [role,person]of Object.entries(people)){
  const publicKeyPem=person.genesis.genesisProof.publicKeyPem,deviceId=randomUUID(),keyId=digest(publicKeyPem),request={version:2,operationId:randomUUID(),subjectId:person.actor.subjectId,kind:'bootstrap',expectedEpoch:0,previousEventHash:null,signerKeyId:keyId,genesisProof:person.genesis.genesisProof,newDevice:{deviceId,publicKeyPem,scopes:['manage-identity',...browserScopes]}};
  const challenge=await person.identityControl.challenge(request),signature=await person.signForTest(challenge.challenge,'galaxy-identity-control-v2+jws');await person.identityControl.commit({operationId:request.operationId,controllerSignature:signature,newDeviceProof:signature});
  const api=createBrowserClient({endpoint:f.access.endpoint,trustedKeys:f.access.trustedKeys,now:()=>f.now,sign:person.signForTest,fetch:async(url,init)=>{
   const path=new URL(url).pathname;calls.push({role,path});if(path==='/v2/identity-groups/submit'){packets.push({role,...JSON.parse(init.body)});if(fault.beforeWrite)throw Error('Synthetic network lost before commit');}
   const response=await fetch(origin+path,init);if(path==='/v2/identity-groups/submit'&&fault.lostAck&&response.ok){fault.lostAck=false;await response.arrayBuffer();throw Error('Synthetic original ACK lost');}return response;
  }});
  const connect=()=>api.connect({subjectId:person.actor.subjectId,genesisProof:person.genesis.genesisProof,installationId:randomUUID(),scopes:browserScopes,control:{deviceId,keyId,epoch:1}},{confirmed:true});await connect();apis[role]={api,connect};
  const local=new Map();locals[role]=local;let tail=Promise.resolve();
  const get=async name=>structuredClone(local.get(name)),put=async(name,value)=>local.set(name,structuredClone(value)),atomic=(name,fn)=>{const next=tail.then(()=>{const value=fn(structuredClone(local.get(name)));local.set(name,structuredClone(value));return structuredClone(value);});tail=next.catch(()=>{});return next;};
  const capture=()=>{const before=api.snapshot();return{endpoint:api.endpoint,subjectId:before.subjectId,assertCurrent(){if(JSON.stringify(api.snapshot())!==JSON.stringify(before))throw Object.assign(Error('identity_group_identity_changed'),{code:'identity_group_identity_changed'});}};};
  const core=createIdentityGroupClientV2({api,subjectId:person.actor.subjectId,now:()=>f.now,getLocal:get,putLocal:put,sign:async(...args)=>{signatures[role]=(signatures[role]??0)+1;return person.signForTest(...args);}});
  runtimes[role]={api,identityGroups:core,receiptStatus:{captureLease:capture},getLocal:get,putLocal:put,updateLocal:atomic};
 }
 let consumerNow=f.now;
 const client=role=>createIdentityGroupsWebClient(runtimes[role],{subjectId:people[role].actor.subjectId,now:()=>consumerNow,locks:null});
 const payload=extra=>({schemaVersion:2,operationId:randomUUID(),groupId:randomUUID(),kind:'create',expectedVersion:0,previousOperationId:null,endpoint:f.access.endpoint,issuedAt:f.now,expiresAt:f.now+3600,memberIds:[f.actor.subjectId,p.actor.subjectId],canonicalDisplayId:f.actor.subjectId,visibility:'Private',viewers:[],sourceRefs:[],attributionCorrections:[],purpose:'canonical-display-only',capabilityMerged:false,accessGranted:false,...extra});
 return{f,p,q,origin,apis,runtimes,locals,fault,calls,packets,signatures,client,payload,setConsumerNow:value=>{consumerNow=value;},journal:role=>'identity-group-v2:'+f.access.endpoint+':'+people[role].actor.subjectId,
  async close(){for(const {api}of Object.values(apis))api.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await f.db.close();}};
}


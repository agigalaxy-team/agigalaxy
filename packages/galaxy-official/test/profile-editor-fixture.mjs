import {generateKeyPairSync} from 'node:crypto';
import {serviceFixture} from './service-fixture.mjs';
import {createServices} from '../src/services.mjs';
import {createApi} from '../src/http.mjs';
import {browserScopes} from '../src/browser-client.mjs';
import {createWebRuntime} from '../../galaxy-web/src/runtime.mjs';
import {createExistingWebRuntime} from './existing-web-identity-fixture.mjs';
import {createProfileEditorClient} from "../../galaxy-web/src/features/profiles/profile-editor-client.mjs";
import {digest} from '../src/shared/digest.mjs';
import {createNativeRecoveryWebFixture} from './native-recovery-web-fixture.mjs';

// The HTTP service, signatures, identity control and SQL are real. Only the
// local browser storage and deliberate response loss below are test adapters.
export async function profileEditorFixture(){
 let time=Math.floor(Date.now()/1000);
 const f=await serviceFixture(browserScopes,null,{now:time,syntheticCommunityQuota:false});
 const key=generateKeyPairSync('ed25519'),trustedKeys=new Map([['profile-editor',{publicKeyPem:key.publicKey.export({type:'spki',format:'pem'}),notBefore:time-1,notAfter:time+400*86400,revoked:false}]]);
 const services=createServices({db:f.db,endpoint:f.access.endpoint,kid:'profile-editor',signingKey:key.privateKey,trustedKeys,
  allowedScopes:browserScopes,operator:'Synthetic profile',region:'isolated',now:()=>time});
 const origin='https://galaxy.example.org',server=createApi({...services,browserOrigins:[origin],rateLimit:10000});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const local='http://127.0.0.1:'+server.address().port,config={endpoint:f.access.endpoint,trustedKeys},actors=[],trace=[];
 /** @type {{offline:boolean,dropProfile:boolean,dropConsent:boolean,waitReceipt:Promise<void>|null,blockProfile:(()=>boolean)|null}} */
 const faults={offline:false,dropProfile:false,dropConsent:false,waitReceipt:null,blockProfile:null};
 const wire=async(url,options)=>{
  const path=new URL(url).pathname;
  if(faults.offline)throw Error('Synthetic local offline');
  if(path==='/v1/profiles/statements'&&faults.blockProfile?.())throw Error('Synthetic offline profile submission');
  if(path==='/v1/profiles/statements/receipt'&&faults.waitReceipt){const wait=faults.waitReceipt;faults.waitReceipt=null;await wait;}
  const response=await fetch(local+path,{...options,headers:{...options.headers,Origin:origin}});
  const body=typeof options.body==='string'?JSON.parse(options.body):null;
  const row={path,status:response.status};
  if(body?.payloadJson){const payload=JSON.parse(body.payloadJson);Object.assign(row,{operationId:payload.id,payloadHash:digest(body.payloadJson),consentId:body.consentId});}
  if(body?.signedIntent)Object.assign(row,{signatureHash:digest(body.signedIntent)});
  trace.push(row);
  if(response.status===200&&((path==='/v1/profiles/statements'&&faults.dropProfile)||(path==='/v1/consents'&&faults.dropConsent))){
   if(path==='/v1/profiles/statements')faults.dropProfile=false;else faults.dropConsent=false;
   // Do not log or return the raw signed statement or credentials.
   await response.arrayBuffer();throw Error('Synthetic lost committed profile response');
  }
  return response;
 };
 async function actor({initialize=true,nativeRecovery=false}={}){
  const values=new Map(),store={get:async name=>structuredClone(values.get(name)),put:async(name,value)=>{values.set(name,structuredClone(value));},
   update:async(name,change)=>{const value=change(structuredClone(values.get(name)));values.set(name,structuredClone(value));return structuredClone(value);}};
   // Positive editors use an actual Native handoff. Recovery scenarios opt
   // into the existing test-only installed-client adapter, never Web APIs.
   const options={store,fetch:wire,now:()=>time},factory=nativeRecovery?createNativeRecoveryWebFixture:createExistingWebRuntime;
   let nativeReady=initialize&&nativeRecovery,runtime=await (initialize?factory:createWebRuntime)(config,options);
   const nativeCall=async(name,...args)=>{
    if(!nativeRecovery)throw Error('Explicit fixture Native recovery selection required.');
    // An explicitly empty browser stays empty until this Native operation.
    if(!nativeReady){runtime.close();runtime=await factory(config,options);nativeReady=true;}
    return runtime[name](...args);
   };
  if(initialize){await runtime.connect({confirmed:true});}
  const subjectId=runtime.api.snapshot()?.subjectId;
  const result={native:{prepareRecovery:(...args)=>nativeCall('prepareRecovery',...args),saveRecovery:(...args)=>nativeCall('saveRecovery',...args),recover:(...args)=>nativeCall('recover',...args),confirmRecoveredCode:(...args)=>nativeCall('confirmRecoveredCode',...args)},get runtime(){return runtime;},get subjectId(){return subjectId??runtime.api.snapshot()?.subjectId;},editor:()=>createProfileEditorClient(runtime,{now:()=>time}),
   async reload({connectNew=false}={}){runtime.close();runtime=await factory(config,options);
    if(connectNew)await runtime.connect({confirmed:true});else await runtime.resumeConnection();return runtime;}};
  actors.push(result);return result;
 }
 async function publicProfile(subjectId){const response=await fetch(local+'/v1/profiles/'+subjectId);if(response.status!==200)throw Error('Public profile request failed: '+response.status);return response.json();}
 return{...f,services,actor,publicProfile,trace,faults,now:()=>time,advance:seconds=>{time+=seconds;},
  async close(){for(const value of actors)value.runtime.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await f.db.close();}};
}

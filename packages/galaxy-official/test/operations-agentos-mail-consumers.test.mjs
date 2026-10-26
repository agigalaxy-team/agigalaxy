import test from 'node:test';
import assert from 'node:assert/strict';
import {UnifiedMailAdapter} from '../deploy/system-settings/mail-runtime.mjs';
import {SystemSettingsRuntime} from '../deploy/system-settings/runtime.mjs';
import {serviceConnectionKinds} from '../src/operations/system-settings/service-connections-schema.mjs';
import {systemSettingsNativeOverviewSchema} from '../src/operations/system-settings/read-model.mjs';
import {systemMailQuery,systemConnectionsQuery} from "../src/operations/agentos/query-extensions-view.mjs";

test('actual mail runtime observed and applied targets stay attributable without exposing credential references',async()=>{
 const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),version=id(30);
 let applied=false;
 const mail=new UnifiedMailAdapter({control:{endpoint:'https://synthetic.invalid',appliedMetadataFile:'/synthetic/metadata.json'},bridge:null,keycloak:null,
  resolveCredential:()=>{throw Error('No credential read permitted');},referenceKey:'synthetic-only-reference-key-for-local-test',transport:{},fileReader:async()=>{if(!applied)throw Error('No earlier application');return{value:{version:1,versionId:version,configuration:{}}};}});
 const connection=target=>mail.connection(target,mail.nullable({host:'smtp.synthetic.invalid',port:465,tls:'implicit'}),null,'synthetic');
 mail.operationalSource=async()=>connection('operations');mail.nativeSource=async realm=>connection(realm==='galaxy'?'website-authentication':'management-authentication');mail.alertSource=async()=>connection('runtime-alerts');
 const current=await mail.observed();
 const appliedTargets=['operations-worker','operations-api','website-authentication','management-authentication','runtime-alerts'];
 mail.readback=async()=>({state:'completed',configuration:current.configuration,items:appliedTargets.map((target,index)=>({target,id:id(index+1),state:'available',appliedVersionId:version,credentialConfigured:true,source:'consumer-ack'}))});
 const runtime=new SystemSettingsRuntime({directory:'/not-used',credentialStore:{metadata:async()=>[]},adapters:{mail},control:{},serviceKey:'synthetic-only-control',journal:{}});
 const wrap=native=>({section:'mail',revision:0,version:null,configuration:native.observedConfiguration,configurationBasis:'observed-current',...native,pending:null});
 const observed=await runtime.overview('mail'),observedResult=systemMailQuery(wrap(observed));
 assert.deepEqual(observed.current.map(row=>row.target),['operations','website-authentication','management-authentication','runtime-alerts']);
 assert.deepEqual(observedResult.current,observed.current,'Actual unadopted native-realm rows must retain target and unknown, not guess adoption');
 applied=true;const adopted=await runtime.overview('mail'),adoptedResult=systemMailQuery(wrap(adopted));
 assert.deepEqual(adopted.current.map(row=>row.target).sort(),[...appliedTargets].sort());
 assert.deepEqual(adoptedResult.current,adopted.current,'All five phase targets retain their own connection/adopted-version fields');
 assert(adoptedResult.current.every(row=>row.adoptedVersionId===version));
 const unknown=systemSettingsNativeOverviewSchema.parse({...adopted,current:[{...adopted.current[0],target:'unknown-private-target'}]});
 assert.equal(systemMailQuery(wrap(unknown)).current[0].target,null,'Unknown values never become free text');
 const services=systemSettingsNativeOverviewSchema.parse({...adopted,current:serviceConnectionKinds.map(target=>({...adopted.current[0],target}))});
 assert.deepEqual(systemConnectionsQuery({configuration:{connections:[]},...services}).current,services.current,'Earlier five-service fix remains intact');
 for(const result of [observedResult,adoptedResult])assert.doesNotMatch(JSON.stringify(result),/credentialRef|system-key:|"reference"|"password"/);
});

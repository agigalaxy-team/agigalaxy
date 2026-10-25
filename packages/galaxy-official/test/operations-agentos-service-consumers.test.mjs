import test from 'node:test';
import assert from 'node:assert/strict';
import {systemSettingsNativeOverviewSchema} from '../src/operations/system-settings/read-model.mjs';
import {serviceConnectionKinds,serviceConnectionsConfigurationSchema} from '../src/operations/system-settings/service-connections-schema.mjs';
import {systemConnectionsQuery} from '../src/operations-agentos-query-extensions-view.mjs';

test('actual service current target and credential metadata survive the safe AI projection',()=>{
 const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
 const configuration=serviceConnectionsConfigurationSchema.parse({connections:serviceConnectionKinds.map((kind,index)=>({id:uuid(index+1),kind,...(kind==='file-scanning'?{host:'127.0.0.1',port:3310,timeoutMs:1000}:{url:'https://'+kind+'.synthetic.invalid',credentialRef:'system-key:'+uuid(index+100)}),...(kind==='analysis'?{projectId:uuid(20),clientId:uuid(21),readClientId:uuid(22)}:{}),...(kind==='search'?{index:'public-content'}:{})}))});
 const native=systemSettingsNativeOverviewSchema.parse({availability:{state:'available'},current:serviceConnectionKinds.map((target,index)=>({target,state:'configured',adoptedVersionId:uuid(index+30),connectionId:uuid(index+1),source:'consumer-ack',configured:true})),credentials:serviceConnectionKinds.filter(kind=>kind!=='file-scanning').map((kind,index)=>({reference:'system-key:'+uuid(index+100),connectionId:uuid(index+1),configured:index%2===0})),observedConfiguration:null,capabilities:{canTest:true,canApply:true,canWriteCredential:true}});
 const result=systemConnectionsQuery({section:'service-connections',revision:5,version:{id:uuid(50),revision:5,createdAt:'2026-10-25T00:00:00Z'},configuration,configurationBasis:'saved-version',...native,pending:null});
 assert.deepEqual(result.current,native.current,'All five real target names and their corresponding actual adopted version stay paired');
 assert.deepEqual(result.configuration.connections.map(row=>row.credentialsConfigured),[true,false,true,false,null],'Credential metadata uses connectionId/configured; false is real false, scanner is not a credential connection');
 assert.doesNotMatch(JSON.stringify(result),/credentialRef|system-key:|"reference"|projectId|clientId|readClientId/);
 const unknown=systemSettingsNativeOverviewSchema.parse({...native,current:[{...native.current[0],target:'arbitrary-private-target',state:'unknown',configured:null,adoptedVersionId:null}]});
 const unknownResult=systemConnectionsQuery({configuration,revision:5,...unknown});
 assert.equal(unknownResult.current[0].target,null,'Unknown stored targets never become free text');
 assert.equal(unknownResult.current[0].adoptedVersionId,null);
 assert.equal(unknownResult.current[0].configured,null);
});

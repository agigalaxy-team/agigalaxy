import assert from 'node:assert/strict';
import test from 'node:test';
import {modelSettingsClone,modelSettingsConflictValue,modelSettingsEmpty,modelSettingsMerge,modelSettingsNewModel} from "../src/lib/models/model-settings-view-model.ts";

test('model settings merges only resolved configuration choices and retains a temporary credential only with its original connection',()=>{
 const id='f4a43fd1-4eb3-486f-966d-642b06c008cc',keyA='model-key:65ed7357-e6de-425b-9e3a-1a15850a229f',keyB='model-key:75ed7357-e6de-425b-9e3a-1a15850a229f';
 const base=modelSettingsEmpty();base.models=[{...modelSettingsNewModel(id),displayName:'人工模型',modelId:'model-a',baseUrl:'https://relay-a.invalid/v1',credentialRef:keyA,timeoutSeconds:60,maxOutputTokens:4096}];
 const mine=modelSettingsClone(base),current=modelSettingsClone(base);mine.models[0].displayName='本人名称';current.models[0].timeoutSeconds=120;
 const independent=modelSettingsMerge(base,mine,current);assert.equal(independent.unresolved,0);assert.equal(independent.configuration.models[0].displayName,'本人名称');assert.equal(independent.configuration.models[0].timeoutSeconds,120);
 mine.models[0].timeoutSeconds=140;current.models[0].displayName='当前名称';
 const conflicts=modelSettingsMerge(base,mine,current);assert.equal(conflicts.unresolved,2);assert.equal(modelSettingsMerge(base,mine,current,{['models.'+id+'.displayName']:'mine'}).unresolved,1);
 const resolved=modelSettingsMerge(base,mine,current,{['models.'+id+'.displayName']:'mine',['models.'+id+'.timeoutSeconds']:'current'});assert.equal(resolved.unresolved,0);assert.equal(resolved.configuration.models[0].displayName,'本人名称');assert.equal(resolved.configuration.models[0].timeoutSeconds,120);
 const remote=modelSettingsClone(base);Object.assign(remote.models[0],{apiFormat:'anthropic',modelId:'model-b',baseUrl:'https://relay-b.invalid/v1',credentialRef:keyB});
 const pending=modelSettingsMerge(base,base,remote,{},[id]);assert.equal(pending.unresolved,1);assert.deepEqual(pending.conflicts.map(row=>row.path),['models.'+id+'.connection']);
 const localBinding=modelSettingsMerge(base,base,remote,{['models.'+id+'.connection']:'mine'},[id]);assert.equal(localBinding.unresolved,0);assert.equal(localBinding.configuration.models[0].baseUrl,base.models[0].baseUrl);assert.equal(localBinding.configuration.models[0].credentialRef,keyA);assert.deepEqual(localBinding.discardCredentialIds,[]);
 const remoteBinding=modelSettingsMerge(base,base,remote,{['models.'+id+'.connection']:'current'},[id]);assert.equal(remoteBinding.configuration.models[0].baseUrl,remote.models[0].baseUrl);assert.equal(remoteBinding.configuration.models[0].apiFormat,'anthropic');assert.equal(remoteBinding.configuration.models[0].modelId,'model-b');assert.equal(remoteBinding.configuration.models[0].credentialRef,keyB);assert.deepEqual(remoteBinding.discardCredentialIds,[id]);
 const description=modelSettingsConflictValue(pending.conflicts[0].mine,pending.conflicts[0].path);assert.ok(description.includes('待保存的新凭据'));assert.ok(!description.includes(keyA));
 for(const unknown of [undefined,'********','masked']){const missing=modelSettingsClone(remote);missing.models[0].credentialRef=unknown;assert.equal(modelSettingsMerge(base,mine,missing).configuration,null);}
 const removed=modelSettingsMerge(base,base,modelSettingsEmpty(),{},[id]);assert.equal(removed.unresolved,1);assert.deepEqual(modelSettingsMerge(base,base,modelSettingsEmpty(),{['models.'+id]:'current'},[id]).discardCredentialIds,[id]);
 assert.equal(base.models[0].displayName,'人工模型');assert.equal(remote.models[0].baseUrl,'https://relay-b.invalid/v1');
});
